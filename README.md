# Etherdoc Backend

NestJS backend for Etherdoc’s signed document lifecycle. The canonical source is
`EtherdocSender` on Mantle Sepolia; `EtherdocReceiver` on Ink Sepolia is a replicated view delivered
through Chainlink CCIP.

The backend never treats PostgreSQL, Pinata, or the destination contract as stronger evidence than
the source contract. Document identity is:

```text
contentDigest = sha256(exact file bytes)
documentId = keccak256(abi.encode(issuer, contentDigest))
```

Contract ABI, network configuration, protocol constants, and deployment registry are generated
from `sc-etherdoc` commit `175b902733794f9466ef73dc97f69a074b4b80c8`.

## Current deployment status

The baseline contracts are not yet deployed to testnet, so the backend requires validated sender
and receiver address/block overrides. Deployment is blocked until the wallet, funding, clean
worktree, and explicit broadcast approval requirements in
[testnet-deployment-preflight.md](docs/testnet-deployment-preflight.md) are satisfied.

## Requirements

- Node.js 22
- pnpm 10
- PostgreSQL 16
- access to Mantle Sepolia and Ink Sepolia RPC endpoints
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

Startup validates configuration, RPC chain IDs, deployed bytecode, Router/LINK bindings, trusted
remote configuration, and backend signer roles. A mismatch stops the application.

## Commands

```bash
pnpm contracts:check       # reject drift from the exact contract baseline
pnpm db:migrate            # checksum-protected, advisory-locked migrations
pnpm lint:check            # read-only lint gate
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

## API and operations

- [API reference](docs/api-doc.md)
- [Operations and recovery runbook](docs/operations-runbook.md)
- [Local readiness audit and remaining blockers](docs/local-readiness-audit.md)
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

## License

Private project (`UNLICENSED`).
