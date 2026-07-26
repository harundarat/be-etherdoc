# Local Readiness Audit

Audit date: 26 July 2026.

## Revisions

- Backend deployment-registry commit:
  `1ed5d51aa80d365a96af598056afadfcddcb0f61`
- Contract baseline: `b132bf4360108db00959fc5aa75009a12283ed69`
- Generated backend contract artifact provenance matches the contract baseline and records Ethereum
  Sepolia as canonical source with Mantle Sepolia as destination.

The backend and contract worktrees are clean. The old untracked `soljson-latest.js` was deleted on
26 July 2026 after explicit owner approval; it was never part of the contract baseline.

## Backend gates

| Gate                                                   | Result                           |
| ------------------------------------------------------ | -------------------------------- |
| `pnpm contracts:check`                                 | pass                             |
| `pnpm lint:check`                                      | pass, no write                   |
| `pnpm test --runInBand`                                | pass: 15 suites, 66 tests        |
| `pnpm test:e2e`                                        | pass: 4 deterministic HTTP tests |
| `pnpm test:integration`                                | pass: 5 PostgreSQL 16 tests      |
| migrations applied twice to clean PostgreSQL 16        | pass, 4 migrations               |
| `pnpm build`                                           | pass                             |
| `pnpm reconcile`                                       | pass in dry-run mode             |
| repeated `pnpm reconcile --enqueue` on an empty schema | pass, no duplicate work          |

The PostgreSQL integration suite covers migration inventory, idempotency/nonce uniqueness,
concurrent `SKIP LOCKED` claims, expired worker-lease recovery, chain-event replay, and
reconciliation-job deduplication.

## Contract gates

The Foundry results and live read-only network preflight are recorded in
[testnet-deployment-preflight.md](testnet-deployment-preflight.md). Build, lint, tests, coverage,
contract size, gas snapshot, dry run, and the exact clean-source deployment workflow pass.

## Legacy and secret scan

Active source, README, API documentation, runbook, example environment, scripts, CI, and tests were
searched for the removed network/API names and responses. The only active-source match is a
negative ABI regression assertion proving the removed function is absent.

No tracked runtime `.env` exists. Secret-shaped tracked values are deterministic unit-test fixtures
and digest vectors; no runtime key, mnemonic, JWT, Pinata token, or encrypted keystore was added.
No private key was copied from the old backend environment, contract workspace, or wallet tooling.

## Remaining release blockers

Deployment, configuration, funding, registry synchronization, and source verification are complete.
The encrypted user issuer signer has also been validated. The remaining external step is explicit
approval for the seven-transaction lifecycle smoke test using the user issuer and backend operator,
followed by final backend reconciliation.

The admin, backend operator, and user issuer are distinct and funded for their intended chain
actions. The backend operator holds only `OPERATOR`; the four approved deployment transactions and
their receipts are recorded in the deployment preflight.
