# Dependency Risk Register

Last reviewed: 27 July 2026.

Production dependency policy: `pnpm audit --prod` must report no high or critical findings. The
production audit reported zero findings when Phase 1 was implemented.

## DEP-001: Nest CLI development-only advisories

| Field        | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Scope        | Development and CI only; no path is present in a production-only install         |
| Severity     | 2 high and 2 moderate findings reported by the complete dependency audit         |
| Root package | `@nestjs/cli@11.0.24`                                                            |
| Owner        | Backend maintainers                                                              |
| Expiry       | 31 August 2026                                                                   |
| Status       | Open follow-up; review on every weekly dependency pull request and before expiry |

Affected transitive paths:

- `@nestjs/cli > fork-ts-checker-webpack-plugin > minimatch > brace-expansion` (high);
- `@nestjs/cli > @swc/cli > minimatch > brace-expansion` (high);
- `@nestjs/cli > @swc/cli > @xhmikosr/bin-wrapper > @xhmikosr/downloader > file-type`
  (moderate).

The CLI remains required by the repository's `nest build`, `nest start`, and Nest schematic
workflows. The vulnerable chains are not installed by `pnpm install --prod`, and application code
does not invoke them or process untrusted input through them at runtime.

Required follow-up:

1. accept a compatible patched Nest CLI/transitive release as soon as one is available;
2. confirm `pnpm audit --prod` remains clean and rerun the complete audit;
3. if upstream remains unpatched at expiry, replace the affected CLI build path or renew this risk
   only with a new dated review and rationale;
4. close DEP-001 only when the complete audit no longer reports these findings.
