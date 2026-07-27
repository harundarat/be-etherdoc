# Etherdoc Operations and Recovery Runbook

This runbook covers the Ethereum Sepolia → Mantle Sepolia release. Mainnet and extra destinations
are out of scope.

## Roles and secrets

| Identity       | On-chain responsibility              | Secret policy                                |
| -------------- | ------------------------------------ | -------------------------------------------- |
| Admin wallet   | deployer, governance, pauser         | encrypted Foundry account or hardware wallet |
| Backend wallet | sender operator and `*BySig` relayer | runtime secret/managed signer                |
| User wallet    | issuer and EIP-712 signer            | user-controlled only                         |

Never reuse the admin wallet as the routine backend signer. Never send a user private key to the
API. Commands and incident notes may contain public addresses and transaction hashes, but not
private keys, mnemonics, raw keystores, bearer JWTs, or Pinata credentials.

## Deployment registry

`sc-etherdoc/deployments/testnet` is the intended source for sender/receiver address, creation
transaction, deployment block/hash, runtime code hash, constructor arguments, and contract commit.
The backend artifact generator imports that registry and rejects drift.

The active manifests are imported into the generated backend artifact. Address and deployment-block
environment overrides are now optional; startup rejects any address override that conflicts with
the generated registry.

The completed deployment approval and receipt evidence are recorded in
[testnet-deployment-preflight.md](testnet-deployment-preflight.md). A separate explicit approval is
required before broadcasting lifecycle smoke-test transactions.

## Required environment

| Area                | Variables                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database            | `DATABASE_URL`, `DATABASE_STATEMENT_TIMEOUT_MS`                                                                                                                                                                            |
| HTTP edge           | `CORS_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY_HOPS`, `API_REPLICA_COUNT`, `HEALTH_READINESS_CACHE_MS`                                                                                                                       |
| Operations          | `OPERATIONS_TOKEN`                                                                                                                                                                                                         |
| Rate limits         | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_API_REQUESTS`, `RATE_LIMIT_AUTH_REQUESTS`, `RATE_LIMIT_SEARCH_REQUESTS`, `RATE_LIMIT_UPLOAD_REQUESTS`                                                                                  |
| Source RPC          | `ETHEREUM_SEPOLIA_RPC_URL`, `ETHEREUM_CONFIRMATION_DEPTH`                                                                                                                                                                  |
| Destination RPC     | `MANTLE_SEPOLIA_RPC_URL`, `MANTLE_CONFIRMATION_DEPTH`                                                                                                                                                                      |
| Deployment override | `ETHERDOC_SENDER_ADDRESS`, `ETHERDOC_SENDER_DEPLOYMENT_BLOCK`, `ETHERDOC_RECEIVER_ADDRESS`, `ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK`                                                                                           |
| Signer              | `BACKEND_PRIVATE_KEY`                                                                                                                                                                                                      |
| SIWE/JWT            | `SIWE_DOMAIN`, `SIWE_URI`, `SIWE_NONCE_TTL_SECONDS`, `SIWE_SESSION_TTL_SECONDS`, `JWT_SECRET`                                                                                                                              |
| Auth retention      | `AUTH_NONCE_RETENTION_SECONDS`, `AUTH_NONCE_CLEANUP_INTERVAL_SECONDS`, `AUTH_NONCE_CLEANUP_BATCH_SIZE`                                                                                                                     |
| Pinata              | `PINATA_API_URL`, `PINATA_UPLOAD_URL`, `PINATA_GATEWAY_URL`, `PINATA_JWT_TOKEN`                                                                                                                                            |
| Dispatch            | `DISPATCH_FEE_BUFFER_BPS`, `MAXIMUM_DISPATCH_FEE_WEI`, `CCIP_RECOVERY_AFTER_SECONDS`                                                                                                                                       |
| Workers             | `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_LOCK_TIMEOUT_MS`, `OUTBOX_HEARTBEAT_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS*`, `WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS`, `CHAIN_INDEX_BLOCK_RANGE`, `CHAIN_INDEX_INTERVAL_MS` |

Inject secrets at runtime. Restrict `.env` to local development and keep it untracked.
`SIWE_SESSION_TTL_SECONDS` is the only session lifetime: changing it changes the JWT expiry, cookie
`Max-Age`, and API response together.

Production and CI use Node 24 LTS; `.nvmrc` pins 24.14.1, `package.json` requires the Node 24 major,
and pnpm is fixed at 10.34.5. Build and install the deployment artifact with those committed
versions. PostgreSQL 16 is the supported database baseline.

`DATABASE_STATEMENT_TIMEOUT_MS` defaults to 15 seconds and applies only to PostgreSQL statements.
`RPC_REQUEST_TIMEOUT_MS` defaults to 15 seconds and applies only to blockchain requests. Keep them
separate when tuning an incident so a slow provider cannot silently lengthen database lock/query
exposure, or vice versa.

Consumed and expired SIWE nonces are retained for `AUTH_NONCE_RETENTION_SECONDS` (seven days by
default) and then removed in bounded, lock-skipping batches. One cleanup runs per configured
interval and overlapping runs are skipped. Keep the retention period long enough for incident
review; monitor cleanup errors and table growth rather than manually truncating authentication
evidence.

## HTTP security and proxy topology

Helmet is installed before cookie parsing and CORS middleware. `CORS_ORIGIN` is one exact HTTP(S)
origin without a path. Production HTTPS deployments must set `COOKIE_SECURE=true`; local plain HTTP
development uses `false`. Cookie sessions always use `Path=/`, `HttpOnly`, and `SameSite=Lax`.

Cookie-authenticated state changes require an exact `Origin: <CORS_ORIGIN>`. Bearer-authenticated
requests are exempt because JavaScript cannot attach an ambient bearer credential cross-site.
Investigate repeated `CSRF_ORIGIN_REJECTED` responses as client misconfiguration or possible abuse;
do not work around them by broadening CORS.

The default limiter store is process memory and is approved only for `API_REPLICA_COUNT=1`; startup
rejects a larger declared count. Deploy a shared limiter store and test cross-replica behavior
before scaling the API horizontally. Configure `TRUST_PROXY_HOPS` only to the exact number of known,
trusted reverse-proxy hops, and prevent clients from connecting directly to the application port.
Leave it at `0` when there is no trusted proxy. This keeps untrusted `X-Forwarded-For` values from
becoming limiter identities.

The Pinata groups/files API is intentionally a shared authenticated workspace. Any authenticated
wallet can list files/groups and create groups in the configured Pinata account. Do not describe
this deployment as tenant-isolated or place mutually untrusted tenants in one instance. A
wallet-owned model requires a schema migration and endpoint-level ownership enforcement before it
can be advertised or relied upon.

## Health, diagnostics, and logging

Use `/health/live` only for process liveness. It intentionally performs no dependency calls, so a
database or RPC incident must not trigger an automatic restart loop. Use `/health/ready` for
load-balancer membership. It returns `503` when PostgreSQL/schema is unavailable, blockchain
startup readiness has not completed, or graceful shutdown has started. Keep
`HEALTH_READINESS_CACHE_MS` short; the allowed range is 100–60,000 ms and the default is 5,000 ms.

`/health/status` is an operator endpoint. Store its independently generated, minimum 32-character
`OPERATIONS_TOKEN` in the runtime secret manager and send it only as a bearer token from trusted
operator tooling. Do not reuse `JWT_SECRET`, a user JWT, or a Pinata token. Rotate it by updating
the secret and restarting instances; never place it in URLs, dashboards, screenshots, or incident
notes.

The status response is the first diagnostic for delayed work:

1. compare source/destination `lagBlocks` and `lastSuccessfulTickAt`;
2. inspect READY/RUNNING/FAILED counts per job type and `oldestReadyAgeSeconds`;
3. alert immediately on nonzero `expiredLeases`, new recent failed jobs, or recovery-required
   dispatches;
4. correlate the returned intent/dispatch/job ID with structured logs and canonical chain evidence.

Each response carries `X-Request-ID`. Logs use `correlationId` and propagate the accepted signature
request ID into the initial outbox job. Worker records include `jobId`, `jobType`, `attempt`,
`intentId`/`dispatchId`, a one-way 12-character `leaseFingerprint`, duration, transition, and error
classification. External request logs identify only `rpc`/`pinata`, logical operation/chain,
duration, status, and failure classification; they deliberately omit URLs, headers, bodies, signed
messages, signatures, JWTs, and provider tokens. Sanitized stack traces remain in error logs.

Recommended alerts:

- readiness remains `503` longer than one cache interval outside a deployment;
- no successful indexer tick for two `CHAIN_INDEX_INTERVAL_MS` periods;
- cursor lag increases across two consecutive observations;
- any expired lease, FAILED job, retry exhaustion, or `RECOVERY_REQUIRED` transition;
- sustained RPC/Pinata timeout, network, or HTTP failure classification;
- shutdown drain timeout.

## Upload memory budget

Document uploads use Multer memory storage with a hard 5 MiB per-file parser limit, one file per
request, and bounded multipart fields/parts. Pinata upload construction and fetch-back verification
can temporarily hold roughly three document-sized buffers per active preparation (about 15 MiB plus
runtime overhead). The current single-replica operating target is at most eight concurrent document
preparations, or about 120 MiB of document-body residency within a container sized to at least
512 MiB. Enforce that concurrency at the ingress. Before raising either the file limit or
concurrency, move the flow to streaming or disk-backed temporary storage and remeasure peak RSS.
Pinata artifact fetch-back is independently capped at 5 MiB and Pinata upload/metadata JSON
responses at 1 MiB. The backend checks `Content-Length` when present and still counts streamed bytes.
Treat `STORAGE_*_TOO_LARGE` as a provider/policy mismatch; do not retry indefinitely before checking
the configured limits and provider response.

## Worker leases, retries, and shutdown

Every outbox claim receives a fresh UUID lease token. Completion, retry, terminal failure, and
heartbeat updates require both the job ID and current token. A stale owner therefore cannot change
a job reclaimed by another worker. The worker claims one active job at a time, up to
`OUTBOX_BATCH_SIZE` jobs per tick, so a claimed job is never left waiting without a heartbeat.

`OUTBOX_HEARTBEAT_INTERVAL_MS` must be lower than `OUTBOX_LOCK_TIMEOUT_MS`; startup rejects an
invalid pair. Expired leases are reclaimed in bounded, lock-skipping batches at startup and during
normal polling. A healthy heartbeat prevents reclaim. Retry delay is exponential with up to 25%
jitter and a five-minute ceiling.

`OUTBOX_MAX_ATTEMPTS` defaults to eight. The following optional variables override it per job type:

- `OUTBOX_MAX_ATTEMPTS_SUBMIT_SOURCE`;
- `OUTBOX_MAX_ATTEMPTS_CONFIRM_SOURCE`;
- `OUTBOX_MAX_ATTEMPTS_DISPATCH_DESTINATION`;
- `OUTBOX_MAX_ATTEMPTS_TRACK_DESTINATION`;
- `OUTBOX_MAX_ATTEMPTS_RECONCILE`.

Exhaustion moves the job to `FAILED`, preserves an actionable `last_error`, and emits an error log.
A dispatch entering `RECOVERY_REQUIRED` also emits an error log with its dispatch ID and failure
code. Alert on either transition.

On `SIGTERM`, the application stops scheduling and claiming work, then waits up to
`WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS` for the active outbox/indexer tick. The database pool closes only
after module destroy hooks finish. Configure the orchestrator termination grace period above the
drain timeout with enough margin for Nest shutdown. If draining times out, the service logs the
active scheduler context and exits without marking the outbox job complete; its lease is reclaimed
after `OUTBOX_LOCK_TIMEOUT_MS`.

### Recovering a failed job

1. Record the job ID, job type, attempt count, payload identifiers, `last_error`, and related
   intent/source-transaction/dispatch state. Do not copy secrets into incident notes.
2. For `SUBMIT_SOURCE` or `DISPATCH_DESTINATION`, first determine whether a signer nonce was
   reserved or consumed and search canonical events/receipts. Never reset or resend an uncertain
   broadcast merely because its outbox job is `FAILED`.
3. Run `pnpm reconcile` in dry-run mode. Prefer `pnpm reconcile --enqueue` only after its candidates
   match the reviewed canonical evidence.
4. For read-only confirmation/tracking or a proven pre-broadcast failure, an operator may reset the
   exact reviewed job to `READY` in a transaction. Clear `locked_at`, `locked_by`, `lease_token`,
   and `last_error`, set `available_at = now()`, and reset `attempt_count` only when explicitly
   authorizing a fresh retry budget. Never bulk-reset `FAILED` jobs.
5. Monitor the job, related protocol state, signer nonce, canonical cursor, and error logs until it
   reaches a justified terminal state.

## State machines

Intent:

```text
PREPARED -> SIGNED -> SOURCE_PENDING -> SOURCE_CONFIRMED
                    \-> FAILED_RETRYABLE
                    \-> FAILED_TERMINAL
```

Dispatch:

```text
PENDING -> SOURCE_ACCEPTED -> DESTINATION_CONFIRMED
                           \-> DESTINATION_IGNORED
         \-------------------> RECOVERY_REQUIRED
```

`SOURCE_CONFIRMED` requires a successful finalized source receipt and canonical lifecycle event.
`SOURCE_ACCEPTED` requires finalized `MessageSent`. `DESTINATION_CONFIRMED` requires finalized
receiver evidence plus `getProcessedMessage`, `getReceipt`, and `verifyDocument` consistency.

## EIP-712 client flow

1. Request and sign the exact SIWE message.
2. Prepare an intent with an idempotency key unique to the canonical request.
3. Display chain ID `11155111`, sender address, operation, document IDs, version, nonce, and deadline
   to
   the user.
4. Sign the returned typed data without reconstructing or coercing numeric fields.
5. Submit only the signature.
6. Poll intent status, then read the canonical document and per-destination evidence.

Wrong chain, sender, issuer, nonce, document version, or deadline must be treated as a client error;
never ask for the user private key.

## Routine reconciliation

The event indexers scan from deployment blocks to the confirmation-adjusted head, persist one cursor
per contract, and compare the stored cursor block hash on every pass. Replays are idempotent.

Preview recovery candidates:

```bash
pnpm reconcile
```

After checking RPC health, signer state, contract pause/role state, and the affected rows:

```bash
pnpm reconcile --enqueue
```

The command enqueues, without duplicating:

- source transactions with unknown broadcast outcome;
- dispatches in `RECOVERY_REQUIRED`;
- accepted source messages still needing destination tracking.

Running it repeatedly is safe. It never broadcasts by itself; normal workers still simulate and
apply nonce/evidence checks.

## Unknown source transaction

1. Locate `source_transaction.state = UNKNOWN`, its reserved signer nonce, intent, and timestamps.
2. Search finalized source lifecycle events from the sender deployment block.
3. Accept a recovered transaction only when its sender and nonce equal the reservation and its
   canonical event matches the exact operation/document.
4. If the latest signer nonce has not passed the reservation, leave it retryable.
5. If the nonce was consumed without matching canonical evidence, keep it terminal/manual. Never
   submit another transaction with a guessed nonce.

## Unknown dispatch or delayed CCIP

1. Search finalized `MessageSent` by document ID, version, destination selector, and receiver.
2. Compare `getDispatchAtVersion`; if it matches, recover the transaction/message ID and track the
   destination. Do not dispatch again.
3. If no event exists and the reserved nonce was consumed, require manual recovery.
4. For source-accepted messages, inspect CCIP Explorer/Router state and receiver pause/trusted-remote
   configuration.
5. `MessageIgnored` is a valid terminal replication outcome for a duplicate/stale delivery; it is
   not `DESTINATION_CONFIRMED`.
6. A processed message without matching finalized receiver evidence remains
   `RECOVERY_REQUIRED`.

Check LINK balance on the sender, native gas on the backend operator, allowlisted destination,
configured receiver, fee policy, and pause state before retrying a pre-broadcast failure.

## Reorg response

When a cursor block hash changes, the indexer:

1. marks prior contract events non-canonical;
2. resets the cursor to the deployment block;
3. rebuilds source projections from canonical events and contract reads;
4. downgrades affected destination evidence;
5. re-enqueues only unresolved dispatch/reconciliation work.

Do not manually edit a cursor to skip blocks. If an RPC provider serves inconsistent history, stop
workers, switch to a verified RPC endpoint, retain the database for audit, and let the deployment
block replay finish.

## Backend rollback

1. Stop API/worker instances so no mixed version claims jobs.
2. Preserve a PostgreSQL snapshot and current logs.
3. Roll back application code only to a version compatible with the same generated contract
   artifact and migrations. Migrations are forward-only; do not delete schema/data to fit old code.
4. Start one instance, verify readiness and `pnpm contracts:check`, then allow reconciliation to
   finish.
5. Scale out only after source/destination cursors and outbox depth stabilize.

Contract rollback means deploying new audited contracts and updating a new manifest through the
contract governance/deployment process. Do not overwrite a manifest or point the backend at an
unverified address.

Migration `006_outbox_lease.sql` adds a nullable column and is schema-readable by the prior
application, but mixed old/new workers are not ownership-safe because the old binary does not match
lease tokens on updates. Deploy this phase stop-the-world:

1. send `SIGTERM` to every API/worker instance and allow the configured drain period;
2. confirm no application instance remains, preserving timed-out `RUNNING` jobs for lease reclaim;
3. apply `pnpm db:migrate`;
4. deploy the new application to one instance and verify migration inventory, lease reclaim, and
   error logs;
5. add instances only after heartbeat and outbox state remain stable.

Do not roll the application back to a pre-lease binary while workers are active. If rollback is
unavoidable, stop every instance first and treat it as a separate compatibility incident.

## Cutover checks

```bash
pnpm contracts:check
pnpm typecheck
pnpm lint:check
pnpm test:coverage
pnpm test:e2e
pnpm test:integration
pnpm build
pnpm audit:prod
pnpm reconcile
```

Then verify:

- generated registry bytecode hashes and live chain IDs;
- admin/backend/user roles are separated and approved;
- backend native gas and sender LINK funding;
- no paused component or untrusted remote;
- outbox has no unexpected `RUNNING`/`FAILED` backlog;
- source and destination cursors are at finalized heads;
- one smoke document can be traced by intent ID, document ID, source transaction, CCIP message ID,
  and destination transaction.

The live lifecycle smoke test and clean-database reconciliation completed on 26 July 2026. Use the
transaction, CCIP message, and projection evidence in
[testnet-deployment-preflight.md](testnet-deployment-preflight.md) as the cutover baseline.
