# Testnet Deployment and Receipt Record

Dokumen ini mencatat preflight, approval eksplisit pengguna, hasil deployment baseline kontrak
`b132bf4360108db00959fc5aa75009a12283ed69`, lifecycle smoke test, dan final reconciliation pada
26 Juli 2026.

## Quality gate

Dijalankan pada 26 Juli 2026 dengan Foundry `v1.7.1`:

| Gate                                         | Hasil                                                 |
| -------------------------------------------- | ----------------------------------------------------- |
| `forge fmt --check`                          | Pass                                                  |
| `forge lint --deny warnings src script test` | Pass                                                  |
| `forge test -vv`                             | Pass: 112, fail: 0, skip: 2 fork test tanpa RPC       |
| `bash script/check-coverage.sh`              | Pass: line, statement, branch, dan function 100%      |
| `bash script/check-contract-sizes.sh`        | Pass                                                  |
| `bash script/check-gas-snapshot.sh`          | Pass                                                  |
| `bash script/ci-deployment-dry-run.sh`       | Pass; sender dan receiver tersimulasi tanpa broadcast |
| `bash script/test-deployment-workflow.sh`    | Pass dari worktree bersih pada exact commit           |

Deployment workflow lokal membuktikan deployment sender/receiver, manifest, idempotent rerun, remote
configuration, LINK fund/withdraw target, dan verification workflow. File untracked lama
`sc-etherdoc/soljson-latest.js` dihapus setelah persetujuan eksplisit pemilik. Exact gate kemudian
lulus tanpa dirty-worktree override.

Optional live fork checks juga dijalankan menggunakan public RPC:

```text
CCIPV2EthereumForkTest: pass
CCIPV2MantleForkTest: pass
```

Kedua test membuktikan Router saat ini mengenali lane Ethereum Sepolia ke Mantle Sepolia dan
sebaliknya, serta dapat mengutip fee dengan ExtraArgs v3 full finality.

## Network config validation

| Check                      | Ethereum Sepolia                                              | Mantle Sepolia                                                |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Expected/observed chain ID | `11155111` / `11155111`                                       | `5003` / `5003`                                               |
| Expected selector          | `16015286601757825753`                                        | `8236463271206331221`                                         |
| Router                     | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` has runtime code | `0xFd33fd627017fEf041445FC19a2B6521C9778f86` has runtime code |
| LINK                       | `0x779877A7B0D9E8603169DdbD7836e478b4624789` has runtime code | `0x22bdEdEa0beBdD7CfFC95bA53826E55afFE9DE04` has runtime code |
| Gas limit                  | `500000`                                                      | `500000`                                                      |
| Fee/governance mode        | `LINK` / `DIRECT`                                             | `LINK` / `DIRECT`                                             |

Runtime implementation tetap harus membaca nilai ini dari generated contract artifact, bukan dari
dokumen.

## Wallet readiness

Named encrypted Foundry keystore `etherdoc-admin` tersedia dengan permission `0600`. Pemilik
mengonfirmasi public address keystore sebagai
`0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F`; password dan ciphertext tidak dicetak atau disimpan
di repository. Local password file berpermission `0600` berhasil mendekripsi keystore ke public
address tersebut tanpa menampilkan secret. Ignored file `sc-etherdoc/.env` juga berpermission `0600`
dan memuat public RPC, pilihan network, target sender `1 LINK`, serta seluruh public role address.
File tersebut tidak memuat private key atau password.

Pada 25 Juli 2026, backend operator key baru dibuat khusus untuk testnet/dev dan disimpan sebagai
`BACKEND_PRIVATE_KEY` di ignored file `be-etherdoc/.env` dengan permission file `0600`. Private key
tidak dicetak, didokumentasikan, atau dimasukkan ke Git. Public address yang diturunkan darinya:

```text
0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A
```

Address lama `0xB34a4eAECB848d573a0410bc305787d5B69328B8`, yang sebelumnya dipakai sekaligus
sebagai `ADDRESS_ADMIN` dan signer backend, sekarang secara eksplisit ditetapkan pemilik sebagai
user test issuer. Address ini tidak dipakai sebagai admin atau backend operator.

| Identity | Public address                               | Assignment                                             |
| -------- | -------------------------------------------- | ------------------------------------------------------ |
| Admin    | `0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F` | deployer, `GOVERNANCE`, `PAUSER`, one-time LINK funder |
| Backend  | `0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A` | `OPERATOR`, relayer                                    |
| User     | `0xB34a4eAECB848d573a0410bc305787d5B69328B8` | `INITIAL_ISSUER`, lifecycle signer                     |

Read-only balance check:

| Address                                      | Ethereum native | Mantle native |   Ethereum LINK | Mantle LINK |
| -------------------------------------------- | --------------: | ------------: | --------------: | ----------: |
| `0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F` |       `0.1` ETH |       `3` MNT |        `7` LINK |         `0` |
| `0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A` |      `0.15` ETH |  `6.9971` MNT |        `7` LINK |         `0` |
| `0xB34a4eAECB848d573a0410bc305787d5B69328B8` |    `0.1095` ETH |       `0` MNT | `283.1723` LINK |         `0` |

Admin mempunyai native balance lebih dari estimasi deployment di kedua chain. User issuer
mempunyai source gas untuk direct lifecycle smoke test. Backend operator mempunyai source gas untuk
dispatch. Admin dipilih sebagai one-time LINK funder agar seluruh deployment command menggunakan
keystore terenkripsi yang sama; operator tetap tidak memegang governance authority.

## Live no-broadcast estimates

Simulasi final terhadap RPC live dilakukan tanpa `--broadcast`, menggunakan seluruh role address
yang telah disetujui:

| Operasi                         | Network          | Estimated gas | Estimasi native pada gas price observasi |
| ------------------------------- | ---------------- | ------------: | ---------------------------------------: |
| Deploy `EtherdocSender`         | Ethereum Sepolia |   `5,856,532` |                            `0.01371` ETH |
| Deploy `EtherdocReceiver`       | Mantle Sepolia   |   `3,480,119` |                            `0.34802` MNT |
| Configure sender remote (Anvil) | Ethereum Sepolia |      `72,143` |                      gas price dependent |

Quote Router Ethereum Sepolia untuk satu payload schema v3, destination gas limit `500000`, adalah
`0.057004147051697975 LINK` pada saat preflight. Smoke lifecycle aktif, superseded, replacement, dan
revoked membutuhkan empat dispatch, atau sekitar `0.22802 LINK` bila quote tidak berubah. Target
balance sender `1 LINK` memberi buffer lebih dari empat kali estimasi tersebut; admin mempunyai
`7 LINK`.

Rencana deployment menghasilkan empat transaksi bila semua state masih kosong:

1. admin deploy sender di Ethereum Sepolia;
2. admin deploy receiver di Mantle Sepolia;
3. admin mengonfigurasi remote Mantle pada sender;
4. admin/funder mentransfer deficit hingga sender memiliki `1 LINK`.

Receiver trusted sender sudah dibentuk di constructor, sehingga reconciliation receiver seharusnya
no-op. Verifikasi explorer bukan transaksi EVM. Dengan buffer, minimum readiness yang disarankan
adalah admin `0.02 ETH` dan `0.5 MNT`; saldo admin, operator, dan user saat ini memadai.

Nonce admin adalah `0` pada kedua chain saat simulasi. Jika nonce tidak berubah sebelum broadcast,
sender dan receiver diprediksi sama-sama berada di
`0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7`; chain ID tetap membedakan kedua deployment.

## Frozen approval plan

Constructor sender Ethereum Sepolia:

```text
router        = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59
LINK          = 0x779877A7B0D9E8603169DdbD7836e478b4624789
governance    = 0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F
initialIssuer = 0xB34a4eAECB848d573a0410bc305787d5B69328B8
operator      = 0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A
pauser        = 0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F
```

Constructor receiver Mantle Sepolia:

```text
router              = 0xFd33fd627017fEf041445FC19a2B6521C9778f86
governance          = 0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F
pauser              = 0x6AeFe6b1253E04f61f8378D41d6790AA46e07c8F
sourceChainSelector = 16015286601757825753
sourceChainId       = 11155111
trustedSender       = actual deployed Ethereum sender
```

Setelah password file lokal tersedia, exact broadcast commands adalah:

```bash
cd /home/harundarat/Projects/Etherdoc/sc-etherdoc
source .env
wallet=(
  --keystore "$HOME/.foundry/keystores/etherdoc-admin"
  --password-file "$HOME/.foundry/keystores/etherdoc-admin.password"
)

NETWORK=ethereumSepolia RPC_URL="$ETHEREUM_SEPOLIA_RPC_URL" \
  bash script/deploy-contract.sh sender "${wallet[@]}"

NETWORK=mantleSepolia SOURCE_NETWORK=ethereumSepolia RPC_URL="$MANTLE_SEPOLIA_RPC_URL" \
  bash script/deploy-contract.sh receiver "${wallet[@]}"

SOURCE_NETWORK=ethereumSepolia DESTINATION_NETWORK=mantleSepolia CONFIGURE_TARGET=RECEIVER \
  forge script script/ConfigureEtherdocRemotes.s.sol:ConfigureEtherdocRemotesScript \
    --rpc-url mantle_sepolia --broadcast "${wallet[@]}"

SOURCE_NETWORK=ethereumSepolia DESTINATION_NETWORK=mantleSepolia CONFIGURE_TARGET=SENDER \
  forge script script/ConfigureEtherdocRemotes.s.sol:ConfigureEtherdocRemotesScript \
    --rpc-url ethereum_sepolia --broadcast "${wallet[@]}"

NETWORK=ethereumSepolia TREASURY_ACTION=FUND TARGET_LINK_BALANCE=1000000000000000000 \
  forge script script/ManageEtherdocTreasury.s.sol:ManageEtherdocTreasuryScript \
    --rpc-url ethereum_sepolia --broadcast "${wallet[@]}"
```

Receiver reconciliation diperkirakan no-op, sehingga rangkaian tersebut menghasilkan empat
transaksi EVM. Wrapper deployment akan menghentikan proses bila nonce/predicted address, chain ID,
runtime code, receipt, atau manifest tidak dapat direkonsiliasi. Setiap langkah harus dijalankan
berurutan dan dihentikan bila satu langkah gagal.

## Execution record

Pengguna memberi approval eksplisit untuk empat transaksi deployment/configuration/funding. Tidak
ada lifecycle smoke-test transaction yang termasuk dalam approval tersebut.

| Operasi                 | Network          | Transaction                                                          |      Block |  Gas used |
| ----------------------- | ---------------- | -------------------------------------------------------------------- | ---------: | --------: |
| Deploy sender           | Ethereum Sepolia | `0x3a24898943d7daccab82e3148e160bbaa19d4eb9811439634d77b11da66acfee` | `11354109` | `4506411` |
| Deploy receiver         | Mantle Sepolia   | `0x68c4cd2052ca66ae21d5b084ac197aee9f93619c42349cc931af2221f7913e9f` | `41758817` | `2654778` |
| Configure sender remote | Ethereum Sepolia | `0x1d37923ea18c71bac9a23731641e584e9e3be952a0ae537c7ac45afab18ed691` | `11354119` |   `49413` |
| Fund sender to `1 LINK` | Ethereum Sepolia | `0x1066aaeb7aaf84ef0faebbb8b8c7560abe09a70f1e784f80e21b06f6aba7a709` | `11354123` |   `51658` |

All receipts have status `1`. The deployed contracts are:

| Role     | Network          | Address                                      | Runtime code hash                                                    |
| -------- | ---------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Sender   | Ethereum Sepolia | `0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7` | `0x7fdd145e13ac74986afae4df105d091429fa4342b237df13133c6e6d2dcb339e` |
| Receiver | Mantle Sepolia   | `0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7` | `0xf6d7a933eb65676f6ec3bc6d6eb50307f58994649157f010a675646f2f518531` |

Post-deployment reconciliation proves:

- live bytecode hashes equal the manifests;
- owner, issuer, operator, and pauser match the frozen constructor plan;
- receiver trusts selector `16015286601757825753` and the deployed sender;
- sender remote points to selector `8236463271206331221`, the deployed receiver, gas `500000`, and
  is allowlisted;
- receiver reconciliation is an on-chain no-op;
- sender balance is exactly `1 LINK`;
- manifests record clean Git commit `b132bf4360108db00959fc5aa75009a12283ed69`.

Verification:

- sender: Sourcify `exact_match` job `d0c6759c-e026-4743-9c55-ba947a67f426` and Etherscan verified;
- receiver: Sourcify `exact_match` job `85b1670c-e8e0-4512-87ee-b92f104f99ff`.

The backend generated registry imports both manifests, addresses, deployment blocks, constructor
arguments, transaction hashes, and runtime code hashes.

## Lifecycle smoke-test record

Pengguna memberi approval eksplisit terpisah untuk tujuh transaksi lifecycle. Encrypted issuer
keystore `etherdoc-issuer` dan password file lokalnya tetap berpermission `0600`; decryption lokal
sesuai dengan issuer yang disetujui tanpa menulis atau mencetak raw private key.

Dokumen original:
`0x2ef389af5cdb74f89cbe9bb002a34ab600d92dd8ab508c6d1723493aaaa00195`.
Dokumen replacement:
`0xaa7c2056a8e13ab03401fabbe3a165941dc40aefed9305abffefb3c99507b4eb`.

| Operasi                      | Source transaction                                                   |    Block |
| ---------------------------- | -------------------------------------------------------------------- | -------: |
| Register original            | `0xd51b6d9ac82e5811daca16359c7974d8138ac419a3d364c4ac3e020b685c10d6` | 11354227 |
| Dispatch original active     | `0x7c17ea6eaccb6924de81fa707fc527fb098c323c0b379b5799af1b1972b931aa` | 11354228 |
| Supersede original           | `0x798f10125e05b93fceade0430500bafaf18ec96566c392dfd4ffbd716d27aed9` | 11354311 |
| Dispatch original superseded | `0x0a6720a52acb60fa5d42e9b354ae14121e97d837ffebfe8eb0d539c8304cd399` | 11354312 |
| Dispatch replacement active  | `0x7b4fecfd098026f24820cf32c9c1de9703c1247294930f6123edc891e0a811a5` | 11354399 |
| Revoke replacement           | `0x462de96b12c15c0c792af37a1a667d4aa5061f6e073b8e89440fd3dc72fc2912` | 11354488 |
| Dispatch replacement revoked | `0x614ace2c23c0f3ca926233a980777434ba06ff93309c5b582b05ab55823de75d` | 11354489 |

Ketujuh receipt berstatus `1`. Empat dispatch menghasilkan CCIP delivery berikut:

| Lifecycle snapshot  | CCIP message ID                                                      | Destination transaction                                              | Mantle block |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | -----------: |
| Original active     | `0x86abfa7d6fd6a480236c101211240d96510fbf045d4aa671703009434f9f0a79` | `0x188bc76b50948a3451b29bad42af87a236cb2c1d916e7bd33f55014faaacfc4b` |     41760075 |
| Original superseded | `0x1a02c25bedc2a141e236d561a3edc85bde0de698ef9be15fa8c58a99227404b8` | `0x00e9bab36b0735dcceb64a884f19c31dbe11fc5ff566e248080c0c6f383391e9` |     41760650 |
| Replacement active  | `0xa6ee707416c3c4d7f2b8a1b8b0d2c699e34b1ee26c36a6e4d0ec52797284f8cf` | `0x2e222533dc580c6992092aa57c4e1ec4c4f38a9102e848c74a1d3c626d5020db` |     41761233 |
| Replacement revoked | `0x4ae1e08e5a78983c2a1003788b90a03bc84d7314c278ac788490e60aba0231ad` | `0xb46eda744d5028d07320941e52e4fe2f73a96628d9668b904e3609ddc78e038a` |     41761801 |

Semua message mencapai status CCIP `Success` dan masing-masing menghasilkan tepat satu
`MessageReceived`. Final source dan destination state cocok: original version `2` berstatus
`SUPERSEDED`, replacement version `2` berstatus `REVOKED`, integrity check berhasil, dan keduanya
tidak dilaporkan active. Saldo sender setelah empat dispatch adalah
`0.771994783715452157 LINK`.

## Final backend reconciliation

Backend dibangun dan dijalankan terhadap PostgreSQL 16 kosong menggunakan live deployment registry.
Indexer memulai dari kedua deployment block dan mencapai finalized head. Karena endpoint Ethereum
yang semula dikonfigurasi menolak historical `eth_getLogs` tanpa token, audit read-only memakai
endpoint Sepolia alternatif yang mendukung historical logs; tidak ada transaksi tambahan.

Hasil projection:

- 12 canonical events: 2 `DocumentRegistered`, 2 `DocumentStatusChanged`, 4 `MessageSent`, dan
  4 `MessageReceived`;
- 2 document projections dengan final lifecycle `SUPERSEDED` dan `REVOKED`;
- 4 dispatch berstatus `DESTINATION_CONFIRMED`, lengkap dengan source/destination block evidence;
- 4 `TRACK_DESTINATION` job selesai, tanpa failed dispatch atau READY backlog;
- `pnpm reconcile` melaporkan nol source unknown, recovery dispatch, dan destination tracking;
- dua kali `pnpm reconcile --enqueue` masing-masing membuat nol job, membuktikan idempotensi akhir.

Lifecycle smoke test dan final reconciliation selesai tanpa release blocker yang tersisa.
