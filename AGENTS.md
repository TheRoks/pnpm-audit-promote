# pnpm-audit-promote — Agent Instructions

CLI tool that refreshes a pnpm workspace, runs `pnpm audit --fix`, and promotes
catalog-eligible overrides back into the pnpm catalog.
See [README.md](./README.md) for full feature description and [CONTRIBUTING.md](./CONTRIBUTING.md) for all dev commands.

## Quick start

```sh
pnpm install
```

**CI gate** (must all pass): `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Architecture

```text
src/
  cli.ts        — CLI entry point (commander); excluded from coverage
  index.ts      — public API re-exports; excluded from coverage
  refresh.ts    — orchestration: the 10-step refreshDeps() flow
  workspace.ts  — WorkspaceState class (paths + desired-YAML snapshot)
  catalog.ts    — regex-based pnpm-workspace.yaml manipulation
  cleanup.ts    — file cleanup (lock, node_modules, overrides)
  pnpm.ts       — pnpm runner abstraction (real shell-out or injected mock)
  logger.ts     — Logger interface + consoleLogger / silentLogger
  progress.ts   — createProgressLogger: numbered step wrapper around Logger
  prompt.ts     — defaultConfirmDestructive + ConfirmFn injection point
  errors.ts     — typed error classes (WorkspaceNotFoundError, ...)
  fsWalk.ts     — filesystem walk utilities (index-based BFS)
  jsonEdit.ts   — JSONC-aware package.json edits
  semverUtil.ts — semver helpers
  summary.ts    — barrel re-export for the summary subsystem
  summary/
    types.ts    — RunSummaryData, AdvisorySummary, CatalogChange, OverrideChange
    collect.ts  — pure data: extractAdvisories, diff*, read*Overrides, safeReadFile
    render.ts   — renderTerminalSummary (terminal-pretty + plain-text)
    emit.ts     — capture final state, render, and (optionally) write summary file
  audit/
    parseAdvisories.ts          — pnpm audit JSON → direct-dep catalog bumps
    promoteWorkspaceOverrides.ts — workspace overrides → catalog
    promotePackageJsonOverrides.ts — package.json pnpm.overrides → catalog
    overrideCollapse.ts         — selector collapsing helpers
    bumpReporting.ts            — formatted bump diagnostics
tests/
  *.test.ts     — Vitest tests; mirror src/ structure
  audit/        — tests for src/audit/*
  helpers/      — shared test helpers (e.g. recordingRunner)
```

Key design point: `WorkspaceState` is initialized once per run and passed to
helper modules. `PnpmRunner` is injectable so tests never shell out to real pnpm.

## TypeScript conventions

- **ESM only** — `"type": "module"`, bundler module resolution
- **Extensionless relative imports**: `import { foo } from './bar'`
  (tsdown rewrites these to `.js` for the published Node ESM build; an
  ESLint rule blocks `.js` extensions on relative imports in source)
- **Inline type imports**: `import { type Foo, bar } from './baz'`
  (ESLint rule `@typescript-eslint/consistent-type-imports` is enforced)
- Strict mode: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `noUnusedLocals`, `noUnusedParameters`, `noPropertyAccessFromIndexSignature`
  are on (see `tsconfig.base.json`)

## Testing conventions

- Tests use real filesystem via `fs.mkdtempSync` for temp dirs
- Temp dirs are cleaned up in `afterEach` with `fs.rmSync(tmp, { recursive: true })`
- Inject `silentLogger` when constructing `WorkspaceState` in tests
- Inject a mock `PnpmRunner` via `options.pnpm` to avoid shelling out
- Coverage thresholds: 90% statements, 78% branches, 95% functions, 93% lines
  (`src/cli.ts`, `src/index.ts`, `src/summary.ts` are excluded)
- **Requirement IDs**: every `it()` / `test()` title SHALL be prefixed with
  one or more `REQ-AREA-NNN` IDs from [REQUIREMENTS.md](./REQUIREMENTS.md).
  Run `pnpm traceability` to regenerate `docs/traceability.md` and
  `pnpm traceability:strict` to fail on unbound requirements (CI gate).
- **Integration tests** live under `tests/integration/` and are gated by
  `RUN_INTEGRATION=1`. Run them with `pnpm test:integration`. They drive a
  real pnpm binary (10 or 11) against deterministic vulnerable fixtures.
- **CLI e2e tests** live under `tests/cli/` and spawn the built
  `dist/cli.js`. They auto-build if `dist/` is missing.
- **Property-based tests** (fast-check) live in `tests/*.property.test.ts`
  and complement example-based tests with algebraic-law coverage.

## Contributing

- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow

## Existing agent customizations

- [.agents/instructions/](.agents/instructions/) — instruction files for GitHub Actions CI/CD, security/OWASP, and doc sync
- [.agents/skills/](.agents/skills/) — skills for supply-chain, audit-integrity, CodeQL, conventional commits, Dependabot, releases, secret scanning, and security review
