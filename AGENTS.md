# Repository Guidelines

## Project Structure & Module Organization

This repository is a NestJS/TypeScript backend for Etherdoc’s signed-document and cross-chain replication workflow. Application code lives in `src/`, grouped by domain (`auth/`, `documents/`, `blockchain/`, `storage/`, `workers/`, and `health/`). Unit tests are colocated as `*.spec.ts`. HTTP end-to-end and PostgreSQL integration suites live in `test/`. Database changes are ordered SQL files in `migrations/`; operational utilities are in `scripts/`; architecture, API, and recovery notes are in `docs/`.

Do not hand-edit `src/contracts/generated/contract-artifacts.generated.ts`. Update it through `pnpm contracts:sync` against the pinned `sc-etherdoc` baseline.

## Build, Test, and Development Commands

Use Node 24.14.1 and pnpm 10.34.5.

- `pnpm install --frozen-lockfile` installs the exact dependency graph.
- `pnpm db:migrate` applies checksum-protected PostgreSQL migrations.
- `pnpm start:dev` runs NestJS in watch mode; `pnpm build` emits `dist/`.
- `pnpm typecheck` and `pnpm lint:check` run non-mutating static checks.
- `pnpm format` and `pnpm lint` rewrite formatting or lint issues.
- `pnpm check` runs the main local quality sequence.
- `pnpm reconcile` is read-only; review the runbook before using `--enqueue`.

## Coding Style & Naming Conventions

TypeScript is strict, with two-space indentation, single quotes, and trailing commas enforced by Prettier and typed ESLint rules. Avoid `any`, floating promises, unsafe arguments, and unchecked indexed access. Follow NestJS suffixes such as `*.controller.ts`, `*.service.ts`, `*.module.ts`, and `*.guard.ts`; use kebab-case filenames and PascalCase exported types.

## Testing Guidelines

Jest and `ts-jest` power all suites. Name unit tests `*.spec.ts`, API tests `*.e2e-spec.ts`, and database tests `*.integration-spec.ts`. Run `pnpm test --runInBand`, `pnpm test:e2e`, or `pnpm test:integration` (with `DATABASE_URL` targeting a disposable PostgreSQL 16 database). `pnpm test:coverage` enforces 50% global line/statement/function coverage, 45% branches, plus higher critical-area thresholds.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits with scopes, for example `feat(config): separate database and RPC timeouts`. Keep commits focused and use `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, or `ci`. Pull requests should explain behavior and risk, link relevant issues, document configuration or migration changes, update API/runbook docs when applicable, and list verification commands. Ensure CI-equivalent checks pass; include screenshots only when response or documentation rendering changes.

## Security & Configuration

Copy `.env.example` to `.env`; never commit secrets, private keys, database URLs, or provider credentials. Use only controlled local/testnet keys for `BACKEND_PRIVATE_KEY`, keep `OPERATIONS_TOKEN` distinct from `JWT_SECRET`, and preserve source-chain canonicality and no-blind-resend invariants.
