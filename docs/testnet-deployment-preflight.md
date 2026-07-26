# Testnet Deployment Preflight

Status ini mencatat evidence read-only untuk baseline kontrak
`b132bf4360108db00959fc5aa75009a12283ed69`. Dokumen ini tidak memberi approval untuk broadcast.

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
di repository. Ignored file `sc-etherdoc/.env` juga berpermission `0600` dan memuat public RPC,
pilihan network, target sender `1 LINK`, serta seluruh public role address. File tersebut tidak
memuat private key atau password.

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

## Blocker sebelum approval gate

1. Foundry memerlukan password keystore saat broadcast. Password harus diberikan melalui local
   `--password-file` berpermission `0600`, bukan chat, command argument, Git, atau `.env`.
2. Explorer API key masih diperlukan bila verification dijalankan melalui Etherscan/Mantlescan.
3. Pengguna belum memberi approval eksplisit untuk empat transaksi deployment/configuration/funding.

Tidak ada transaksi testnet yang dibroadcast selama preflight ini.
