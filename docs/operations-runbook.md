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

| Area                | Variables                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Database            | `DATABASE_URL`                                                                                                                   |
| Source RPC          | `ETHEREUM_SEPOLIA_RPC_URL`, `ETHEREUM_CONFIRMATION_DEPTH`                                                                        |
| Destination RPC     | `MANTLE_SEPOLIA_RPC_URL`, `MANTLE_CONFIRMATION_DEPTH`                                                                            |
| Deployment override | `ETHERDOC_SENDER_ADDRESS`, `ETHERDOC_SENDER_DEPLOYMENT_BLOCK`, `ETHERDOC_RECEIVER_ADDRESS`, `ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK` |
| Signer              | `BACKEND_PRIVATE_KEY`                                                                                                            |
| SIWE/JWT            | `SIWE_DOMAIN`, `SIWE_URI`, `SIWE_NONCE_TTL_SECONDS`, `SIWE_SESSION_TTL_SECONDS`, `JWT_SECRET`, `JWT_EXPIRES_IN`                  |
| Pinata              | `PINATA_API_URL`, `PINATA_UPLOAD_URL`, `PINATA_GATEWAY_URL`, `PINATA_JWT_TOKEN`                                                  |
| Dispatch            | `DISPATCH_FEE_BUFFER_BPS`, `MAXIMUM_DISPATCH_FEE_WEI`, `CCIP_RECOVERY_AFTER_SECONDS`                                             |
| Workers             | `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_LOCK_TIMEOUT_MS`, `CHAIN_INDEX_BLOCK_RANGE`, `CHAIN_INDEX_INTERVAL_MS`   |

Inject secrets at runtime. Restrict `.env` to local development and keep it untracked.

## Upload memory budget

Document uploads use Multer memory storage with a hard 5 MiB per-file parser limit, one file per
request, and bounded multipart fields/parts. Pinata upload construction and fetch-back verification
can temporarily hold roughly three document-sized buffers per active preparation (about 15 MiB plus
runtime overhead). The current single-replica operating target is at most eight concurrent document
preparations, or about 120 MiB of document-body residency within a container sized to at least
512 MiB. Enforce that concurrency at the ingress. Before raising either the file limit or
concurrency, move the flow to streaming or disk-backed temporary storage and remeasure peak RSS.

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

## Cutover checks

```bash
pnpm contracts:check
pnpm lint:check
pnpm test --runInBand
pnpm test:e2e
pnpm test:integration
pnpm build
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
