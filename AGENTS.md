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
  auditSync.ts  — audit override → catalog promotion logic
  cleanup.ts    — file cleanup (lock, node_modules, overrides)
  pnpm.ts       — pnpm runner abstraction (real shell-out or injected mock)
  logger.ts     — Logger interface + consoleLogger / silentLogger
  fsWalk.ts     — filesystem walk utilities
  semverUtil.ts — semver helpers
tests/          — Vitest tests (*.test.ts); mirror src structure
```

Key design point: `WorkspaceState` is initialized once per run and passed to
helper modules. `PnpmRunner` is injectable so tests never shell out to real pnpm.

## TypeScript conventions

- **ESM only** — `"type": "module"`, NodeNext module resolution
- **Import paths must use `.js` extension** even for `.ts` source files:
  `import { foo } from './bar.js'`
- **Inline type imports**: `import { type Foo, bar } from './baz.js'`
  (ESLint rule `@typescript-eslint/consistent-type-imports` is enforced)
- Strict mode: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` are on

## Testing conventions

- Tests use real filesystem via `fs.mkdtempSync` for temp dirs
- Temp dirs are cleaned up in `afterEach` with `fs.rmSync(tmp, { recursive: true })`
- Inject `silentLogger` when constructing `WorkspaceState` in tests
- Inject a mock `PnpmRunner` via `options.pnpm` to avoid shelling out
- Coverage thresholds: 65% statements/branches/lines, 70% functions
  (`src/cli.ts`, `src/version.ts`, `src/index.ts` are excluded)

## Contributing

- `src/version.ts` is auto-generated — never edit it manually
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow

## Existing agent customizations

- [.agents/instructions/](.agents/instructions/) — instruction files for GitHub Actions CI/CD, security/OWASP, and doc sync
- [.agents/skills/](.agents/skills/) — skills for supply-chain, audit-integrity, CodeQL, conventional commits, Dependabot, releases, secret scanning, and security review
