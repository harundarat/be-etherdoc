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

`cast wallet list` tidak menemukan named Foundry account. `sc-etherdoc/.env` juga belum tersedia.

Pada 25 Juli 2026, backend operator key baru dibuat khusus untuk testnet/dev dan disimpan sebagai
`BACKEND_PRIVATE_KEY` di ignored file `be-etherdoc/.env` dengan permission file `0600`. Private key
tidak dicetak, didokumentasikan, atau dimasukkan ke Git. Public address yang diturunkan darinya:

```text
0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A
```

Address lama `0xB34a4eAECB848d573a0410bc305787d5B69328B8`, yang sebelumnya dipakai sekaligus
sebagai `ADDRESS_ADMIN` dan signer backend, tidak lagi menjadi candidate operator. Admin/deployer
tetap harus menggunakan named encrypted Foundry account yang berbeda, dan user issuer tetap
user-controlled.

Read-only balance check:

| Address                                      | Ethereum native | Mantle native | Ethereum LINK | Mantle LINK |
| -------------------------------------------- | --------------: | ------------: | ------------: | ----------: |
| `0x0f70A38610bbdcE47f6fc7AD6C4b1E5A6C68b62A` |      `0.15` ETH |      `10` MNT |      `7` LINK |         `0` |

Admin/deployer dan user issuer address belum diketahui, sehingga balance mereka belum dapat
diperiksa. Backend operator sudah mempunyai gas pada kedua chain dan `7` LINK pada canonical source;
penggunaan address ini sebagai LINK funder tetap menjadi bagian approval gate.

## Blocker sebelum approval gate

1. Named encrypted Foundry admin account belum ada.
2. Public address admin/deployer dan user issuer belum diketahui.
3. Native gas admin dan user belum dapat diperiksa; operator sudah funded dan tersedia sebagai
   candidate LINK funder.
4. `sc-etherdoc/.env` perlu diisi RPC/API key dan public role address tanpa private key.

Tidak ada transaksi testnet yang dibroadcast selama preflight ini.
