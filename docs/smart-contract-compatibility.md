# Smart Contract Compatibility Baseline

Dokumen ini membekukan interface yang harus diikuti backend. Solidity source dan artifact hasil
kompilasi pada repository `sc-etherdoc` adalah sumber kebenaran; ringkasan ini bukan salinan ABI
untuk runtime.

## Baseline yang dapat direproduksi

| Item              | Nilai                                            |
| ----------------- | ------------------------------------------------ |
| Repository        | `sc-etherdoc`                                    |
| Commit            | `b132bf4360108db00959fc5aa75009a12283ed69`       |
| Foundry           | `v1.7.1`, sesuai `.foundry-version`              |
| Compiler          | Solidity `0.8.36`                                |
| Sender artifact   | `out/EtherdocSender.sol/EtherdocSender.json`     |
| Receiver artifact | `out/EtherdocReceiver.sol/EtherdocReceiver.json` |
| Network config    | `config/networks/testnet.json`                   |

Verifikasi baseline pada 26 Juli 2026:

```text
forge build
forge test -vv

13 suites; 112 passed; 0 failed; 2 skipped
```

Dua test yang dilewati adalah fork test Ethereum/Mantle yang membutuhkan RPC. Source contract,
submodule, config, deployment script, dan test semuanya berasal dari commit di atas. File lokal lama
`sc-etherdoc/soljson-latest.js` tidak termasuk baseline dan telah dihapus setelah persetujuan
eksplisit pemilik.

## Network dan deployment roles

| Peran            | Network          |   Chain ID |          CCIP selector | Router                                       | LINK                                         |
| ---------------- | ---------------- | ---------: | ---------------------: | -------------------------------------------- | -------------------------------------------- |
| Canonical source | Ethereum Sepolia | `11155111` | `16015286601757825753` | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| Destination      | Mantle Sepolia   |     `5003` |  `8236463271206331221` | `0xFd33fd627017fEf041445FC19a2B6521C9778f86` | `0x22bdEdEa0beBdD7CfFC95bA53826E55afFE9DE04` |

Kedua lane memakai LINK, gas limit `500000`, governance mode `DIRECT`, dan full-finality CCIP
extra args v3. Nilai pada tabel hanya mencatat baseline; implementasi backend wajib membacanya dari
generated deployment registry/network artifact, bukan menyalinnya ke business logic.

`EtherdocSender` adalah registry canonical dan endpoint outbound pada Ethereum Sepolia.
`EtherdocReceiver` adalah projection receipt pada Mantle Sepolia dan bukan sumber kebenaran
alternatif.

| Authority        | Sender                                                                              | Receiver                                                    |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Governance/owner | Konfigurasi remote, issuer, operator, pauser, unpause, treasury, two-step ownership | Trusted sender, pauser, unpause, two-step ownership         |
| `PAUSER_ROLE`    | Pause registration dan dispatch; tidak dapat unpause                                | Pause receive; tidak dapat unpause                          |
| `OPERATOR_ROLE`  | Dispatch dokumen; backend relayer ditargetkan memegang role ini                     | Konstanta diwarisi, tetapi tidak dipakai pada flow receiver |
| Issuer allowlist | Wajib untuk direct call maupun `*BySig`                                             | Provenance diterima hanya dari trusted source sender        |

## Public/external interface

Signature berikut berasal dari ABI hasil `forge build`. Overload ditulis sebagai signature lengkap.

### EtherdocSender

| Kelompok            | Function                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct lifecycle    | `registerDocument(bytes32,string)`, `registerDocument(bytes32,string,bytes32)`, `revokeDocument(bytes32)`, `supersedeDocument(bytes32,bytes32,string,bytes32)`                                                                                                                           |
| Relayed lifecycle   | `registerDocumentBySig(bytes32,string,bytes32,address,uint256,bytes)`, `revokeDocumentBySig(bytes32,address,uint256,bytes)`, `supersedeDocumentBySig(bytes32,bytes32,string,bytes32,address,uint256,bytes)`                                                                              |
| Dispatch            | `quoteFee(bytes32,uint64)`, `dispatchDocument(bytes32,uint64,uint256)`                                                                                                                                                                                                                   |
| Canonical reads     | `computeDocumentId(address,bytes32)`, `getDocument(bytes32)`, `verifyDocument(bytes32,bytes32)`, `isDocumentRegistered(bytes32)`, `isDocumentActive(bytes32)`                                                                                                                            |
| Signature reads     | `issuerNonce(address)`, `getRegisterDocumentDigest(address,bytes32,string,bytes32,uint256,uint256)`, `getRevokeDocumentDigest(address,bytes32,uint64,uint256,uint256)`, `getSupersedeDocumentDigest(address,bytes32,uint64,bytes32,string,bytes32,uint256,uint256)`, `eip712Domain()`    |
| Dispatch reads      | `getDispatch(bytes32,uint64)`, `getDispatchAtVersion(bytes32,uint64,uint64)`, `getRemoteConfig(uint64)`, `getRouter()`, `getFeeToken()`                                                                                                                                                  |
| Authorization reads | `isIssuerAuthorized(address)`, `hasRole(bytes32,address)`, `owner()`, `OPERATOR_ROLE()`, `PAUSER_ROLE()`                                                                                                                                                                                 |
| Pause reads         | `registrationPaused()`, `dispatchPaused()`                                                                                                                                                                                                                                               |
| Governance writes   | `configureRemote(uint64,address,uint32,bool)`, `setIssuerAuthorization(address,bool)`, `setOperator(address,bool)`, `setPauser(address,bool)`, `unpauseRegistration()`, `unpauseDispatch()`, `withdrawToken(address,address,uint256)`, `transferOwnership(address)`, `acceptOwnership()` |
| Pauser writes       | `pauseRegistration()`, `pauseDispatch()`                                                                                                                                                                                                                                                 |
| Typehash constants  | `REGISTER_DOCUMENT_TYPEHASH()`, `REVOKE_DOCUMENT_TYPEHASH()`, `SUPERSEDE_DOCUMENT_TYPEHASH()`                                                                                                                                                                                            |

### EtherdocReceiver

| Kelompok                  | Function                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CCIP entrypoint           | `ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))` — hanya router                                                                                                                                     |
| Receipt reads             | `getReceipt(bytes32)`, `getProcessedMessage(bytes32)`, `getMessageDocument(bytes32)`, `isMessageProcessed(bytes32)`, `isDocumentReceived(bytes32)`, `isDocumentActive(bytes32)`, `verifyDocument(bytes32,bytes32)` |
| Trust reads               | `getSourceChainSelector()`, `getSourceChainId()`, `getTrustedSender()`, `isTrustedRemote(uint64,address)`                                                                                                          |
| Protocol reads            | `PAYLOAD_SCHEMA_VERSION()`, `PAYLOAD_LENGTH()`, `CANONICAL_CID_LENGTH()`, `getRouter()`, `getCCVsAndFinalityConfig(uint64,bytes)`, `supportsInterface(bytes4)`                                                     |
| Authorization/pause reads | `receivePaused()`, `hasRole(bytes32,address)`, `owner()`, `OPERATOR_ROLE()`, `PAUSER_ROLE()`                                                                                                                       |
| Governance writes         | `setTrustedSender(address)`, `setPauser(address,bool)`, `unpauseReceive()`, `transferOwnership(address)`, `acceptOwnership()`                                                                                      |
| Pauser writes             | `pauseReceive()`                                                                                                                                                                                                   |

## Struct dan enum

Enum memakai ordinal berikut dan harus diperlakukan sebagai angka unsigned pada ABI:

| Enum             | Nilai                                                |
| ---------------- | ---------------------------------------------------- |
| `DocumentStatus` | `UNKNOWN=0`, `ACTIVE=1`, `REVOKED=2`, `SUPERSEDED=3` |
| `Operation`      | `UNKNOWN=0`, `REGISTER=1`, `REVOKE=2`, `SUPERSEDE=3` |
| `DispatchStatus` | `NOT_DISPATCHED=0`, `DISPATCHED=1`                   |
| `ReceiptStatus`  | `NOT_RECEIVED=0`, `RECEIVED=1`                       |

| Struct             | Field dalam urutan ABI                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentRecord`   | `documentId bytes32`, `contentDigest bytes32`, `metadataCommitment bytes32`, `documentCID string`, `cidCodec uint8`, `cidDigest bytes32`, `issuer address`, `sourceChainId uint256`, `registeredAt uint64`, `updatedAt uint64`, `version uint64`, `schemaVersion uint16`, `status DocumentStatus`, `supersedes bytes32`, `supersededBy bytes32` |
| `DocumentPayload`  | `schemaVersion uint16`, `operation Operation`, `contentDigest bytes32`, `metadataCommitment bytes32`, `cidCodec uint8`, `cidDigest bytes32`, `issuer address`, `sourceChainId uint256`, `registeredAt uint64`, `updatedAt uint64`, `version uint64`, `status DocumentStatus`, `supersedes bytes32`, `supersededBy bytes32`                      |
| `DispatchRecord`   | `messageId bytes32`, `destinationChainSelector uint64`, `receiver address`, `sentAt uint64`, `documentVersion uint64`, `gasLimit uint32`, `status DispatchStatus`                                                                                                                                                                               |
| `RemoteConfig`     | `receiver address`, `gasLimit uint32`, `allowlisted bool`                                                                                                                                                                                                                                                                                       |
| `ReceiptRecord`    | `messageId bytes32`, `sourceChainSelector uint64`, `sender address`, `receivedAt uint64`, `status ReceiptStatus`, `operation Operation`, `document DocumentRecord`                                                                                                                                                                              |
| `ProcessedMessage` | `documentId bytes32`, `documentVersion uint64`, `processed bool`                                                                                                                                                                                                                                                                                |

`SupersedeAuthorization` adalah struct internal untuk hashing dan mempunyai field:
`issuer`, `oldDocumentId`, `currentVersion`, `newDocumentId`, `newContentDigest`, `newCidCodec`,
`newCidDigest`, `metadataCommitment`, `nonce`, dan `deadline`.

## Event

| Contract         | Event ABI                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender           | `DocumentRegistered(bytes32,bytes32,address,string,uint8,bytes32,bytes32,uint256,uint64,uint16)`                                                                             |
| Sender           | `DocumentStatusChanged(bytes32,address,DocumentStatus,uint64,bytes32,uint64)`                                                                                                |
| Sender           | `MessageSent(bytes32,bytes32,uint64,address,string,uint64,DocumentStatus,uint32,address,uint256)`                                                                            |
| Sender           | `IssuerAuthorizationUpdated(address,bool)`                                                                                                                                   |
| Sender           | `RemoteConfigUpdated(uint64,address,uint32,bool)`                                                                                                                            |
| Sender           | `RegistrationPaused(address)`, `RegistrationUnpaused(address)`, `DispatchPaused(address)`, `DispatchUnpaused(address)`                                                       |
| Sender           | `TokenWithdrawn(address,address,uint256)`                                                                                                                                    |
| Receiver         | `MessageReceived(bytes32,bytes32,uint64,address,address,uint64,Operation,DocumentStatus,uint64)`                                                                             |
| Receiver         | `MessageIgnored(bytes32,bytes32,uint64,uint64,bool)`                                                                                                                         |
| Receiver         | `TrustedSenderUpdated(address,address)`                                                                                                                                      |
| Receiver         | `ReceivePaused(address)`, `ReceiveUnpaused(address)`                                                                                                                         |
| Shared/inherited | `RoleAuthorizationUpdated(bytes32,address,bool)`, `OwnershipTransferRequested(address,address)`, `OwnershipTransferred(address,address)`, dan sender `EIP712DomainChanged()` |

Indexed fields tetap harus diambil dari ABI artifact. Khususnya `MessageSent.messageId` membuktikan
router menerima source dispatch, sedangkan hanya `MessageReceived`/receipt receiver yang membuktikan
destination confirmation.

## Custom error

| Contract                    | Custom error                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender lifecycle/provenance | `InvalidContentDigest()`, `InvalidDocumentCID()`, `RawCIDContentDigestMismatch(bytes32,bytes32)`, `InvalidIssuerAddress()`, `IssuerNotAuthorized(address)`, `CallerNotDocumentIssuer(address,address)`, `SignatureExpired(uint256)`, `InvalidIssuerSignature(address)`, `DocumentAlreadyRegistered(bytes32)`, `DocumentNotRegistered(bytes32)`, `DocumentNotActive(bytes32)` |
| Sender dispatch/config      | `DocumentAlreadyDispatched(bytes32,uint64,uint64)`, `InvalidDestinationChainSelector(uint64)`, `InvalidReceiverAddress()`, `InvalidGasLimit(uint256)`, `DestinationChainNotAllowlisted(uint64)`, `FeeExceedsMaximum(uint256,uint256)`, `NotEnoughBalance(uint256,uint256)`, `InvalidRouter(address)`, `InvalidLinkToken(address)`, `InvalidOutboundMessageId()`              |
| Sender treasury/pause       | `InvalidTokenAddress()`, `InvalidWithdrawalRecipient()`, `RegistrationIsPaused()`, `RegistrationNotPaused()`, `DispatchIsPaused()`, `DispatchNotPaused()`                                                                                                                                                                                                                    |
| Receiver envelope/trust     | `InvalidMessageId()`, `InvalidSenderEncoding(uint256)`, `InvalidSourceChainSelector(uint64)`, `InvalidSourceChainId(uint256)`, `UnexpectedSourceChainId(uint256,uint256)`, `InvalidRemoteSender(address)`, `UntrustedRemote(uint64,address)`, `InvalidPayloadLength(uint256,uint256)`, `InvalidPayloadSchema(uint16)`                                                        |
| Receiver record             | `InvalidPayloadOperation(Operation,DocumentStatus)`, `InvalidContentDigest(bytes32)`, `UnsupportedCIDCodec(uint8)`, `RawCIDContentDigestMismatch(bytes32,bytes32)`, `InvalidDocumentCommitment(bytes32)`, `InvalidDocumentVersion(bytes32)`, `ConflictingDocumentProvenance(bytes32)`, `ConflictingDocumentState(bytes32,uint64)`                                            |
| Receiver pause              | `ReceiveIsPaused()`, `ReceiveNotPaused()`                                                                                                                                                                                                                                                                                                                                    |
| Shared/inherited ABI        | `InvalidGovernanceAddress()`, `InvalidRoleAccount()`, `UnauthorizedRole(bytes32,address)`; sender juga mengekspos `InvalidShortString()`, `StringTooLong(string)`, `ReentrancyGuardReentrantCall()`, `SafeERC20FailedOperation(address)`                                                                                                                                     |

Backend harus memetakan revert/RPC error secara eksplisit. Error transport, timeout, atau chain
mismatch tidak boleh diterjemahkan menjadi document-not-found.

## CCIP payload schema v3

Sender mengirim:

```solidity
abi.encode(DocumentPayload({
  schemaVersion,
  operation,
  contentDigest,
  metadataCommitment,
  cidCodec,
  cidDigest,
  issuer,
  sourceChainId,
  registeredAt,
  updatedAt,
  version,
  status,
  supersedes,
  supersededBy
}))
```

Ukuran ABI payload wajib tepat `448` byte dan `schemaVersion` wajib `3`. CID tidak dikirim sebagai
string: receiver merekonstruksi CIDv1 lowercase unpadded base32 dari codec (`raw=0x55` atau
`dag-pb=0x70`) dan multihash SHA2-256 digest. Raw CID mensyaratkan `cidDigest == contentDigest`.
Receiver mengikat envelope pada selector Ethereum Sepolia, sender address tepercaya, dan
`sourceChainId=11155111`; pesan diproses idempotent berdasarkan message ID dan versi.

## EIP-712

Domain canonical adalah:

```text
name: Etherdoc
version: 2
chainId: 11155111
verifyingContract: deployed EtherdocSender address
```

Primary type dan field order exact:

```text
RegisterDocument(
  address issuer,
  bytes32 documentId,
  bytes32 contentDigest,
  uint8 cidCodec,
  bytes32 cidDigest,
  bytes32 metadataCommitment,
  uint256 nonce,
  uint256 deadline
)

RevokeDocument(
  address issuer,
  bytes32 documentId,
  uint64 currentVersion,
  uint256 nonce,
  uint256 deadline
)

SupersedeDocument(
  address issuer,
  bytes32 oldDocumentId,
  uint64 currentVersion,
  bytes32 newDocumentId,
  bytes32 newContentDigest,
  uint8 newCidCodec,
  bytes32 newCidDigest,
  bytes32 metadataCommitment,
  uint256 nonce,
  uint256 deadline
)
```

Nonce berasal dari `issuerNonce(issuer)`, dikonsumsi hanya oleh signature valid, dan kontrak
mendukung EOA maupun ERC-1271 melalui `SignatureChecker`. Backend wajib membandingkan digest lokal
dengan getter digest kontrak.

## Document identity, lifecycle, dan versioning

Canonical identity adalah:

```solidity
documentId = keccak256(abi.encode(issuer, contentDigest))
contentDigest = sha256(exactUploadedFileBytes)
```

CID bukan canonical document identity. CID menunjuk representasi storage/IPFS, dapat mempunyai
codec/DAG berbeda untuk byte file yang sama, dan availability CID tidak membuktikan issuer,
lifecycle, atau authenticity. Semua API dan database projection harus memakai `documentId`; CID
hanya salah satu field record.

Lifecycle source:

1. Register membuat record `ACTIVE`, version `1`.
2. Revoke mempertahankan provenance, mengubah status menjadi `REVOKED`, version `2`.
3. Supersede membuat record baru `ACTIVE`, version `1`, mengisi `new.supersedes`; record lama
   menjadi `SUPERSEDED`, version `2`, dan mengisi `old.supersededBy`.
4. `REVOKED` dan `SUPERSEDED` terminal. Setiap version didispatch secara independen.
5. Source receipt confirmation dan destination receipt confirmation adalah state terpisah.

## Inventaris integrasi backend stale

| Integrasi stale                                                    | Active call site/artifact                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Holešky chain/RPC                                                  | `src/documents/documents.service.ts` import/config/client/read; `.env.example`; `docs/api-doc.md` |
| Base Sepolia chain/RPC                                             | `src/documents/documents.service.ts` import/config/client/read; `.env.example`; `docs/api-doc.md` |
| Selector lama `10344971235874465080`                               | `src/documents/documents.service.ts`                                                              |
| Sender address lama `0x50D1672685E594B27F298Ac5bFACa4F3488AAA9c`   | `src/documents/documents.service.ts`                                                              |
| Receiver address lama `0xf9532930b61c0ddfed3b758582cb21c1cd8c2fd1` | `src/documents/documents.service.ts`                                                              |
| `addDocument(...)`                                                 | `src/documents/documents.service.ts`; `src/contracts/abis/EtherdocSender.abi.ts`                  |
| `documentExists(string)`                                           | `src/documents/documents.service.ts`; kedua ABI manual                                            |
| ABI manual lama                                                    | `src/contracts/abis/EtherdocSender.abi.ts`, `src/contracts/abis/EtherdocReceiver.abi.ts`          |
| CID-only route/identity                                            | `GET /documents/:documentCID`, `getDocumentByCid`, upload/search flow, DTO, dan `docs/api-doc.md` |
| Legacy response                                                    | `isExistEthereum`, `isExistBase` pada DTO/service/docs                                            |

Semua item di atas harus dihapus dari active code setelah generated contract artifacts, typed
configuration, client, intent state machine, dan breaking Documents API siap menggantikannya.
