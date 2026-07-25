# TODO Sinkronisasi Backend dan Smart Contract Etherdoc

## Tujuan

Menyelaraskan `be-etherdoc` dengan `sc-etherdoc` terbaru dengan smart contract sebagai **source of
truth** untuk ABI, network, contract address, document identity, lifecycle, EIP-712, event, dan
status CCIP.

Dokumen ini disusun sebagai backlog berurutan untuk long-running Codex task. Kerjakan task sesuai
urutan karena task berikutnya bergantung pada artefak dan keputusan task sebelumnya.

## Kondisi Awal yang Diketahui

- Backend masih menggunakan Holešky dan Base Sepolia.
- Backend masih memanggil API kontrak lama seperti `addDocument()` dan `documentExists(string)`.
- Backend menyimpan ABI dan contract address lama secara manual.
- Smart contract terbaru menggunakan:
  - `EtherdocSender` pada canonical source chain;
  - `EtherdocReceiver` pada destination chain;
  - Mantle Sepolia sebagai source;
  - Ink Sepolia sebagai destination;
  - CCIP payload schema v3;
  - EIP-712 domain `Etherdoc` version `2`;
  - `documentId = keccak256(abi.encode(issuer, contentDigest))`;
  - lifecycle `ACTIVE`, `REVOKED`, dan `SUPERSEDED`;
  - register, revoke, dan supersede melalui direct call atau signature.
- Kontrak terbaru belum dideploy ke testnet.
- `sc-etherdoc/deployments/testnet` belum memiliki manifest deployment.
- `sc-etherdoc` memiliki file untracked `soljson-latest.js`; jangan hapus atau ubah tanpa
  persetujuan pemilik.

## Prinsip dan Batasan

- [x] Perlakukan `sc-etherdoc` sebagai source of truth tunggal.
- [x] Jangan mengubah smart contract untuk mempertahankan kompatibilitas dengan backend stale.
- [ ] Jangan memakai ABI, chain selector, atau contract address hardcoded dari backend lama.
- [x] Jangan membaca, mencetak, memindahkan, atau menyimpan private key pengguna.
- [x] Jangan otomatis memakai private key dari `be-etherdoc/.env` untuk deployment.
- [x] Jangan broadcast transaksi testnet sebelum approval gate pada Task 3 terpenuhi.
- [x] Bedakan source transaction confirmation dengan destination CCIP confirmation.
- [ ] Perlakukan database backend sebagai projection/cache yang dapat direkonsiliasi dari chain.
- [ ] API lama boleh diganti secara breaking; compatibility adapter dan `/v2` tidak diperlukan.
- [ ] Mainnet dan destination tambahan berada di luar scope rilis ini.

## Target Network

| Peran | Network | Chain ID | CCIP selector |
| --- | --- | ---: | ---: |
| Canonical source | Mantle Sepolia | `5003` | `8236463271206331221` |
| Destination | Ink Sepolia | `763373` | `9763904284804119144` |

Nilai router, LINK token, gas limit, dan explorer harus dibaca dari
`sc-etherdoc/config/networks/testnet.json`, bukan disalin ke business logic backend.

## Kebijakan Wallet dan Secret

Gunakan tiga identitas wallet:

| Identitas | Tanggung jawab | Penyimpanan secret |
| --- | --- | --- |
| Admin wallet | Deployer, `GOVERNANCE`, dan `PAUSER` | Encrypted Foundry keystore atau hardware wallet |
| Backend wallet | `OPERATOR` dan relayer transaksi `*BySig` | Runtime secret/secret manager backend |
| User wallet | `INITIAL_ISSUER` testnet dan issuer dokumen | Hanya dikuasai pengguna |

Aturan operasional:

- Admin wallet dipanggil dengan named Foundry account, misalnya `--account etherdoc-admin`.
- `GOVERNANCE` dan `PAUSER` berisi public address admin wallet.
- `OPERATOR` berisi public address backend wallet.
- `INITIAL_ISSUER` berisi public address user test wallet.
- `sc-etherdoc/.env` hanya boleh menyimpan RPC, explorer API key, public role address, dan pilihan
  network. Jangan simpan private key di file ini.
- Wallet lama dalam `be-etherdoc/.env` hanya boleh dipakai sebagai backend operator/relayer jika
  pemilik secara eksplisit mengonfirmasi address dan perannya.
- Pada production-like environment, backend signer secret harus berasal dari secret manager atau
  managed signer. Plaintext private key hanya boleh dipakai pada development/testnet lokal yang
  terkontrol.

## Target API

Endpoint utama yang dituju:

- `POST /auth/nonce`
- `POST /auth/verify`
- `POST /documents/intents/register`
- `POST /documents/intents/revoke`
- `POST /documents/intents/supersede`
- `POST /documents/intents/:intentId/signature`
- `GET /documents/intents/:intentId`
- `GET /documents/:documentId`
- `POST /documents/search`

Status intent minimum:

- `PREPARED`
- `SIGNED`
- `SOURCE_PENDING`
- `SOURCE_CONFIRMED`
- `FAILED_RETRYABLE`
- `FAILED_TERMINAL`

Status dispatch per destination:

- `PENDING`
- `SOURCE_ACCEPTED`
- `DESTINATION_CONFIRMED`
- `DESTINATION_IGNORED`
- `RECOVERY_REQUIRED`

---

## Task 1 — Bekukan Baseline Smart Contract

### TODO

- [x] Catat commit SHA `sc-etherdoc` yang menjadi baseline integrasi.
- [x] Jalankan `forge build` dan `forge test`.
- [x] Buat compatibility matrix yang memuat:
  - public/external function sender dan receiver;
  - struct dan enum;
  - event dan custom error;
  - CCIP payload schema v3;
  - EIP-712 type untuk register, revoke, dan supersede;
  - document lifecycle dan versioning;
  - source/destination chain;
  - role dan pause authority.
- [x] Catat seluruh integrasi stale pada backend:
  - Holešky;
  - Base Sepolia;
  - `addDocument`;
  - `documentExists(string)`;
  - address lama;
  - ABI manual lama;
  - identity yang hanya memakai CID.
- [x] Dokumentasikan bahwa CID bukan canonical document identity.

### Kriteria Keberhasilan

- [x] Compatibility matrix cocok dengan Solidity source dan ABI hasil kompilasi.
- [x] Commit baseline tercatat dan dapat direproduksi.
- [x] Seluruh call site backend yang stale sudah terinventarisasi.
- [x] Smart contract build dan test lulus tanpa perubahan behavior untuk mengakomodasi backend lama.

---

## Task 2 — Validasi Kontrak dan Persiapan Deployment

### TODO

- [x] Jalankan toolchain Foundry sesuai `.foundry-version`.
- [ ] Jalankan:
  - [x] `forge fmt --check`;
  - [x] `forge lint --deny warnings src script test`;
  - [x] `forge test -vv`;
  - [x] `bash script/check-coverage.sh`;
  - [x] `bash script/check-contract-sizes.sh`;
  - [x] `bash script/check-gas-snapshot.sh`;
  - [x] `bash script/ci-deployment-dry-run.sh`;
  - [ ] `bash script/test-deployment-workflow.sh` (logic lulus dengan
    `ALLOW_DIRTY_DEPLOYMENT=1`, tetapi exact gate menolak `soljson-latest.js` yang untracked).
- [ ] Pastikan worktree bersih dan exact source sudah committed.
- [x] Jangan menghapus `soljson-latest.js`; minta arahan pemilik bila file tersebut menghalangi
  clean-worktree deployment.
- [ ] Buat atau import encrypted Foundry account untuk admin wallet.
- [ ] Catat public address admin wallet tanpa mengekspor private key.
- [ ] Tentukan public address backend operator/relayer.
- [ ] Tentukan public address user test wallet.
- [ ] Periksa native token balance ketiga wallet.
- [ ] Periksa ketersediaan LINK untuk mendanai sender.
- [x] Validasi router, LINK token, chain ID, selector, gas limit, dan governance mode dari network
  config.

### Kriteria Keberhasilan

- [ ] Seluruh quality gate kontrak lulus.
- [ ] Deployment dapat dikaitkan dengan clean commit tertentu.
- [ ] Admin, backend, dan user wallet mempunyai address yang telah diketahui dan tidak tertukar.
- [ ] Tidak ada private key atau mnemonic pada Git, log, dokumentasi, atau command history.
- [ ] Tidak ada placeholder constructor argument yang belum diputuskan.

---

## Task 3 — Approval Gate dan Deployment Testnet

### Approval Gate

Sebelum broadcast, tampilkan kepada pengguna:

- [ ] source/destination chain dan chain ID;
- [ ] deployer address;
- [ ] `GOVERNANCE` address;
- [ ] `INITIAL_ISSUER` address;
- [ ] `OPERATOR` address;
- [ ] `PAUSER` address;
- [ ] router dan LINK token address;
- [ ] receiver source selector dan source chain ID;
- [ ] seluruh constructor arguments;
- [ ] native gas balance;
- [ ] LINK funding target;
- [ ] estimasi jumlah transaksi dan gas;
- [ ] command deployment yang akan dijalankan.

Kemudian:

- [ ] Minta persetujuan eksplisit pengguna untuk broadcast ke Mantle Sepolia dan Ink Sepolia.
- [ ] Jangan melanjutkan deployment bila approval belum diberikan.
- [ ] Jangan menampilkan private key saat meminta approval.

### Deployment TODO

- [ ] Deploy `EtherdocSender` ke Mantle Sepolia menggunakan encrypted admin Foundry account.
- [ ] Isi constructor sender dengan:
  - governance = admin wallet;
  - initial issuer = user test wallet;
  - operator = backend wallet;
  - pauser = admin wallet.
- [ ] Deploy `EtherdocReceiver` ke Ink Sepolia menggunakan encrypted admin Foundry account.
- [ ] Bind receiver ke source selector, source chain ID, dan sender address Mantle.
- [ ] Konfigurasikan remote Ink pada sender.
- [ ] Rekonsiliasi trusted sender pada receiver.
- [ ] Fund sender dengan LINK menggunakan target-balance workflow.
- [ ] Verifikasi source code sender dan receiver di explorer.
- [ ] Simpan deployment address dan manifest yang memuat:
  - contract address;
  - creation transaction hash;
  - deployer;
  - block number/hash/timestamp;
  - constructor arguments;
  - runtime code hash;
  - compiler/EVM settings;
  - Git commit.
- [ ] Jalankan testnet E2E untuk register, dispatch, receive, verify, revoke, supersede, dan dispatch
  lifecycle version berikutnya.

### Kriteria Keberhasilan

- [ ] Sender dan receiver mempunyai live runtime bytecode yang sesuai artifact.
- [ ] Owner dan role on-chain cocok dengan address yang disetujui.
- [ ] `getRemoteConfig()` dan `isTrustedRemote()` saling konsisten.
- [ ] Sender memiliki LINK dan operator memiliki native gas yang cukup.
- [ ] Manifest deployment lengkap tersedia.
- [ ] E2E menghasilkan `DocumentRegistered`, `MessageSent`, dan `MessageReceived`.
- [ ] `verifyDocument()` berhasil pada source dan destination.
- [ ] Deployment dapat diaudit tanpa mengetahui private key.

---

## Task 4 — Jadikan Artefak Kontrak sebagai Source of Truth Backend

### TODO

- [x] Buat export deterministik dari `sc-etherdoc` untuk:
  - sender ABI;
  - receiver ABI;
  - deployment registry;
  - chain ID dan selector;
  - payload schema version;
  - EIP-712 domain version;
  - contract commit SHA.
- [x] Import artefak generated ke backend.
- [x] Simpan checksum atau provenance metadata.
- [x] Tambahkan CI drift check antara artifact kontrak dan backend.
- [ ] Hapus ABI TypeScript lama setelah call site berhasil dipindahkan.
- [ ] Larang address/selector hardcoded dalam service backend.

### Kriteria Keberhasilan

- [ ] Backend build menggunakan ABI dari commit kontrak yang tercatat pada manifest.
- [ ] Backend membaca contract address dari deployment registry atau validated environment override.
- [x] CI gagal jika ABI, schema, network, atau deployment registry stale.
- [ ] Pencarian source backend tidak menemukan fungsi/address/network lama pada active code.

---

## Task 5 — Typed Configuration dan Blockchain Client

### TODO

- [ ] Buat typed configuration untuk:
  - PostgreSQL;
  - Pinata;
  - Mantle Sepolia RPC;
  - Ink Sepolia RPC;
  - sender/receiver address;
  - confirmation depth;
  - timeout;
  - backend signer;
  - SIWE domain/URI;
  - JWT.
- [ ] Validasi semua konfigurasi saat bootstrap.
- [ ] Buat client terpisah untuk:
  - source reads;
  - destination reads;
  - relayer submission;
  - operator dispatch.
- [ ] Verifikasi chain ID dari setiap RPC.
- [ ] Verifikasi runtime bytecode pada address manifest.
- [ ] Verifikasi backend signer mempunyai operator role.
- [ ] Bedakan not-found, revert, RPC unavailable, timeout, dan chain mismatch.

### Kriteria Keberhasilan

- [ ] Aplikasi gagal saat startup jika konfigurasi penting invalid.
- [ ] Backend signer address sama dengan operator on-chain.
- [ ] Readiness mendeteksi RPC chain atau bytecode yang salah.
- [ ] RPC error tidak pernah diubah menjadi `false` atau document-not-found.
- [ ] Tidak ada address, selector, atau RPC stale di `DocumentsService`.

---

## Task 6 — Canonical File, CID, dan Metadata Pipeline

### TODO

- [ ] Hitung SHA-256 dari byte file persis seperti yang diunggah.
- [ ] Gunakan CIDv1 lowercase unpadded base32.
- [ ] Batasi codec pada `raw` atau `dag-pb` dengan multihash SHA2-256.
- [ ] Parse CID menjadi `cidCodec` dan `cidDigest`.
- [ ] Untuk raw CID, pastikan `cidDigest == contentDigest`.
- [ ] Gunakan CID aktual hasil upload Pinata.
- [ ] Ambil kembali byte melalui storage dan verifikasi digest-nya.
- [ ] Bentuk metadata commitment dari JSON kanonis berversi.
- [ ] Sort object keys secara deterministik.
- [ ] Batasi metadata pada field yang disetujui dan non-PII.
- [ ] Simpan metadata preimage off-chain.
- [ ] Tolak mismatch sebelum membuat EIP-712 intent.

### Kriteria Keberhasilan

- [ ] Test vector backend menghasilkan digest/CID/commitment yang deterministik.
- [ ] Output diterima canonical digest getter smart contract.
- [ ] Perubahan satu byte file menghasilkan content digest berbeda.
- [ ] Perubahan metadata menghasilkan metadata commitment berbeda.
- [ ] Backend tidak membuat signable intent jika Pinata dan perhitungan lokal berbeda.

---

## Task 7 — PostgreSQL, State Machine, dan Transactional Outbox

### TODO

- [ ] Tambahkan migration untuk:
  - authentication nonce;
  - document intent;
  - pinned artifact;
  - signature;
  - source transaction;
  - document projection;
  - dispatch;
  - processed chain event;
  - chain cursor;
  - outbox job.
- [ ] Gunakan UUID sebagai internal intent ID.
- [ ] Gunakan `documentId` sebagai protocol identity.
- [ ] Terapkan unique constraint untuk:
  - idempotency key;
  - issuer + nonce;
  - transaction hash;
  - CCIP message ID;
  - document ID + version + destination selector.
- [ ] Simpan transaction intent sebelum broadcast.
- [ ] Claim outbox job menggunakan transaction dan `FOR UPDATE SKIP LOCKED`.
- [ ] Terapkan bounded exponential backoff untuk retry yang aman.
- [ ] Jangan blind-retry transaksi yang mungkin sudah broadcast.
- [ ] Buat projection yang dapat dibangun ulang dari chain.

### Kriteria Keberhasilan

- [ ] Restart pada setiap state tidak kehilangan intent.
- [ ] Dua worker tidak memproses job yang sama.
- [ ] Idempotency key yang sama tidak menghasilkan transaksi baru.
- [ ] Concurrent request tidak memakai issuer nonce yang sama.
- [ ] Projection stale dapat diperbaiki oleh reconciliation.

---

## Task 8 — SIWE Authentication dan EIP-712 Intent

### TODO

- [ ] Ganti authentication nonce global dengan nonce per-wallet yang atomic, expiring, dan
  sekali pakai.
- [ ] Implementasikan SIWE/EIP-4361 yang mengikat:
  - address;
  - domain;
  - URI;
  - source chain ID;
  - issued-at;
  - expiration;
  - nonce.
- [ ] Isi JWT subject dengan wallet address.
- [ ] Verifikasi JWT subject sama dengan issuer intent.
- [ ] Periksa `isIssuerAuthorized()` sebelum menghasilkan intent.
- [ ] Ambil `issuerNonce()` dari source contract.
- [ ] Bentuk EIP-712 domain `Etherdoc`, version `2`, Mantle chain ID, dan sender address.
- [ ] Bentuk typed data sesuai operasi:
  - `RegisterDocument`;
  - `RevokeDocument`;
  - `SupersedeDocument`.
- [ ] Pada revoke/supersede, ambil current version dari source chain.
- [ ] Verifikasi signature sebelum enqueue.
- [ ] Dukung EOA dan ERC-1271 sesuai kemampuan kontrak.
- [ ] Batasi satu signed pending operation per issuer nonce.
- [ ] Gunakan `202 Accepted` setelah signature diterima.

### Kriteria Keberhasilan

- [ ] Backend tidak pernah menerima user private key.
- [ ] Signature wrong-chain, wrong-contract, wrong-version, expired, replayed, atau milik issuer lain
  ditolak.
- [ ] EOA dan ERC-1271 valid dapat melewati flow.
- [ ] Register/revoke/supersede menghasilkan digest yang sama dengan getter kontrak.
- [ ] API tidak menganggap penerimaan signature atau tx hash sebagai final success.

---

## Task 9 — Breaking Documents API

### TODO

- [ ] Implementasikan `POST /documents/intents/register`.
- [ ] Implementasikan `POST /documents/intents/revoke`.
- [ ] Implementasikan `POST /documents/intents/supersede`.
- [ ] Implementasikan `POST /documents/intents/:intentId/signature`.
- [ ] Implementasikan `GET /documents/intents/:intentId`.
- [ ] Implementasikan `GET /documents/:documentId`.
- [ ] Ubah `POST /documents/search` agar menerima file plus issuer atau explicit document ID.
- [ ] Hapus upload flow lama yang langsung memanggil `addDocument`.
- [ ] Jangan gunakan CID sebagai satu-satunya document identity.
- [ ] Pertahankan Pinata list/group hanya sebagai storage metadata API.
- [ ] Perbaiki route precedence `/documents/groups` dan `/:documentId`.

### Kriteria Keberhasilan

- [ ] API menggunakan `documentId`, issuer, digest, version, dan lifecycle kontrak terbaru.
- [ ] Tidak ada response `isExistEthereum` atau `isExistBase`.
- [ ] Response membedakan integrity, active status, storage availability, source confirmation, dan
  destination replication.
- [ ] Route statis tidak tertangkap dynamic document route.

---

## Task 10 — Source Transaction dan Dispatch Worker

### TODO

- [ ] Simulasikan contract call sebelum broadcast.
- [ ] Submit `registerDocumentBySig`, `revokeDocumentBySig`, atau `supersedeDocumentBySig`.
- [ ] Tunggu configured source confirmation depth.
- [ ] Validasi receipt status dan canonical event.
- [ ] Perlakukan duplicate sebagai idempotent hanya jika seluruh canonical record cocok.
- [ ] Setelah source confirmed, panggil `quoteFee(documentId, selector)`.
- [ ] Terapkan policy `maximumFee` dengan bounded quote buffer.
- [ ] Dispatch melalui backend operator wallet.
- [ ] Parse `MessageSent`.
- [ ] Simpan message ID, tx/block evidence, receiver, version, gas limit, dan fee.
- [ ] Jangan dispatch ulang document version yang sudah memiliki dispatch record.
- [ ] Tangani nonce concurrency backend signer.

### Kriteria Keberhasilan

- [ ] State menjadi `SOURCE_CONFIRMED` hanya setelah receipt dan event valid.
- [ ] Dispatch hanya berjalan untuk canonical record/version yang ada.
- [ ] Concurrent request tidak membuat register atau dispatch ganda.
- [ ] Fee race, insufficient LINK, pause, RPC failure, dan unauthorized role menghasilkan status
  yang benar.

---

## Task 11 — Destination Tracking dan Reconciliation

### TODO

- [ ] Index sender event mulai dari sender deployment block.
- [ ] Index receiver event mulai dari receiver deployment block.
- [ ] Simpan cursor per chain.
- [ ] Terapkan confirmation depth dan reorg rollback.
- [ ] Cocokkan destination evidence dengan:
  - message ID;
  - document ID;
  - document version;
  - source/destination selector.
- [ ] Verifikasi melalui `getProcessedMessage()`, `getReceipt()`, dan `verifyDocument()`.
- [ ] Bedakan `MessageReceived` dan `MessageIgnored`.
- [ ] Tandai message pending terlalu lama sebagai `RECOVERY_REQUIRED`.
- [ ] Jangan dispatch ulang message yang sudah diterima router.
- [ ] Hubungkan recovery state dengan CCIP recovery runbook.
- [ ] Buat reconciliation command yang idempotent.

### Kriteria Keberhasilan

- [ ] `SOURCE_ACCEPTED` dan `DESTINATION_CONFIRMED` tidak pernah tertukar.
- [ ] Replay event tidak membuat row atau transition duplikat.
- [ ] Reorg dapat dideteksi dan projection dapat diperbaiki.
- [ ] Missing event dan restart di tengah proses dapat direkonsiliasi.
- [ ] Failed receive tidak dilaporkan sebagai berhasil.

---

## Task 12 — Read Model dan Semantik Verifikasi

### TODO

- [ ] Kembalikan canonical `DocumentRecord`:
  - document ID;
  - content digest;
  - CID;
  - metadata commitment;
  - issuer;
  - source chain;
  - timestamps;
  - schema version;
  - document version;
  - lifecycle status;
  - supersession links.
- [ ] Sertakan source tx hash, block number/hash, dan confirmation status.
- [ ] Sertakan dispatch status per destination.
- [ ] Sertakan CCIP message ID dan destination evidence.
- [ ] Hitung ulang file digest pada search/verification.
- [ ] Gunakan `verifyDocument()` sebagai integrity check.
- [ ] Jangan menganggap CID availability sebagai authenticity.
- [ ] Selalu menangkan canonical source state ketika database atau destination berbeda.

### Kriteria Keberhasilan

- [ ] Revoked dan superseded document tetap dapat ditemukan tetapi tidak dilaporkan active.
- [ ] Destination pending/failure tidak mengubah source truth.
- [ ] File dengan CID tersedia tetapi digest/issuer salah tidak lolos verifikasi.
- [ ] Setiap status penting memiliki tx/block/message evidence.

---

## Task 13 — Test, CI, Dokumentasi, dan Cutover

### TODO

- [ ] Tambahkan unit test untuk:
  - digest/CID;
  - canonical metadata;
  - SIWE;
  - EIP-712;
  - signature validation;
  - state transition;
  - retry classification;
  - error mapping.
- [ ] Tambahkan PostgreSQL integration test untuk:
  - migrations;
  - row locking;
  - uniqueness;
  - idempotency;
  - restart;
  - reconciliation.
- [ ] Tambahkan deterministic local E2E tanpa Pinata/RPC publik.
- [ ] Tambahkan testnet smoke test terhadap deployment manifest aktif.
- [ ] Uji register, revoke, supersede, duplicate request, stale nonce, invalid signature, paused
  contract, insufficient fee, dropped transaction, receiver delay, replay event, RPC outage, dan
  reorg.
- [ ] Tambahkan CI gate untuk contract artifact drift.
- [ ] Gunakan lint check yang tidak otomatis menulis file pada CI.
- [ ] Ganti README bawaan NestJS.
- [ ] Sinkronkan API documentation.
- [ ] Dokumentasikan:
  - wallet roles tanpa secret;
  - deployment registry;
  - environment variables;
  - state machine;
  - EIP-712 client flow;
  - CCIP recovery;
  - reconciliation;
  - rollback.
- [ ] Hapus konfigurasi, ABI, DTO, endpoint, dan dokumentasi lama.
- [ ] Jalankan final reconciliation dan smoke test sebelum cutover.

### Kriteria Keberhasilan

- [ ] Contract dan backend quality gate lulus.
- [ ] Tidak ada secret di Git atau log.
- [ ] Tidak ada referensi aktif ke Holešky, Base Sepolia, address lama, `addDocument`, atau
  `documentExists(string)`.
- [ ] Register sampai destination confirmation dapat ditelusuri dengan intent ID, document ID,
  source tx hash, dan CCIP message ID.
- [ ] Runbook dapat dijalankan tanpa membaca source code internal.

---

## Definition of Done Rilis

- [ ] Smart contract deployment registry menjadi sumber tunggal chain/address backend.
- [ ] Admin wallet hanya memegang deployer/governance/pauser sesuai approval.
- [ ] Backend wallet memegang operator/relayer sesuai approval.
- [ ] User wallet tercatat sebagai issuer dan private key tetap di pengguna.
- [ ] ABI backend berasal dari exact contract commit.
- [ ] Digest, CID, metadata commitment, dan document ID konsisten.
- [ ] Register, revoke, dan supersede berfungsi end-to-end.
- [ ] Source confirmation dan destination confirmation dilaporkan terpisah.
- [ ] Restart, retry, duplicate request, dan multi-worker tidak menghasilkan transaksi ganda.
- [ ] Database dapat direkonsiliasi ulang dari on-chain evidence.
- [ ] RPC, Pinata, atau CCIP failure tidak disamarkan sebagai not-found atau success.
- [ ] Semua test dan quality gate kedua repository lulus.

## Batas Berhenti untuk Long-Running Codex Task

Codex harus berhenti dan meminta input pengguna bila:

- address admin, backend, atau user issuer belum tersedia;
- encrypted Foundry account belum tersedia;
- worktree smart contract belum bersih;
- saldo native/LINK tidak cukup;
- constructor arguments tidak cocok dengan plan;
- approval broadcast testnet belum diberikan;
- manifest deployment bertentangan dengan live bytecode;
- diperlukan penghapusan atau perubahan file yang bukan dibuat oleh Codex;
- diperlukan mainnet deployment atau perluasan destination di luar Ink Sepolia.
