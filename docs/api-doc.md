# Etherdoc API

The source contract on Ethereum Sepolia is canonical. PostgreSQL is a rebuildable projection,
Mantle Sepolia is a CCIP replica, and Pinata availability is reported independently from
authenticity.

All addresses use EIP-55-compatible EVM address syntax. `documentId`, digests, commitments, message
IDs, and transaction hashes are 32-byte `0x`-prefixed hex values.

## Authentication

### `POST /auth/nonce`

Creates a one-use, expiring SIWE challenge for one wallet.

```json
{
  "address": "0x1234567890123456789012345678901234567890"
}
```

The response contains the exact `message` to sign and its expiration. It is bound to the configured
domain, URI, Ethereum Sepolia chain ID, wallet, nonce, issued-at, and expiration.

### `POST /auth/verify`

```json
{
  "message": "<exact SIWE message returned by /auth/nonce>",
  "signature": "0x..."
}
```

Successful verification atomically consumes the nonce and returns:

```json
{
  "accessToken": "<JWT>",
  "address": "0x1234567890123456789012345678901234567890",
  "expiresInSeconds": 900
}
```

The response also sets the HTTP-only `etherdoc-auth` cookie. Protected endpoints accept that cookie
or `Authorization: Bearer <JWT>`. The JWT subject must equal the intent issuer. JWT expiry, cookie
`Max-Age`, and `expiresInSeconds` all use the configured numeric `SIWE_SESSION_TTL_SECONDS`; there is
no separate JWT duration setting.

Nonce replay evidence is retained for a bounded operational window. Signature verification,
including ERC-1271 RPC verification, happens without holding a database transaction; a final
conditional update ensures concurrent valid submissions can create only one session.

The cookie uses `Path=/`, `HttpOnly`, `SameSite=Lax`, and the explicitly configured `Secure` mode.
For every cookie-authenticated `POST`, `PUT`, `PATCH`, or `DELETE`, clients must send an `Origin`
header exactly equal to `CORS_ORIGIN`; otherwise the API returns `403 CSRF_ORIGIN_REJECTED`.
Requests that explicitly authenticate with `Authorization: Bearer <JWT>` use the bearer token in
preference to any cookie and are exempt from this browser-cookie CSRF check.

## Request rate limits

The default one-minute limits are 120 requests per API route, 5 per authentication route, 30
non-multipart document searches, and 8 multipart uploads. Authentication is counted independently
by client IP and wallet address. JSON searches with an issuer are also counted by IP and wallet;
multipart uploads are counted by client IP before their body is buffered. Exceeding a limit returns
`429` with `message: "RATE_LIMIT_EXCEEDED"` and a limiter-specific `Retry-After` header.

## Signed intent flow

An accepted signature is not final success. Prepare endpoints return exact EIP-712 typed data;
clients must sign it without modifying field types, ordering, chain ID, verifying contract, nonce,
version, or deadline.

### `POST /documents/intents/register`

Authentication required. `multipart/form-data`, PDF magic bytes required, maximum 5 MiB inclusive.
The multipart parser accepts one file and rejects a body with more than eight text fields or nine
total parts.

| Field            | Required | Meaning                                        |
| ---------------- | -------- | ---------------------------------------------- |
| `file`           | yes      | Exact bytes whose SHA-256 digest is registered |
| `issuer`         | yes      | Must equal JWT subject                         |
| `idempotencyKey` | yes      | 8–128 characters                               |
| `storageNetwork` | yes      | `public` or `private`                          |
| `documentType`   | no       | Non-PII canonical metadata label               |

The backend uploads, retrieves, and hashes the exact bytes, validates the actual CID, builds the
metadata commitment, compares its EIP-712 digest with the contract getter, and returns a `PREPARED`
intent.

### `POST /documents/intents/revoke`

Authentication required.

```json
{
  "issuer": "0x1234567890123456789012345678901234567890",
  "idempotencyKey": "revoke-document-2026-01",
  "documentId": "0x..."
}
```

The source record must exist, be `ACTIVE`, and belong to the JWT subject. The current source version
is embedded in the typed data.

### `POST /documents/intents/supersede`

Authentication required. Uses the register multipart fields plus:

```text
oldDocumentId=0x...
```

The old record becomes `SUPERSEDED`; a new document identity is derived from the replacement bytes
and issuer.

### Intent response

Prepare and status endpoints return:

```json
{
  "id": "uuid",
  "idempotencyKey": "client-key",
  "operation": "REGISTER",
  "status": "PREPARED",
  "issuer": "0x...",
  "documentId": "0x...",
  "oldDocumentId": null,
  "chainNonce": "4",
  "deadline": "2026-07-25T12:00:00.000Z",
  "typedData": {},
  "typedDataDigest": "0x...",
  "failure": null,
  "createdAt": "2026-07-25T11:50:00.000Z",
  "updatedAt": "2026-07-25T11:50:00.000Z"
}
```

Intent states are `PREPARED`, `SIGNED`, `SOURCE_PENDING`, `SOURCE_CONFIRMED`,
`FAILED_RETRYABLE`, and `FAILED_TERMINAL`.

### `POST /documents/intents/:intentId/signature`

Authentication required. `intentId` must be a UUID v4; malformed values return `400` before any
database query.

```json
{
  "signature": "0x..."
}
```

Returns `202 Accepted` only after EOA/ERC-1271 verification and durable outbox enqueue. The worker
simulates and submits the matching `*BySig` call. Poll the intent; do not interpret `202` as chain
confirmation.

### `GET /documents/intents/:intentId`

Authentication required. Only the issuer can read the intent.

## Canonical verification

### `GET /documents/:documentId`

Public canonical read. Returns the current source record even when it is revoked or superseded.

```json
{
  "canonicalSource": true,
  "document": {
    "documentId": "0x...",
    "contentDigest": "0x...",
    "cid": "b...",
    "cidCodec": 85,
    "cidDigest": "0x...",
    "metadataCommitment": "0x...",
    "issuer": "0x...",
    "sourceChainId": "11155111",
    "registeredAt": "2026-07-25T10:00:00.000Z",
    "updatedAt": "2026-07-25T10:05:00.000Z",
    "schemaVersion": 1,
    "version": "2",
    "status": "REVOKED",
    "supersedes": null,
    "supersededBy": null
  },
  "integrity": {
    "matches": true,
    "active": false,
    "contentMatches": true,
    "issuerMatches": true
  },
  "source": {
    "confirmationStatus": "CONFIRMED",
    "transactionHash": "0x...",
    "blockNumber": "123",
    "blockHash": "0x..."
  },
  "storage": {
    "status": "AVAILABLE",
    "available": true,
    "authenticity": "NOT_INFERRED_FROM_AVAILABILITY"
  },
  "destinations": []
}
```

Each destination entry includes indexed status, effective evidence status, source dispatch
transaction/block, CCIP message ID, fee/gas data, destination transaction/block, processed-message
state, receipt state, and receiver provenance/integrity checks.

`SOURCE_ACCEPTED` means the source Router accepted the message. It does not mean the receiver
confirmed it. Destination states are `PENDING`, `SOURCE_ACCEPTED`, `DESTINATION_CONFIRMED`,
`DESTINATION_IGNORED`, and `RECOVERY_REQUIRED`. Read-time `EVIDENCE_MISMATCH` or
`EVIDENCE_UNAVAILABLE` prevents stale indexed success from being presented as verified replication.

### `POST /documents/search`

Public verification using either:

```json
{
  "documentId": "0x..."
}
```

or `multipart/form-data` with a PDF `file` and `issuer`. With a file, the backend recomputes SHA-256
over the exact bytes and derives `documentId`. If an explicit ID is also supplied it must match the
derived ID. The response is the same canonical read model; a CID’s availability alone never passes
verification.

## Pinata metadata endpoints

These protected endpoints manage storage metadata only and do not change protocol lifecycle:

- `GET /documents?network=public|private&groupId=<optional>`
- `GET /documents/groups?network=public|private`
- `POST /documents/groups` with `{ "network": "public", "groupName": "..." }`

`groupName` and `groupId` are limited to 128 characters.

### Pinata workspace authorization decision

The product decision for Phase 3 is **shared workspace**. Every authenticated wallet can list files
and groups and create groups in the same configured Pinata account. These endpoints are not
wallet-owned or tenant-isolated, and callers must not use a successful JWT as evidence that a group
or file belongs to its subject. Moving to wallet ownership requires a forward-only ownership
migration and authorization checks on every list/create/read path.

## Error semantics

|  HTTP | Example meaning                                                       |
| ----: | --------------------------------------------------------------------- |
| `400` | malformed input or multipart field/part limits exceeded               |
| `401` | missing/invalid session or SIWE signature                             |
| `403` | JWT subject differs from issuer or issuer not authorized              |
| `404` | document/intent not found                                             |
| `409` | stale nonce/version, inactive record, conflicting idempotency input   |
| `413` | multipart PDF exceeds the 5 MiB parser limit (`File too large`)       |
| `422` | invalid PDF magic bytes, signature, CID, digest, or commitment        |
| `429` | configured API, auth, search, or multipart upload rate limit exceeded |
| `503` | source RPC, destination RPC, storage, or readiness unavailable        |

RPC failures are never converted to “document not found.” Storage failure is never converted to
“inauthentic.” Pinata fetch-back bodies are limited to 5 MiB and Pinata JSON bodies to 1 MiB;
oversized, invalid, timed-out, or interrupted provider responses return a stable storage `503` and
are cancelled. Destination failure never changes canonical source lifecycle.
