# Backend Modernization Implementation Plan

Plan date: 27 July 2026.

Status: implementation in progress; Phases 1 through 4 completed on 27 July 2026.

This document is the execution plan for an AI Coding Agent modernizing `be-etherdoc`. The work is
intended to improve dependency security, production safety, reliability, type safety, test depth,
and operability without rewriting the backend or changing its canonical protocol model.

## Outcome

The modernization is complete when:

- production dependencies have no known high or critical vulnerabilities;
- a production-only dependency install contains every runtime package;
- upload and remote-download size limits are enforced before unbounded memory is consumed;
- authentication endpoints are abuse-resistant and JWT/cookie lifetime uses one source of truth;
- workers stop gracefully and outbox leases cannot be completed by stale owners;
- stale jobs are reclaimed while the service is running and retries have a terminal policy;
- liveness and readiness endpoints represent actual service state;
- TypeScript safety and coverage improve without weakening existing checks;
- all unit, HTTP, PostgreSQL integration, build, migration, contract-drift, and reconciliation gates
  pass.

## Baseline

The baseline observed on 27 July 2026 is:

| Area                      | Baseline result                                                        |
| ------------------------- | ---------------------------------------------------------------------- |
| Framework                 | NestJS 11, Express 5, TypeScript 5, viem 2                             |
| `pnpm lint:check`         | pass                                                                   |
| unit tests                | pass: 15 suites, 66 tests                                              |
| deterministic HTTP tests  | pass: 1 suite, 4 tests                                                 |
| `pnpm build`              | pass                                                                   |
| `pnpm contracts:check`    | pass                                                                   |
| unit statement coverage   | 35.92%                                                                 |
| unit line coverage        | 35.67%                                                                 |
| production dependency     | 11 high, 13 moderate, 2 low audit findings in the current lockfile     |
| complete dependency audit | 2 critical, 41 high, 25 moderate, 10 low findings including dev chains |

A temporary in-range lockfile refresh reduced the production audit to zero findings. This proves
that the immediate production dependency issue can be fixed without a framework rewrite. The
refreshed dependency set has not yet been installed or committed to this repository and must pass
all gates below before acceptance.

The local audit could not rerun the PostgreSQL integration suite because no local PostgreSQL client,
server, or `DATABASE_URL` was available. CI already provisions PostgreSQL 16; implementation work
must run that suite in CI or against an equivalent disposable local database.

## Guardrails

The implementing agent must preserve the following constraints:

- Ethereum Sepolia `EtherdocSender` remains the canonical source of truth.
- PostgreSQL, Pinata, and the destination contract remain evidence/projections, not canonical truth.
- Preserve SIWE authentication, EIP-712 intents, source transaction reconciliation, finalized event
  indexing, reorg handling, and CCIP destination evidence semantics.
- Preserve the PostgreSQL transactional outbox unless a separate architecture change is explicitly
  approved. Improving its lease implementation is in scope; replacing it with BullMQ, Kafka, or
  another queue is not.
- Do not edit `src/contracts/generated/contract-artifacts.generated.ts` manually.
- Do not change the pinned smart-contract baseline or deployment registry as part of modernization.
- Do not rewrite raw SQL into an ORM. The current explicit SQL and transaction control are
  appropriate for the protocol state machines.
- Do not combine security patching with unnecessary ESM, Fastify, ORM, or framework migrations.
- Do not edit an applied migration. Add a new forward-only migration for schema changes.
- Do not add secrets, real private keys, bearer tokens, RPC credentials, or Pinata credentials.
- Keep unrelated user changes intact and avoid repository-wide formatting churn.

## Delivery strategy

Implement the plan as small, reviewable changes in the order below. Each phase should be independently
buildable and testable. Do not start a major toolchain upgrade while a prior security or reliability
phase is failing.

Recommended change groups:

1. dependency security and manifest correctness;
2. upload and remote-response bounds;
3. authentication and HTTP hardening;
4. worker shutdown and outbox leases;
5. health and observability;
6. type safety and focused refactoring;
7. test, CI, documentation, and runtime alignment.

## Phase 1: Dependency security and manifest correctness

### 1.1 Refresh safe versions

- Run `pnpm update` so packages move to the latest versions allowed by the current semver ranges.
- Review the lockfile and confirm the expected production updates include at least:
  - NestJS packages from `11.1.2` to a patched NestJS 11 release;
  - `multer` from `2.0.0` to `2.2.0` or newer;
  - viem from `2.31.2` to a current compatible viem 2 release;
  - `uuid` to at least `11.1.1` if it has not yet been removed;
  - patched transitive versions for `jws`, `path-to-regexp`, `ws`, `validator`, `lodash`,
    `body-parser`, `qs`, and `file-type`.
- Keep NestJS packages on one compatible 11.x version wherever possible.
- Do not upgrade TypeScript to 7, ESLint to 10, or Jest to 30 in this security change.
- Run `pnpm audit --prod` and require zero high and critical findings.

### 1.2 Correct runtime dependency classification

- Move `@nestjs/jwt` from `devDependencies` to `dependencies`. It is imported by runtime
  authentication code.
- Verify a production-only install can resolve `@nestjs/jwt`, start the compiled entry point, and
  load `AppModule`.
- Add a CI check that creates or validates a production-only install so this regression cannot
  return.

### 1.3 Remove unused packages

Source inspection currently shows no active imports for:

- `ethers`;
- `uuid`;
- `@types/uuid`;
- `@nestjs/mapped-types`.

Remove them after repeating the source/config search and running all gates. Also verify whether these
development packages are genuinely needed by Nest CLI, debugging, or CI before removing them:

- `@eslint/eslintrc`;
- `@swc/cli`;
- `@swc/core`;
- `source-map-support`;
- `ts-loader`.

Keep `ts-node` and `tsconfig-paths` while the `test:debug` script uses them, or modernize that script
in the same change before removal.

### 1.4 Make updates reproducible

- Add a `packageManager` field with the exact approved pnpm major/minor.
- Add an `engines.node` policy matching the supported runtime established in Phase 7.
- Replace the unbounded `"@nestjs/mapped-types": "*"` range if the package is retained.
- Add scripts such as:
  - `audit:prod` for a production audit;
  - `check` for the read-only local quality sequence, if it can remain clear and deterministic.
- Add the production audit to CI.
- Add a weekly dependency update mechanism using either Dependabot or Renovate. Group NestJS
  packages and keep major upgrades in separate pull requests.

### Phase 1 acceptance

- `pnpm install --frozen-lockfile` succeeds.
- A production-only install includes all runtime imports.
- `pnpm audit --prod` reports no high or critical findings, preferably zero findings.
- The full dependency audit has no critical findings. Remaining dev-only findings require a written
  non-runtime risk note and a follow-up issue with an expiry date.
- All mandatory gates pass.

## Phase 2: Bound uploads and remote responses

### 2.1 Enforce Multer limits before buffering

The existing `ParseFilePipe` validates size only after Multer has received the file. Apply limits at
the multipart parser:

- define one shared PDF upload limit constant, initially 5 MiB;
- configure every `FileInterceptor('file')` with `limits.fileSize`;
- also set conservative `files`, `fields`, `parts`, `fieldNameSize`, and `fieldSize` limits;
- keep the existing magic/file-type validation and post-upload size check as defense in depth;
- return a stable `413 Payload Too Large` or documented `422` error contract;
- do not trust the client-provided MIME type alone.

If memory storage is retained, document why 5 MiB times expected concurrency fits the production
memory budget. Use streaming or disk-backed temporary storage if concurrency makes memory storage
unsafe.

### 2.2 Bound Pinata retrieval

Replace unbounded `response.arrayBuffer()` retrieval with a bounded reader:

- reject a `Content-Length` larger than the configured maximum;
- stream and count bytes because `Content-Length` may be absent or false;
- cancel the response and throw a stable storage error once the limit is exceeded;
- retain the exact SHA-256 digest verification;
- ensure timeout and cancellation clean up the response body;
- apply a reasonable bound when parsing Pinata JSON responses as well.

Keep upload-size and retrieval-size configuration separate if Pinata can legally return metadata or
container overhead larger than the original file.

### 2.3 Tests

Add tests proving:

- an oversized multipart upload is rejected by Multer before the controller/service receives it;
- too many fields/parts are rejected;
- a fake Pinata response with an oversized `Content-Length` is rejected;
- a chunked response that crosses the limit is aborted;
- exactly-at-limit PDF bytes still pass and are digest-verified;
- malformed/non-PDF content is rejected.

### Phase 2 acceptance

- No upload or Pinata retrieval path can allocate an unbounded body.
- Existing register, supersede, and public search behavior remains compatible.
- New HTTP and storage tests pass.

Implementation record: commit `207b952` applies shared inclusive 5 MiB multipart limits, bounded
field/part counts, deterministic PDF magic-byte validation, and HTTP tests. Commit `3c49d5c`
replaces unbounded Pinata artifact and JSON reads with a cancelling bounded reader and storage tests.
The complete lint, unit, HTTP, PostgreSQL integration, build, contract-drift, production audit, and
production-only installation gates passed.

## Phase 3: Authentication and HTTP hardening

### 3.1 Use one session lifetime

`JWT_EXPIRES_IN` currently controls token expiry while `SIWE_SESSION_TTL_SECONDS` controls cookie
`maxAge` and the API response. Replace this with one canonical numeric session TTL:

- use `SIWE_SESSION_TTL_SECONDS` as the canonical value unless a better neutral name is introduced;
- pass that numeric value to JWT signing;
- derive cookie `maxAge` and `expiresInSeconds` from the same value;
- remove `JWT_EXPIRES_IN`, or temporarily validate that it resolves to the exact same duration and
  mark it deprecated;
- update `.env.example`, README, API documentation, and operations runbook;
- add tests with intentionally different legacy values to prevent silent drift.

### 3.2 Rate limiting

Add `@nestjs/throttler` or an equivalent maintained NestJS mechanism:

- apply a general API limit;
- apply stricter limits to `POST /auth/nonce` and `POST /auth/verify`;
- limit unauthenticated document search and file upload separately;
- use both client address and wallet address where appropriate;
- configure `trust proxy` only for known proxy hops/networks so forwarded addresses cannot be
  spoofed;
- use a shared limiter store before running multiple API replicas. An in-memory limiter is
  acceptable only for an explicitly documented single-instance environment.

Use deterministic e2e tests with isolated limiter state.

### 3.3 Avoid external verification inside a database transaction

SIWE verification may require an RPC call for ERC-1271 wallets. Do not keep a database transaction
and row lock open during that external call:

1. read the exact unconsumed challenge;
2. validate expiry and exact stored message equality;
3. verify the signature outside a transaction;
4. atomically consume with one conditional update:
   `WHERE id = ... AND consumed_at IS NULL AND expires_at > now()`;
5. issue a JWT only when exactly one row was consumed.

Add a concurrent replay test proving two valid submissions can produce only one session.

### 3.4 Nonce retention

- Add a bounded cleanup operation for consumed and expired authentication nonces.
- Run cleanup in a safe periodic maintenance path or a documented scheduled command.
- Delete in batches to avoid long locks.
- Retain rows only as long as required for operational/audit policy.
- Add an index that supports the cleanup query if the existing partial index is insufficient.

### 3.5 HTTP security

- Add Helmet before other HTTP middleware and verify headers in e2e tests.
- Keep CORS restricted to configured origins with credentials only when required.
- Explicitly set cookie `path`, `httpOnly`, `secure`, and `sameSite`.
- Do not infer production cookie security solely from an unrelated URL if deployment has an explicit
  environment/security mode.
- Decide and document the CSRF policy:
  - if cookie authentication remains accepted for mutating endpoints, implement a tested CSRF
    control compatible with the frontend;
  - bearer-only requests may use a documented CSRF exemption;
  - do not silently make a breaking CSRF change without updating API/client documentation.
- Add `ParseUUIDPipe` or equivalent validation for `:intentId`.
- Add maximum lengths for `groupName`, `groupId`, and other currently unbounded strings.
- Consolidate the repeated storage `Network` enum and use the enum type instead of `string`.

### 3.6 Authorization decision for Pinata groups/files

The current authenticated groups/files endpoints do not scope data by wallet. Before changing their
behavior, record one explicit product decision:

- **shared workspace:** retain shared access and document it in the API/security model; or
- **wallet-owned workspace:** add a forward-only ownership migration, bind groups/files to the
  authenticated wallet, and enforce ownership on every list/create/read operation.

Do not claim tenant isolation unless ownership is implemented and tested.

### Phase 3 acceptance

- JWT expiry, cookie lifetime, and response lifetime are identical.
- Authentication replay remains impossible without holding a transaction across RPC verification.
- Rate limits return stable `429` responses and work behind the approved proxy topology.
- Nonce storage growth is bounded.
- Invalid intent UUIDs return `400`, not a PostgreSQL-derived `500`.
- HTTP security headers and the chosen CSRF policy are covered by e2e tests.

Implementation record: commit `a4551a9` unifies session lifetime and moves SIWE verification
outside the nonce-consumption transaction while preserving an atomic conditional consume. Commit
`930e562` adds scheduled batched nonce retention and migration `005_auth_nonce_retention.sql`.
Commit `dd54b06` adds Helmet, explicit cookie/proxy configuration, Origin-based cookie CSRF
protection, and independent general/auth/search/multipart limits. Commit `df64bf7` adds UUID and
metadata length validation, consolidates `StorageNetwork`, and records the shared Pinata workspace
decision. Commit `f3315a2` executes nonce cleanup against PostgreSQL. The complete lint, unit, HTTP,
PostgreSQL 16 migration/integration, build, contract-drift, production audit, and production-only
installation gates passed.

## Phase 4: Graceful shutdown and reliable outbox leases

### 4.1 Enable and drain shutdown

- Call `app.enableShutdownHooks()` during bootstrap.
- Stop scheduling new indexer and outbox ticks when shutdown begins.
- Track the active tick promise in each scheduled service.
- Wait for the current operation to finish up to a configured drain timeout.
- Log a timeout with service/job context and exit without pretending the job completed.
- Ensure the database pool closes only after services stop using it.
- Add lifecycle tests that begin a job, trigger shutdown, and verify ordering.

### 4.2 Introduce lease ownership tokens

The current completion/retry/failure updates match only `id` and `state`. A stale worker can update a
job after another worker has reclaimed it. Add a forward-only migration, for example
`005_outbox_lease.sql`, that introduces a nullable `lease_token uuid`.

The claim path must:

- generate a fresh lease token for every claim;
- return it with the job;
- set `locked_at`, `locked_by`, and `lease_token` atomically.

Complete, retry, fail, and heartbeat operations must match both job ID and lease token. They must
check `rowCount` and treat a lost lease as a concurrency event, not a successful update. Clearing a
lease must clear all lease fields.

Keep the migration compatible with the previously deployed application during a rolling upgrade,
or document a stop-the-world worker deployment if compatibility cannot be preserved.

### 4.3 Heartbeat and stale-lease recovery

- Refresh `locked_at` while a long-running job still owns its lease.
- Reclaim expired leases periodically while the application is running, not only during startup.
- Do not reclaim a healthy job whose heartbeat is current.
- Add tests with two database clients proving stale-owner completion is rejected.
- Ensure process restart still recovers genuinely expired work.

### 4.4 Retry and dead-letter policy

- Add a configurable maximum attempt count, preferably per job type.
- Keep exponential backoff bounded and add jitter to avoid synchronized retries.
- Move exhausted jobs to `FAILED` with actionable context.
- Preserve protocol-specific handling of uncertain broadcasts: never blindly resend a source or
  dispatch transaction when the signer nonce may already have been consumed.
- Emit an alertable log/metric when a job becomes failed or recovery-required.
- Document operator recovery in `operations-runbook.md`.

### 4.5 Advisory lock cleanup

- Make advisory-lock release use a nested `finally` so the pool client is released even if unlock
  fails.
- Prefer `pg_try_advisory_lock` for periodic indexers so a second replica skips a tick instead of
  blocking until `statement_timeout`.
- Keep transaction and blockchain timeouts in separate configuration fields.

### Phase 4 acceptance

- `SIGTERM` stops new work and drains or safely abandons current work.
- A worker without the current lease token cannot complete, retry, fail, or heartbeat a job.
- Expired work is reclaimed without restarting the application.
- Retry exhaustion becomes a visible terminal state.
- Concurrent PostgreSQL integration tests cover claim, heartbeat, reclaim, lost lease, and shutdown.

Implementation record: commit `164a63e` enables shutdown hooks, drains active outbox/indexer ticks
before the database pool closes, makes advisory unlock cleanup release clients reliably, and uses
non-blocking advisory locks for periodic indexers. Commit `abcb732` adds forward-only migration
`006_outbox_lease.sql`, per-claim lease tokens, heartbeat, bounded runtime reclaim, token-guarded
state transitions, jittered bounded retry, per-job attempt limits, and concurrent PostgreSQL
coverage. Commit `2f8d68c` adds alertable logs for dispatch recovery-required transitions. The
migration is deployed stop-the-world because a pre-lease worker is schema-compatible but cannot
safely participate in mixed-version ownership. The complete lint, unit, HTTP, PostgreSQL 16
migration/integration, build, contract-drift, production audit, and production-only installation
gates passed.

## Phase 5: Health and observability

### 5.1 Replace the placeholder root response

Add explicit endpoints:

- `GET /health/live`: process event loop is responsive; no external dependency calls;
- `GET /health/ready`: database query succeeds, schema is present, startup blockchain readiness
  completed, and the service is not shutting down.

Do not call every RPC and Pinata endpoint synchronously on every liveness probe. Cache expensive
readiness checks for a short bounded interval and expose degraded status separately where useful.
Use `@nestjs/terminus` if it provides a clean fit without forcing an ORM.

### 5.2 Operational status

Expose or record:

- source and destination cursor lag from finalized heads;
- READY, RUNNING, FAILED, and expired-lease outbox counts;
- last successful indexer tick per chain;
- job duration, attempt count, and terminal/recovery-required transitions;
- RPC and Pinata request duration/failure classification;
- graceful-shutdown state.

Do not expose private keys, JWTs, Pinata tokens, full signed messages, or internal database URLs.
Detailed status may require an operator-only endpoint; basic health endpoints must remain safe.

### 5.3 Logging

- Add a request/correlation ID and propagate it into relevant intent/outbox logs.
- Log structured fields for job ID, job type, attempt, lease owner/token fingerprint, intent ID,
  dispatch ID, chain, and error classification.
- Preserve error stacks in server logs while returning stable sanitized API errors.
- Avoid logging full signatures, JWTs, SIWE messages, or secrets.

### Phase 5 acceptance

- Health endpoints have deterministic tests for healthy, degraded, and shutting-down states.
- Operators can determine why an intent/dispatch is delayed without direct ad hoc code inspection.
- Logs contain correlation context and no secrets.

## Phase 6: Type safety and focused refactoring

### 6.1 Increase TypeScript strictness incrementally

Do not enable every option and suppress errors with broad casts. Use staged changes:

1. enable `noImplicitAny`, `strictBindCallApply`, and `noFallthroughCasesInSwitch`;
2. enable the remaining practical `strict` options, using definite-assignment declarations only for
   framework-populated DTO fields;
3. enable `noUncheckedIndexedAccess` and validate array/query results explicitly;
4. keep `skipLibCheck` only if third-party types require it and record why.

Specific baseline errors that require real handling include:

- `rows[0]` possibly missing after inserts/selects;
- unvalidated values loaded from `typed_data` JSON;
- status-array indexing by an unchecked numeric contract value;
- optional source transaction rows used without a guard;
- DTO properties populated by class-transformer.

Add small parsing/assertion functions for database JSON, Pinata JSON, contract tuples, and outbox
payloads instead of spreading `as` casts.

### 6.2 Strengthen ESLint

- Align `ecmaVersion` with the Node/TypeScript target instead of `5`.
- Promote `no-floating-promises` and unsafe-argument checks to errors once violations are fixed.
- Keep lint read-only in CI.
- Separate Prettier formatting from correctness linting if plugin execution materially slows lint.

### 6.3 Reduce oversized service responsibilities

Refactor only where boundaries are clear and tests exist. Candidate extractions:

- Pinata groups/files metadata API out of `DocumentsService`;
- source and destination evidence assembly into focused evidence services;
- source/destination index projection helpers out of `ChainIndexerService`;
- outbox job dispatch from scheduler/lifecycle control.

Preserve transaction boundaries. Do not split a protocol state transition across services merely to
reduce line count.

### 6.4 SQL and API typing

- Replace `SELECT *` with explicit column lists for long-lived row mappings.
- Add explicit return types to controller and service methods.
- Replace broad `Promise<unknown>` where a stable API response exists.
- Define response DTOs/types for health, intent, canonical document, dispatch evidence, and Pinata
  metadata proxy responses.
- Keep bigint values serialized consistently as decimal strings.

### Phase 6 acceptance

- The approved strict compiler options pass without `@ts-ignore` or broad `any` suppression.
- Typed-data/outbox/Pinata payloads are validated at trust boundaries.
- Refactoring does not alter protocol state semantics or public JSON unintentionally.
- API documentation matches response types.

## Phase 7: Tests, CI, documentation, and runtime alignment

### 7.1 Expand high-value tests

Prioritize behavior and failure modes over line-count-only tests:

- SIWE concurrent replay, expiry, ERC-1271 RPC failure, and rate limiting;
- upload parser bounds and Pinata streaming bounds;
- JWT/cookie lifetime equality;
- invalid UUID and DTO boundary errors;
- outbox lost lease, heartbeat, stale reclaim, retry exhaustion, and shutdown drain;
- signer nonce uncertainty and no-blind-resend invariants;
- source/destination reorg replay;
- readiness degradation and recovery;
- production-only dependency installation.

Raise coverage in stages:

1. establish enforceable thresholds no lower than the current baseline;
2. reach at least 50% statements/lines while covering the new critical paths;
3. target 70% or better for authentication, storage, outbox, indexer, and transaction workers.

Global percentage is secondary to branch coverage of financial/protocol and concurrency paths.

### 7.2 Strengthen CI

CI must run:

```bash
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm lint:check
pnpm test --runInBand
pnpm db:migrate
pnpm db:migrate
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm audit --prod
```

Also:

- verify migrations against a clean PostgreSQL 16 database;
- run the newest migration twice through the full migration command to retain idempotency checks;
- test a production-only install/build artifact;
- fail on high/critical production advisories;
- retain least-privilege GitHub Actions permissions;
- pin the Node and pnpm versions used by CI.

### 7.3 Node runtime transition

Node 22 remains a supported LTS baseline, while Node 24 is the preferred modernization target.
Transition safely:

1. test Node 22 and Node 24 in CI during the dependency/security phases;
2. fix compatibility issues without adding version-specific behavior;
3. switch production documentation and `engines.node` to Node 24 after all gates pass;
4. keep a short Node 22 compatibility window only if deployment infrastructure requires it;
5. do not adopt a non-LTS production runtime.

The local audit already passed lint, tests, and build on Node 24, but PostgreSQL integration and the
updated lockfile must still be tested on the chosen CI matrix.

### 7.4 Update documentation

Update together with implementation:

- `README.md` requirements, setup, commands, and health endpoints;
- `.env.example` for new limits, session TTL, worker drain/lease/retry, and database timeout values;
- `docs/api-doc.md` for status codes, rate limits, CSRF behavior, health, and error responses;
- `docs/operations-runbook.md` for failed jobs, lease recovery, shutdown, and readiness;
- `docs/local-readiness-audit.md` only with factual post-implementation gate results;
- this plan by checking completed work or adding a final completion record.

### Phase 7 acceptance

- CI passes on the selected LTS runtime and PostgreSQL 16.
- Production deployment requirements are reproducible from committed metadata.
- Documentation contains no obsolete environment variables or behavior.
- Coverage thresholds are enforced and cannot silently regress.

## Mandatory validation after every phase

Run the smallest relevant tests during implementation, then run the complete gate before handing off
the phase:

```bash
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm lint:check
pnpm test --runInBand
pnpm test:e2e
pnpm test:integration
pnpm build
pnpm audit --prod
```

For migration changes, also:

1. create a clean disposable PostgreSQL 16 database;
2. run `pnpm db:migrate` twice;
3. run the PostgreSQL integration suite;
4. verify the old application/new schema compatibility required by the rollout;
5. never test destructive migration behavior against a shared or production database.

Run `pnpm reconcile` in dry-run mode when worker, indexer, outbox, or state-projection behavior
changes. Do not use `--enqueue` against live data as an automated test.

## Rollout order

1. Merge and deploy the safe dependency/manifest correction.
2. Deploy upload and authentication hardening with frontend-compatible API behavior.
3. Apply forward-only outbox lease migration while workers are stopped if rolling compatibility has
   not been proven.
4. Deploy one API/worker instance.
5. Verify readiness, migration inventory, chain IDs, contract code hashes, signer role, cursors, and
   outbox counts.
6. Let reconciliation and indexers reach finalized heads.
7. Scale out only after lease, heartbeat, and advisory-lock behavior is stable.
8. Promote Node 24 only after the exact production artifact passes all gates.

Rollback must follow `operations-runbook.md`: preserve PostgreSQL state, do not reverse migrations,
and roll application code back only to a version compatible with the current schema and generated
contract artifact.

## Final definition of done

- [x] Production audit has no high or critical findings.
- [x] Runtime dependencies are correctly classified and production-only install is tested.
- [x] Unused direct dependencies are removed.
- [x] Multipart and Pinata response bounds are enforced before unbounded allocation.
- [x] Authentication and upload/search rate limits are active and documented.
- [x] JWT, cookie, and response session lifetime use one value.
- [x] Nonce cleanup and concurrent replay tests are implemented.
- [x] CSRF and Pinata workspace authorization policies are explicit and tested.
- [x] Shutdown hooks are enabled and active worker ticks drain safely.
- [x] Outbox jobs use lease tokens, heartbeats, periodic stale recovery, and retry exhaustion.
- [ ] Liveness/readiness and operational signals are implemented without leaking secrets.
- [ ] TypeScript strictness and trust-boundary validation are materially improved.
- [ ] Critical service/worker failure branches have focused tests.
- [x] CI includes production audit, PostgreSQL integration, and production-only installation.
- [x] Node and pnpm versions are pinned and documentation matches production.
- [x] Contract artifact drift check still passes against the unchanged baseline.
- [ ] `pnpm reconcile` dry run shows no unexpected recovery work after rollout.

## Explicitly deferred work

The following are not required for this modernization unless a separate decision approves them:

- NestJS 12 or another framework-major migration;
- TypeScript 7, ESLint 10, or Jest 30 solely to reach the latest major;
- CommonJS-to-ESM conversion;
- Express-to-Fastify conversion;
- raw SQL-to-ORM migration;
- PostgreSQL outbox replacement;
- new blockchain networks, mainnet deployment, or smart-contract changes;
- API redesign unrelated to the security, reliability, typing, or operability outcomes above.
