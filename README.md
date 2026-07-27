# Etherdoc Backend

NestJS backend for Etherdoc’s signed document lifecycle. The canonical source is
`EtherdocSender` on Ethereum Sepolia; `EtherdocReceiver` on Mantle Sepolia is a replicated view
delivered through Chainlink CCIP.

The backend never treats PostgreSQL, Pinata, or the destination contract as stronger evidence than
the source contract. Document identity is:

```text
contentDigest = sha256(exact file bytes)
documentId = keccak256(abi.encode(issuer, contentDigest))
```

Contract ABI, network configuration, protocol constants, and deployment registry are generated
from `sc-etherdoc` commit `b132bf4360108db00959fc5aa75009a12283ed69`.

## Current deployment status

The baseline contracts are deployed and configured:

- Ethereum Sepolia sender: `0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7`, block `11354109`;
- Mantle Sepolia receiver: `0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7`, block `41758817`.

The same address on both chains is expected because the admin deployed from nonce `0` on each
chain. The generated deployment registry is canonical, so address/block environment overrides are
optional and must match the registry when supplied. Receipt and verification evidence is recorded
in [testnet-deployment-preflight.md](docs/testnet-deployment-preflight.md).

The approved live lifecycle smoke test is also complete: register, supersede, revoke, and four CCIP
dispatches were confirmed on both chains. A clean PostgreSQL replay reconstructed 12 canonical
events, 2 final document projections, and 4 destination-confirmed dispatches with no recovery
backlog.

## Requirements

- Node.js 22 or 24 LTS
- pnpm 10.34.5 (pinned by `packageManager`)
- PostgreSQL 16
- access to Ethereum Sepolia and Mantle Sepolia RPC endpoints
- Pinata credentials
- a backend signer authorized as sender `OPERATOR` and used to submit permissionless `*BySig` calls

Do not put user, admin, or production signer private keys in Git. `BACKEND_PRIVATE_KEY` is only for
controlled local/testnet runtime; production should inject a managed signer secret.

## Setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm start:dev
```

Fill every required value in `.env`. Until deployment manifests exist, set:

```text
ETHERDOC_SENDER_ADDRESS
ETHERDOC_SENDER_DEPLOYMENT_BLOCK
ETHERDOC_RECEIVER_ADDRESS
ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK
```

Use `COOKIE_SECURE=false` only for local HTTP development. Deployed HTTPS environments must set it
to `true`.

Startup validates configuration, RPC chain IDs, deployed bytecode, Router/LINK bindings, trusted
remote configuration, and backend signer roles. A mismatch stops the application.

## Commands

```bash
pnpm contracts:check       # reject drift from the exact contract baseline
pnpm db:migrate            # checksum-protected, advisory-locked migrations
pnpm lint:check            # read-only lint gate
pnpm audit:prod            # production dependency vulnerability gate
pnpm check                 # deterministic local quality sequence
pnpm test --runInBand      # unit tests
pnpm test:e2e              # deterministic in-memory HTTP tests
pnpm test:integration      # requires DATABASE_URL pointing at a test database
pnpm build
pnpm reconcile             # read-only reconciliation candidate count
pnpm reconcile --enqueue   # idempotently enqueue recovery work
```

`pnpm reconcile` is dry-run by default. Review the candidate counts and the recovery runbook before
using `--enqueue`.

## Architecture

```text
User wallet ── SIWE ──> API ── PostgreSQL intent/outbox
     │                    │
     └─ EIP-712 signature ┴─> backend relayer ──> EtherdocSender (canonical)
                                                    │
                                              MessageSent / CCIP
                                                    │
                                                    v
                                             EtherdocReceiver

Pinata stores exact bytes and metadata preimages; it does not determine authenticity.
Finalized event indexers rebuild PostgreSQL projections and detect reorgs by cursor block hash.
```

Source transaction confirmation and destination CCIP confirmation are separate states. Unknown
broadcast outcomes are reconciled by signer nonce plus canonical events and are never blindly
resent.

Outbox jobs use renewable ownership tokens. `SIGTERM` stops new indexer/outbox work, drains the
active operation before the database pool closes, and leaves a timed-out lease for safe expiry and
reclaim rather than reporting false completion. See the runbook before changing lease, heartbeat,
retry, or shutdown timing.

## API and operations

- [API reference](docs/api-doc.md)
- [Operations and recovery runbook](docs/operations-runbook.md)
- [Backend modernization implementation plan](docs/backend-modernization-plan.md)
- [Dependency risk register](docs/dependency-risk-register.md)
- [Local readiness audit](docs/local-readiness-audit.md)
- [Smart-contract compatibility baseline](docs/smart-contract-compatibility.md)
- [Synchronization checklist](docs/TODO-smart-contract-sync.md)

The primary API flow is:

1. `POST /auth/nonce`
2. sign the returned SIWE message
3. `POST /auth/verify`
4. prepare a register/revoke/supersede intent
5. sign the exact returned EIP-712 typed data
6. `POST /documents/intents/:intentId/signature`
7. poll the intent and canonical document read endpoints

The server accepts an `etherdoc-auth` HTTP-only cookie or bearer JWT for protected endpoints.
`SIWE_SESSION_TTL_SECONDS` is the single lifetime used by the JWT, cookie, and authentication
response. Cookie-authenticated mutations require the configured frontend `Origin`; explicit bearer
authentication is CSRF-exempt.

## License

Private project (`UNLICENSED`).
