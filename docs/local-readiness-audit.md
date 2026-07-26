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

The final post-deployment rerun passed 116 tests with no failures or skips, including both live fork
checks. Coverage remained 100% for lines, statements, branches, and functions. A test-only contract
commit now permits the network-config suite to run with active local manifests; backend artifact
provenance remains pinned to deployed source commit `b132bf4360108db00959fc5aa75009a12283ed69` and
rejects any later change to contract, dependency, compiler, or network inputs without new manifests.

## Legacy and secret scan

Active source, README, API documentation, runbook, example environment, scripts, CI, and tests were
searched for the removed network/API names and responses. The only active-source match is a
negative ABI regression assertion proving the removed function is absent.

No tracked runtime `.env` exists. Secret-shaped tracked values are deterministic unit-test fixtures
and digest vectors; no runtime key, mnemonic, JWT, Pinata token, or encrypted keystore was added.
No private key was copied from the old backend environment, contract workspace, or wallet tooling.

## Live lifecycle and reconciliation

Deployment, configuration, funding, registry synchronization, source verification, lifecycle smoke
test, and final reconciliation are complete. The seven separately approved source transactions and
all four CCIP messages succeeded. The original document reached `SUPERSEDED`; its replacement
reached `REVOKED`; source and destination verification remained consistent.

A clean PostgreSQL 16 replay from the live deployment blocks produced 12 canonical events,
2 document projections, and 4 `DESTINATION_CONFIRMED` dispatches. All 4 tracking jobs completed with
no failure or READY backlog. The dry-run reconciliation and two repeated enqueue reconciliations
both found zero candidates and made zero changes.

There are no remaining release blockers in this synchronization scope. The admin, backend operator,
and user issuer remain distinct and funded for their intended chain actions; the backend operator
holds only `OPERATOR`. Full transaction, CCIP, and projection evidence is recorded in
[testnet-deployment-preflight.md](testnet-deployment-preflight.md).
