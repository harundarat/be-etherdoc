# TODO Audit dan Modernisasi EtherDoc Backend

Dokumen ini adalah backlog hasil audit statis dan pemeriksaan lokal terhadap backend EtherDoc pada commit `b65b590` tanggal 18 Juli 2026. Fokus audit mencakup alur autentikasi, upload IPFS/Pinata, pencatatan on-chain, propagasi Chainlink CCIP, verifikasi dokumen, keamanan, dependensi, error handling, test, observability, dan dokumentasi.

## Ringkasan

Codebase ini masih layak sebagai proof of concept, tetapi belum aman untuk dijalankan ulang sebagai layanan produksi. Implementasinya saat ini adalah satu source chain Holešky dan satu destination chain Base Sepolia, bukan arsitektur multichain generik. Respons upload juga belum membuktikan transaksi source berhasil/final maupun pesan CCIP sudah berhasil di destination.

Hasil pemeriksaan lokal:

- `pnpm run build`: berhasil.
- `pnpm test -- --runInBand`: gagal karena tidak ada unit test yang ditemukan.
- `pnpm exec eslint ...`: 1.650 temuan; 1.561 terkait line ending/format. Setelah aturan Prettier dikeluarkan masih ada 83 error dan 6 warning TypeScript/ESLint.
- `pnpm audit --prod`: 37 vulnerability pada dependency produksi: 1 critical, 16 high, 19 moderate, dan 1 low.
- `pnpm outdated`: proyek sudah memakai NestJS 11, tetapi paket Nest terkunci pada 11.1.2 sementara patch terbaru saat audit adalah 11.1.28.
- Pemeriksaan runtime lokal mengonfirmasi `GET /documents/groups` salah masuk ke handler `GET /documents/:documentCID` dan menghasilkan 500, bukan masuk ke guard JWT/handler groups.
- Pemeriksaan runtime lokal mengonfirmasi signature berformat salah menghasilkan HTTP 500, bukan 400/401 seperti yang tertulis di dokumentasi.

Kode Solidity, deployment script, dan test kontrak tidak ada di repository ini. Karena hanya tersedia ABI, keamanan implementasi `EtherdocSender` dan `EtherdocReceiver` belum dapat diaudit secara penuh.

## Audit alur sistem saat ini

### 1. Autentikasi

Alur sekarang:

1. `GET /auth/nonce` membuat UUID.
2. Nonce disimpan di cache dengan satu key global bernama `nonce`.
3. Klien menandatangani JSON yang berisi address admin, string `auth-login`, dan nonce.
4. `POST /auth/login` mengambil nonce global, memulihkan address dari signature, lalu menghapus nonce.
5. JWT dikembalikan di response body dan cookie `etherdoc-auth`.

Masalah:

- Semua pengguna/request berbagi satu nonce. Request nonce baru membatalkan login yang sedang dilakukan klien lain dan dapat dipakai untuk denial of service.
- Cache in-memory tidak bekerja konsisten jika aplikasi mempunyai lebih dari satu instance atau restart.
- Operasi baca lalu hapus nonce tidak atomik; dua login paralel berpotensi sama-sama lolos sebelum nonce dihapus.
- Message belum mengikuti SIWE/EIP-4361 dan tidak mengikat domain, URI, chain ID, issued-at, expiration time, dan request/session.
- Signature malformed dilempar oleh `ethers.verifyMessage()` sebagai error biasa dan dipetakan menjadi 500.
- Endpoint nonce/login belum mempunyai rate limit.
- Cookie hanya memakai `httpOnly`; belum ada `secure`, `sameSite`, `path`, dan `maxAge`.
- JWT di cookie membuat kebijakan CSRF perlu dinyatakan. Mengembalikan token yang sama di body sekaligus cookie juga memperbesar permukaan eksposur.
- `JwtStrategy` menerima payload selama `admin` bertipe boolean; nilai `false` tetap lolos autentikasi karena tidak ada authorization/role guard lanjutan.

### 2. Upload dokumen, IPFS, dan transaksi source

Alur sekarang:

1. Multer menyimpan seluruh file ke memory.
2. `ParseFilePipe`/Nest 11 `FileTypeValidator` memeriksa magic number PDF dan ukuran maksimal 5 MiB.
3. Service secara paralel:
   - mengupload file ke Pinata; dan
   - memprediksi CID dengan `ipfs-only-hash`, lalu mengirim `addDocument()` ke kontrak source.
4. Setelah Pinata mengembalikan respons dan wallet client mengembalikan transaction hash, API langsung mengembalikan data Pinata.

Masalah:

- `Promise.all()` bukan transaksi atomik:
  - transaksi dapat berhasil tetapi upload/pin gagal, sehingga CID permanen tercatat on-chain tanpa dokumen yang tersedia;
  - upload dapat berhasil tetapi transaksi gagal, sehingga terdapat orphan pin;
  - request dapat timeout walaupun salah satu operasi sebenarnya masih berhasil.
- CID prediksi tidak pernah dibandingkan dengan `pinataResponseData.data.cid`. CID dipengaruhi codec, chunking, raw leaves, dan bentuk DAG; byte file yang sama tidak otomatis menjamin CID sama bila pipeline importer berbeda.
- Transaction hash disimpan ke variabel `txHash` tetapi tidak dipakai atau dikembalikan.
- `writeContract()` hanya menandakan transaksi sudah disiarkan. Kode belum menunggu receipt, mengecek status revert, confirmation/finality, atau membaca event `MessageSent`.
- Return value `messageId` dari `addDocument()` tidak tersedia langsung dari transaksi state-changing; message ID perlu diambil dari event receipt.
- Keberhasilan transaksi source belum berarti pesan CCIP berhasil dieksekusi di destination.
- Tidak ada idempotency key atau unique constraint untuk mencegah retry mengirim transaksi duplikat.
- Belum ada persistent job/status model untuk retry dan rekonsiliasi partial failure.
- Private key relayer dibaca langsung dari environment dan dibentuk dengan selalu menambah prefix `0x`; value yang sudah mempunyai prefix akan menjadi invalid.
- Request paralel dapat menimbulkan pengelolaan nonce transaksi wallet yang buruk bila beberapa upload memakai account relayer yang sama.
- Source contract, destination contract, dan chain selector di-hardcode di service.
- `EVM_PRIVATE_KEY` yang dibaca kode tidak sama dengan `EVM_WALLET_PRIVATE_KEY` di `.env.example` dan e2e test.
- Network `public`/`private` hanya memilih target Pinata. CID tetap dikirim ke public blockchain; ini harus dijelaskan sebagai kebocoran fingerprint/equality, bukan dianggap private end-to-end.

### 3. Propagasi multichain dengan CCIP

Alur sekarang hanya memanggil satu `addDocument(destinationSelector, receiver, cid)` dari Holešky ke Base Sepolia.

Masalah:

- Holešky sudah mencapai end-of-life. Ethereum Foundation menyarankan application/tooling developer memakai Sepolia, bukan Holešky.
- Hanya ada satu destination; belum ada konfigurasi N-chain, fan-out job, atau status per destination.
- Tidak ada tracking `messageId`, monitoring CCIP, retry/manual execution, atau reconciliation worker.
- API tidak dapat membedakan status `source pending`, `source confirmed`, `CCIP pending`, `destination confirmed`, dan `partial failure`.
- Tidak ada pengecekan kesiapan lane, allowlist source/destination/sender/receiver, balance LINK/fee, dan contract address sebelum menerima upload.
- Error kontrak seperti `DestinationChainNotAllowlisted`, `DocumentAlreadyExists`, dan `NotEnoughBalance` dari ABI dipadatkan menjadi 500 generik.
- Karena source code kontrak tidak tersedia, access control, replay protection, validation payload, dan mekanisme withdrawal/recovery token belum bisa diverifikasi.

### 4. Verifikasi dokumen

Alur sekarang:

1. Untuk pencarian berdasarkan file, backend menghitung CID.
2. Backend mengecek `documentExists(cid)` di source dan Base Sepolia.
3. Jika source mengembalikan false, dokumen dianggap tidak valid.
4. Metadata file diambil dari Pinata.
5. Respons mengembalikan dua boolean.

Masalah:

- `getDocumentByFile()` selalu mencari Pinata network `private`; dokumen yang tersimpan di network `public` dapat gagal ditemukan.
- RPC error ditangkap dan diubah menjadi `false`. Akibatnya “chain tidak dapat dihubungi” tidak dapat dibedakan dari “dokumen tidak tercatat”.
- Base Sepolia failure disembunyikan sebagai `isExistBase: false` dan respons tetap sukses.
- Definisi valid saat ini hanya mensyaratkan source chain; jadi klaim “tersimpan di beberapa chain sekaligus” belum menjadi bagian dari verification policy.
- Keaslian saat ini hanya berarti “CID pernah didaftarkan oleh relayer/admin”. Model belum menyatakan issuer, subject/document ID, version, issued-at, revoked/superseded, dan schema.
- Verifikasi bergantung pada Pinata metadata walaupun bukti on-chain dan availability storage seharusnya merupakan dua dimensi terpisah.
- Endpoint `GET /documents/:documentCID` tidak membutuhkan autentikasi tetapi menerima `network=private` dan menggunakan credential Pinata milik server. Kebijakan akses metadata private perlu ditentukan secara eksplisit.
- Menyimpan CID string on-chain lebih mahal daripada commitment `bytes32`. CID juga kurang ideal sebagai satu-satunya digest keaslian karena merepresentasikan struktur IPFS, bukan hanya byte dokumen.

## Target alur yang disarankan

Gunakan durable workflow dengan status yang dapat direkonsiliasi:

```text
POST /documents
  -> autentikasi + authorization + idempotency key
  -> hard limit di proxy/Multer + validasi magic bytes
  -> hitung content digest sambil stream
  -> upload/pin ke IPFS
  -> validasi schema respons + cocokkan CID/digest
  -> simpan Document + Outbox dalam database
  -> balas 202 Accepted dengan documentId dan status URL

Worker anchoring
  -> simulate source transaction
  -> submit transaction dengan relayer aman
  -> tunggu receipt + confirmation
  -> parse txHash dan CCIP messageId
  -> buat/lanjutkan job untuk setiap destination
  -> pantau destination receipt/event
  -> retry dengan backoff atau tandai partial failure

GET /documents/:id/status
  -> storage status
  -> source anchor status
  -> status per destination
  -> overall policy: pending | verified | partially_verified | failed | revoked
```

Urutan pin lebih dahulu lalu anchor lebih aman daripada menjalankan keduanya paralel: pin yang orphan masih dapat dihapus/ditandai dan transaksi dapat di-retry, sedangkan record on-chain tidak dapat di-rollback. Untuk mempertahankan precomputed CID, bangun CAR/DAG secara deterministik lalu upload artefak yang sama. Alternatif yang lebih sederhana adalah memakai CID hasil Pinata sebagai canonical CID dan menyimpan digest byte dokumen terpisah.

Data minimum yang disarankan:

- `Document`: ID internal, canonical CID, SHA-256/commitment, issuer, filename aman, size, MIME, storage provider ID, status, created/updated timestamps.
- `AnchorAttempt`: document ID, chain ID/selector, contract address, transaction hash, block number, CCIP message ID, status, attempt count, last error, timestamps.
- `OutboxJob`: operation, idempotency key, payload reference, retry count, next retry, lease/lock.
- Unique constraint yang sesuai, misalnya issuer + content digest, tanpa menghalangi use case versi dokumen yang memang berbeda.

Respons verifikasi sebaiknya memakai status tiga nilai per chain:

- `verified`: kontrak dapat dibaca dan commitment ditemukan.
- `not_found`: kontrak dapat dibaca tetapi commitment tidak ditemukan.
- `unavailable`: RPC/CCIP/provider sedang gagal atau timeout.

Storage availability juga dilaporkan terpisah dari authenticity.

## P0 — wajib sebelum redeploy

- [ ] Perbaiki shadowing route `GET /documents/groups`.

  - Letakkan route statis `/groups` sebelum `/:documentCID`, atau ubah route dokumen menjadi path yang tidak ambigu seperti `/by-cid/:documentCID`.
  - Tambahkan regression test: tanpa token harus 401 dan dengan token harus memanggil `getListGroups()`.

- [ ] Migrasikan source chain dari Holešky yang sudah sunset.

  - Pilih source/destination/lane yang saat implementasi masih tercantum di Chainlink CCIP Directory.
  - Untuk dapp test, evaluasi Ethereum Sepolia dan Base Sepolia; jangan menyalin selector/address lama.
  - Redeploy sender/receiver, perbarui allowlist, LINK funding, ABI, dan dokumentasi deployment.

- [ ] Hilangkan hardcoded chain selector dan contract address dari `DocumentsService`.

  - Buat typed chain registry per environment berisi chain ID, selector, RPC URL, sender/receiver, confirmations, dan enabled flag.
  - Validasi address, selector, lane, dan duplikasi chain saat bootstrap.
  - Jangan mengizinkan kombinasi source/destination arbitrary dari request pengguna.

- [ ] Perbaiki supply-chain vulnerability produksi.

  - Ganti `ipfs-only-hash`/dependency lama yang membawa `protobufjs` rentan critical; jangan hanya memaksa override tanpa compatibility test CID.
  - Upgrade `multer` minimal ke versi patched terbaru dan sinkronkan dengan `@nestjs/platform-express`.
  - Update patch NestJS, `@nestjs/config`, `class-validator`, `uuid`/penggantinya, dan transitive dependency untuk menutup advisory `jws`, `validator`, `lodash`, `qs`, `path-to-regexp`, `ws`, dan `body-parser`.
  - Jalankan kembali `pnpm audit --prod` dan simpan exception hanya bila ada risk acceptance tertulis beserta expiry.

- [ ] Pastikan CID/storage dan commitment on-chain konsisten.

  - Tetapkan canonical algorithm dan test vector.
  - Bandingkan CID hasil upload dengan CID yang akan ditulis on-chain, atau upload CAR/DAG deterministik.
  - Simpan content digest seperti SHA-256/`bytes32` terpisah dari CID.
  - Jangan mengembalikan sukses jika nilai storage dan nilai yang di-anchor tidak identik.

- [ ] Ganti `Promise.all(Pinata, writeContract)` dengan durable saga/outbox.

  - Pin dan validasi file terlebih dahulu.
  - Persist status lalu kirim transaksi melalui worker.
  - Jadikan operasi idempotent dan retryable.
  - Kembalikan 202 untuk proses CCIP asynchronous, bukan memberi kesan seluruh chain sudah selesai.

- [ ] Tunggu dan validasi lifecycle transaksi/CCIP.

  - `simulateContract()` sebelum broadcast.
  - Tunggu source receipt dan cek status.
  - Parse event `MessageSent` untuk mendapatkan `messageId`.
  - Pantau execution di setiap destination dan simpan status/attempt.
  - Sediakan reconciliation dan manual retry untuk partial failure.

- [ ] Perbaiki nonce authentication.

  - Gunakan SIWE/EIP-4361 atau message setara yang mengikat domain, URI, address, chain ID, issued-at, expiration, dan nonce.
  - Simpan nonce per session/request di Redis/shared store.
  - Consume nonce secara atomik sekali pakai.
  - Beri rate limit pada nonce dan login.
  - Petakan signature malformed/invalid ke 400/401, bukan 500.

- [ ] Terapkan batas upload sebelum file masuk penuh ke memory.

  - Set `limits.fileSize`, `limits.files`, `limits.fields`, dan batas nama field pada Multer/FileInterceptor.
  - Terapkan request-body limit dan timeout di reverse proxy/API gateway.
  - Rate-limit endpoint `/documents/search` karena endpoint publik ini memakai memory, CPU, Pinata, dan dua RPC.
  - Pertahankan validasi magic number bawaan Nest 11, tambahkan validasi struktur PDF bila dibutuhkan, dan pertimbangkan malware scanning sesuai threat model.

- [ ] Perbaiki dan validasi konfigurasi saat bootstrap.

  - Samakan `EVM_PRIVATE_KEY` dengan `.env.example`/test.
  - Validasi format private key dengan/atau tanpa `0x`, JWT secret minimum, URL HTTPS, CORS origin, address, chain selector, dan expiry.
  - Fail fast sebelum aplikasi listen; jangan memanggil `getOrThrow()` tersebar di request path.
  - Pindahkan signing key produksi ke KMS/HSM/managed relayer dan batasi balance/permission account.

- [ ] Audit source code smart contract sebelum mengklaim production-ready.
  - Sertakan Solidity source, compiler settings, deployment artifacts, chain addresses, verification links, dan test.
  - Audit access control `addDocument`, allowlist, source sender validation, replay protection, fee/balance recovery, duplicate document, revocation, pause/emergency path, dan event.
  - Pastikan payload memuat identifier/version/issuer/commitment yang dibutuhkan verification policy, bukan hanya string CID.

## P1 — correctness, security, dan reliability

- [ ] Perbaiki `createGroup()`.

  - Pindahkan `Content-Type: application/json` ke dalam object `headers`.
  - Gunakan `JSON.stringify({ name: groupName })`, bukan string interpolation yang rusak jika nama berisi quote/backslash.
  - Tambahkan `IsNotEmpty`, batas panjang, dan normalisasi nama.
  - Perbaiki pesan log yang saat ini menyebut “get list of files” ketika create group gagal.

- [ ] Pisahkan Pinata client dan blockchain client dari `DocumentsService`.

  - Buat provider/interface terpisah agar timeout, retry, schema validation, dan test mudah diterapkan.
  - Reuse public/wallet client; jangan membuat client baru setiap request.
  - Inject client pada test, jangan mock global secara tidak terkontrol.

- [ ] Tambahkan timeout, retry, dan circuit breaker untuk Pinata/RPC.

  - Gunakan `AbortSignal.timeout()` atau mekanisme setara.
  - Retry hanya operasi transient dan idempotent dengan exponential backoff + jitter.
  - Jangan retry blindly pada transaksi yang mungkin sudah broadcast; reconcile dengan idempotency/transaction record.

- [ ] Perbaiki klasifikasi error.

  - Jangan meneruskan status 401/403 Pinata kepada user seolah JWT user salah; map upstream auth/config failure ke 502/503 dan alert internal.
  - Bedakan validation 400/422, not found 404, conflict/duplicate 409, dependency failure 502/503, dan timeout 504.
  - Gunakan `unknown` pada `catch`, type guard, error code stabil, correlation ID, dan global exception filter.
  - Jangan mengubah RPC error menjadi `false`.
  - Redact token, private key, signature, raw upstream response, dan data sensitif dari log.

- [ ] Perbaiki validation DTO dan response schema.

  - Ekspor satu enum `Network` bersama; jangan mendefinisikannya empat kali dan mengetik beberapa field sebagai `string`.
  - Buat DTO untuk `network` pada `GET /documents/:documentCID`.
  - Validasi CID dengan parser multiformats, group ID, panjang name, jumlah/ukuran key-value, key yang diperbolehkan, dan pagination token.
  - Tangani JSON metadata invalid sebagai 400.
  - Validasi respons Pinata sebelum mengakses `data.files[0]`.
  - Hindari `Record<string, any>` dan return type implicit `any`.

- [ ] Tentukan authorization policy.

  - Putuskan apakah hanya satu admin, multi-issuer, atau role-based user.
  - Guard harus memeriksa role/value yang benar, bukan sekadar keberadaan boolean.
  - Putuskan apakah metadata private boleh diakses melalui endpoint publik.
  - Tambahkan logout/revocation bila cookie auth dipertahankan.

- [ ] Harden cookie dan HTTP application.

  - Set cookie `httpOnly`, `secure` di production, `sameSite`, `path`, dan `maxAge` konsisten dengan JWT.
  - Jika cookie dipakai untuk autentikasi cross-site, tambahkan proteksi CSRF yang tepat.
  - Konfigurasikan CORS sebagai allowlist ter-parse, bukan satu raw string.
  - Tambahkan Helmet/security headers, rate limiting, request ID, dan trust proxy yang benar.

- [ ] Tangani concurrency relayer.

  - Gunakan managed relayer atau transaction queue/nonce manager per account.
  - Simpan transaction intent sebelum broadcast.
  - Rekonsiliasi dropped/replaced transaction dan kenaikan gas.
  - Monitor native gas dan LINK/fee balance dengan alert.

- [ ] Ubah model verification.

  - Pisahkan `authenticity`, `storageAvailability`, dan `crossChainReplication`.
  - Tentukan policy overall: source cukup, quorum, atau seluruh destination wajib.
  - Tambahkan issuer, issued-at, version, dan revocation/superseded status.
  - Kembalikan status per chain dengan block/tx evidence, bukan hanya boolean.

- [ ] Tinjau privasi dokumen.

  - Dokumentasikan bahwa public CID/commitment memungkinkan equality check terhadap file yang dimiliki pihak lain.
  - Untuk dokumen sensitif, lakukan client-side encryption dan anchor commitment ciphertext/manifest sesuai threat model.
  - Pisahkan metadata personal dari data immutable on-chain dan buat retention/deletion policy untuk storage off-chain.

- [ ] Tambahkan pagination dan filter terkontrol pada list files/groups.
  - Forward `limit`, `pageToken`, dan sort secara tervalidasi.
  - Jangan selalu mengembalikan hanya page pertama tanpa penjelasan.

## P1 — test dan quality gate

- [ ] Tambahkan unit test yang saat ini belum ada.

  - Auth: nonce unik per session, expiry, atomic consume, concurrent login, invalid/malformed signature, missing config, JWT role.
  - Documents: CID mismatch, Pinata failure, source revert, dropped transaction, RPC unavailable, destination pending/failure, duplicate upload, timeout, invalid metadata.
  - Controller: route precedence `/groups`, DTO validation, auth guard, file limits, public/private policy.

- [ ] Refactor e2e test agar deterministik.

  - Jangan menggunakan private key produksi atau real Pinata/RPC pada default e2e.
  - Gunakan fake Pinata server dan local EVM/anvil atau test double yang kontraknya jelas.
  - Pisahkan `test:e2e` offline dari `test:integration:live` yang opt-in.
  - Jangan membuat group nyata bernama `test` setiap test run.
  - Perbaiki test stale yang memakai `exampleId` untuk parameter CID dan mengharapkan `response.body.data` walau service mengembalikan DTO langsung.
  - Hapus test upload kosong yang sekarang selalu pass karena seluruh isi test dikomentari.
  - Gunakan `beforeAll` bila tidak perlu rebuild aplikasi untuk setiap case.

- [ ] Tambahkan contract test.

  - Unit/fuzz/property test sender dan receiver.
  - Test duplicate CID, unauthorized sender/source, invalid receiver, insufficient fee, replayed message, pause/recovery, dan multi-destination.
  - Test integrasi CCIP dengan simulator resmi yang sesuai versi kontrak.

- [ ] Jadikan CI sebagai gate.

  - Install frozen lockfile, format check, lint tanpa `--fix`, typecheck/build, unit, e2e offline, coverage threshold, production audit, dan secret scan.
  - Jalankan integration live hanya pada environment terisolasi dengan budget/rate limit.

- [ ] Perbaiki lint/format workflow.
  - Tambahkan `.gitattributes`/`.editorconfig` agar line ending konsisten.
  - Ubah `lint` menjadi check-only; buat `lint:fix` terpisah.
  - Tambahkan `format:check`.
  - Naikkan strictness TypeScript secara bertahap: `strict`, `noImplicitAny`, `noFallthroughCasesInSwitch`, dan typed catch handling.
  - Samakan `ecmaVersion` ESLint dengan target runtime; nilai `5` saat ini tidak cocok dengan target ES2023.
  - Tangani rejected bootstrap promise di `main.ts`.

## P2 — dependency dan modernisasi NestJS

- [ ] Update NestJS 11 secara terkoordinasi ke patch terbaru.

  - Saat audit: lockfile memakai 11.1.2 dan patch terbaru 11.1.28.
  - Update `@nestjs/common`, `core`, `platform-express`, `testing`, CLI, schematics, cache manager, config, passport, dan JWT sebagai satu batch.
  - NestJS 11 memerlukan Node.js 20+; pin satu Node LTS yang didukung untuk local, CI, dan production. Environment audit memakai Node 24.16.0.
  - Jangan langsung lompat ke major TypeScript/Jest/ESLint hanya karena `pnpm outdated`; lakukan batch terpisah dengan migration guide dan test.

- [ ] Perbaiki klasifikasi dependency.

  - Pindahkan `@nestjs/jwt` dari `devDependencies` ke `dependencies` karena dibutuhkan saat runtime.
  - Evaluasi dan hapus dependency langsung yang tidak dipakai: `@nestjs/mapped-types`, `blockstore-core`, `ipfs-unixfs-importer`, dan `typestub-ipfs-only-hash`.
  - Hapus `@types/uuid` bila versi `uuid` yang dipakai sudah membawa type sendiri, atau ganti UUID nonce dengan `crypto.randomUUID()`.
  - Pertimbangkan konsolidasi `ethers` dan `viem`, tetapi jangan mengorbankan library SIWE/fitur yang dibutuhkan hanya demi mengurangi satu dependency.
  - Tambahkan field `engines` dan `packageManager` pada `package.json`.

- [ ] Tambahkan typed configuration module.

  - Kelompokkan `app`, `auth`, `pinata`, `sourceChain`, dan `destinations`.
  - Expose config object typed/read-only kepada service.
  - Sediakan `.env.test.example`; jangan gunakan wallet deployer/admin production untuk test.

- [ ] Tambahkan OpenAPI/Swagger yang dihasilkan dari controller/DTO.

  - Jadikan spec sebagai sumber dokumentasi API.
  - Tambahkan example error dengan stable error code.
  - Version endpoint, misalnya `/v1`, sebelum melakukan perubahan response besar.

- [ ] Buat health endpoint yang bermakna.

  - Liveness hanya membuktikan proses hidup.
  - Readiness memeriksa dependency penting secara bounded: database/queue dan konfigurasi; Pinata/RPC dapat dilaporkan per dependency tanpa menggantung request.
  - Aktifkan graceful shutdown hooks.

- [ ] Tambahkan observability.
  - Structured JSON logs, request/correlation ID, latency, status code, dan redaction.
  - Metrics untuk upload, pin failure, source tx, confirmation latency, CCIP latency/status per chain, retry, queue depth, dan relayer balance.
  - Distributed trace dari API request ke job, tx hash, dan CCIP message ID.
  - Alert untuk partial replication, stuck message, RPC degradation, dan low balance.

## P2 — README dan dokumentasi

- [ ] Ganti `README.md` bawaan NestJS dengan README EtherDoc.

  - Jelaskan tujuan dan batasan keaslian dokumen.
  - Tambahkan diagram arsitektur source chain, CCIP destinations, Pinata, database/queue, dan API.
  - Dokumentasikan prerequisites, Node/pnpm yang dipin, setup, env table yang benar, test offline/live, build, dan deploy.
  - Dokumentasikan status state machine, idempotency, retry, dan failure recovery.
  - Cantumkan contract address/chain ID/selector per environment dari deployment registry, bukan nilai yang di-hardcode di prose.
  - Tambahkan security disclosure, threat model singkat, privacy warning, dan operational runbook links.

- [ ] Sinkronkan `docs/api-doc.md` dengan implementasi/OpenAPI.

  - Perbaiki route groups setelah bug route diselesaikan.
  - Perbaiki status invalid signature yang saat ini aktualnya 500.
  - Jelaskan bahwa CCIP asynchronous dan upload response bukan bukti destination confirmed.
  - Jelaskan perbedaan `public` versus `private` Pinata dan fakta bahwa on-chain commitment tetap publik.
  - Validasi atau hapus production Base URL Railway yang mungkin sudah stale.
  - Tambahkan pagination, error code, status endpoint, dan contoh partial failure.

- [ ] Selesaikan inkonsistensi lisensi.

  - `package.json` menyatakan `UNLICENSED`, sedangkan README bawaan menyatakan MIT.
  - Pilih lisensi yang memang dimaksud dan tambahkan file `LICENSE` bila relevan.

- [ ] Tambahkan Architecture Decision Records.
  - ADR canonical digest/CID.
  - ADR pin-first saga dan outbox.
  - ADR source-of-truth serta verification quorum.
  - ADR relayer/key custody.
  - ADR privacy/encryption.
  - ADR strategi chain migration dan deprecation.

## P3 — peningkatan produk/protokol

- [ ] Tambahkan document versioning dan revocation.
- [ ] Tambahkan multi-issuer dengan role/contract identity yang dapat diaudit.
- [ ] Tambahkan batch anchoring/Merkle root bila biaya menyimpan setiap CID terlalu tinggi.
  - Simpan root per batch dan berikan Merkle proof pada hasil verifikasi.
  - Pertahankan timestamp, issuer, dan audit trail yang dapat ditelusuri.
- [ ] Tambahkan webhook/event stream untuk perubahan status anchoring/CCIP.
- [ ] Evaluasi multi-provider pinning untuk mengurangi ketergantungan pada satu storage provider.
- [ ] Buat reconciliation command/runbook untuk membandingkan database, Pinata, source chain, dan seluruh destination.
- [ ] Tambahkan disaster recovery untuk database/queue/config registry tanpa mencoba “backup” private key plaintext.

## Urutan implementasi yang disarankan

1. Bekukan redeploy ke Holešky dan tentukan testnet/lane CCIP baru.
2. Perbaiki route, config mismatch, signature error, hard file limits, dan vulnerability critical/high.
3. Tambahkan test offline yang menangkap perilaku existing sebelum refactor.
4. Pisahkan Pinata/chain clients dan perkenalkan database + outbox/state machine.
5. Ubah upload menjadi pin-first, receipt-aware, dan idempotent.
6. Implementasikan per-destination CCIP tracking dan endpoint status.
7. Perbarui verification policy/data model serta audit kontrak.
8. Tambahkan observability, CI gate, OpenAPI, README, dan runbook.
9. Baru lakukan staged upgrade dependency major dan fitur produk lanjutan.

## Definition of done untuk rilis berikutnya

- [ ] Tidak ada vulnerability critical/high yang belum mempunyai remediation atau risk acceptance aktif.
- [ ] Semua route protected benar-benar diuji sebagai 401/403 tanpa credential.
- [ ] Upload tidak dapat menghasilkan “success” sebelum pin/CID/digest tervalidasi dan job durable tercatat.
- [ ] Source transaction mempunyai receipt sukses dan CCIP mempunyai status per destination.
- [ ] Partial failure dapat di-retry/reconcile tanpa membuat anchor duplikat.
- [ ] RPC unavailable tidak dilaporkan sebagai document not found.
- [ ] Nonce sekali pakai, scoped, atomic, expiring, dan aman pada multi-instance.
- [ ] Tidak ada private key plaintext di repository/log; production signing memakai custody yang disetujui.
- [ ] Unit/e2e offline lulus di CI, termasuk route precedence, CID mismatch, rollback/retry, dan CCIP pending/failure.
- [ ] README, OpenAPI, contract registry, threat model, dan operational runbook sesuai implementasi.

## Referensi versi dan layanan

- [NestJS 11 migration guide](https://docs.nestjs.com/migration-guide) — termasuk requirement Node.js 20+ dan perubahan Express 5.
- [Ethereum Foundation: Holešky Testnet Shutdown Announcement](https://blog.ethereum.org/2025/09/01/holesky-shutdown-announcement) — application/tooling developer diarahkan ke Sepolia.
- [Chainlink CCIP Tools dan supported chains](https://docs.chain.link/ccip/tools/) — gunakan SDK/API/directory resmi untuk data chain dan lane terbaru.
- [Pinata V3 Upload API](https://docs.pinata.cloud/api-reference/endpoint/upload-a-file) — endpoint dan bentuk response upload saat ini.
- [Pinata V3 List Files API](https://docs.pinata.cloud/api-reference/endpoint/list-files) — filter CID, pagination, dan network public/private.
- [Pinata Private IPFS](https://docs.pinata.cloud/files/private-ipfs) — perbedaan akses public/private dan temporary access link.
