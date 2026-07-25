# Testnet Deployment Preflight

Status ini mencatat evidence read-only untuk baseline kontrak
`175b902733794f9466ef73dc97f69a074b4b80c8`. Dokumen ini tidak memberi approval untuk broadcast.

## Quality gate

Dijalankan pada 25 Juli 2026 dengan Foundry `v1.7.1`:

| Gate | Hasil |
| --- | --- |
| `forge fmt --check` | Pass |
| `forge lint --deny warnings src script test` | Pass |
| `forge test -vv` | Pass: 114, fail: 0, skip: 2 fork test tanpa RPC |
| `bash script/check-coverage.sh` | Pass: line, statement, branch, dan function 100% |
| `bash script/check-contract-sizes.sh` | Pass |
| `bash script/check-gas-snapshot.sh` | Pass |
| `bash script/ci-deployment-dry-run.sh` | Pass; sender dan receiver tersimulasi tanpa broadcast |
| `bash script/test-deployment-workflow.sh` | Blocked oleh clean-worktree guard |
| `ALLOW_DIRTY_DEPLOYMENT=1 bash script/test-deployment-workflow.sh` | Pass untuk validasi lokal saja; bukan izin testnet deployment |

Deployment workflow lokal membuktikan deployment sender/receiver, manifest, idempotent rerun, remote
configuration, LINK fund/withdraw target, dan verification workflow. Override dirty hanya dipakai
pada Anvil karena file milik pengguna `sc-etherdoc/soljson-latest.js` tetap untracked. Override
tersebut tidak boleh dipakai untuk deployment testnet.

Optional live fork checks juga dijalankan menggunakan public RPC:

```text
CCIPV2MantleForkTest: pass
CCIPV2InkForkTest: pass
```

Kedua test membuktikan Router saat ini mengenali lane Mantle Sepolia ke Ink Sepolia dan sebaliknya,
serta dapat mengutip fee dengan ExtraArgs v3 full finality.

## Network config validation

| Check | Mantle Sepolia | Ink Sepolia |
| --- | --- | --- |
| Expected/observed chain ID | `5003` / `5003` | `763373` / `763373` |
| Expected selector | `8236463271206331221` | `9763904284804119144` |
| Router | `0xFd33fd627017fEf041445FC19a2B6521C9778f86` has runtime code | `0x17fCda531D8E43B4e2a2A2492FBcd4507a1685A1` has runtime code |
| LINK | `0x22bdEdEa0beBdD7CfFC95bA53826E55afFE9DE04` has runtime code | `0x3423C922911956b1Ccbc2b5d4f38216a6f4299b4` has runtime code |
| Gas limit | `500000` | `500000` |
| Fee/governance mode | `LINK` / `DIRECT` | `LINK` / `DIRECT` |

Runtime implementation tetap harus membaca nilai ini dari generated contract artifact, bukan dari
dokumen.

## Wallet readiness

`cast wallet list` tidak menemukan named Foundry account. `sc-etherdoc/.env` juga belum tersedia.

Backend lama mempunyai satu candidate public address:

```text
0xB34a4eAECB848d573a0410bc305787d5B69328B8
```

Address itu adalah nilai `ADDRESS_ADMIN` sekaligus address yang diturunkan secara lokal dari signer
backend lama. Private key tidak dicetak atau disalin. Sesuai wallet policy, address ini tidak akan
otomatis dipakai untuk deployment atau diberi role apa pun. Pemilik harus mengonfirmasi apakah ia
boleh menjadi backend operator/relayer. Address yang sama tidak direkomendasikan untuk admin dan
operator karena mematahkan pemisahan tanggung jawab.

Read-only balance check:

| Address | Mantle Sepolia native | Ink Sepolia native |
| --- | ---: | ---: |
| `0xB34a4eAECB848d573a0410bc305787d5B69328B8` | `0` wei | `0` wei |

Admin/deployer dan user issuer address belum diketahui, sehingga balance mereka dan ketersediaan
LINK untuk funder belum dapat diperiksa.

## Blocker sebelum approval gate

1. Pemilik perlu menentukan penanganan `sc-etherdoc/soljson-latest.js` agar deployment berasal dari
   worktree yang lolos clean-worktree guard. File belum dibaca, diubah, dipindah, atau dihapus.
2. Named encrypted Foundry admin account belum ada.
3. Public address admin/deployer, backend operator, dan user issuer belum disepakati.
4. Ketiga wallet belum terbukti mempunyai native gas; LINK funder juga belum ditentukan.
5. `sc-etherdoc/.env` perlu diisi RPC/API key dan public role address tanpa private key.

Tidak ada transaksi testnet yang dibroadcast selama preflight ini.
