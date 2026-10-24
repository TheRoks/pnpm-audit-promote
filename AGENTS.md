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
  cli.ts        — Commander entry point; excluded from coverage
  index.ts      — public package exports; excluded from coverage
  refresh.ts    — public refreshDeps re-export
  refresh/
    prepare.ts                — workspace setup, pnpm selection, and run context
    initialState.ts           — pre-cleanup audit and control-file snapshots
    cleanupPhase.ts           — cleanup ordering
    install.ts                — install and optional dedupe phase
    auditPhase.ts              — audit-phase ordering
    directDependencyPhase.ts  — direct-dependency planning, edits, and reinstall
    auditFixPhase.ts           — audit fix, validation, and override promotion
    commands.ts                — pnpm invocation, workspace reconciliation, build approval
    recovery.ts                — restore control files after a failed refresh
    runRefresh.ts              — top-level phase orchestration and summary
  workspace.ts               — WorkspaceState, immutable paths, and per-run workspace state
  workspace/
    discovery.ts              — root detection and enclosing-workspace guard
    packageScope.ts            — workspace package directory resolution
    packageManifest.ts         — package.json/JSON5/YAML selection, parsing, and edits
    configuration.ts            — pnpm 12.15 include ownership and delegated-file recovery
    pnpmConfig.ts               — version-aware pnpm workspace settings
    yamlSnapshot.ts             — desired YAML snapshot and pnpm reconciliation
    mutations.ts                — guarded, dry-run-aware atomic file mutations
  pnpmCapabilities.ts          — target pnpm feature profile and audit command syntax
  catalog.ts                   — YAML-AST pnpm catalog reads and edits
  cleanup/                     — lockfile, node_modules, and override cleanup
  pnpm.ts                      — real pnpm process runner or injected adapter
  logger.ts                    — Logger interface and console/silent adapters
  progress.ts                  — numbered step wrapper around Logger
  prompt.ts                    — destructive-action prompt and ConfirmFn seam
  errors.ts                    — typed operational errors
  fsWalk.ts                    — filesystem walk utilities (index-based BFS)
  jsonEdit.ts                  — formatting-preserving JSONC edits
  semverUtil.ts                — semver helpers
  summary/                     — summary data collection, rendering, and output
  audit/                       — audit parsing, policy planning, registry reads,
                                override validation, and promotion
tests/
  *.test.ts     — Vitest tests for public and cross-module behavior
  refresh/      — refresh phase and recovery tests
  workspace/    — workspace state, mutation, and config tests
  audit/         — audit policy and promotion tests
  integration/ — real pnpm 10/11/12 workspace tests
  helpers/      — shared test helpers (e.g. recordingRunner)
```

`runRefresh` owns phase ordering. Audit planning and audit-fix reconciliation
are separate steps. Program-initiated workspace file changes go through
`WorkspaceMutations`, which owns dry-run handling, workspace containment, and
atomic file replacement. `WorkspaceState` keeps an immutable path value beside
the mutable YAML snapshot; legacy path accessors remain for public compatibility.
`WorkspaceConfiguration` resolves included setting owners, authorizes only
explicitly included local YAML paths, and keeps them in failure recovery.
`PackageManifest` selects the pnpm-preferred package manifest once per package.
The target pnpm version is resolved once into `PnpmCapabilities`. The public
`PnpmRunner` remains injectable, so unit tests do not shell out to real pnpm.

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
