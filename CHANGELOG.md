# pnpm-audit-promote

## 1.0.0

Initial public release.

### Features

- Refresh a pnpm workspace by removing `pnpm-lock.yaml` and every `node_modules` folder.
- Strip the `overrides:` block from `pnpm-workspace.yaml` and `pnpm.overrides` from every `package.json`.
- Pre-audit catalog bump for direct-dependency vulnerabilities (catalog is updated *before* `pnpm audit --fix` runs).
- Run `pnpm audit --fix` and then promote any catalog-eligible overrides back into the pnpm catalog.
- Restore the desired `pnpm-workspace.yaml` after every pnpm command (pnpm 10 normalizes on install).
- Programmatic API: `refreshDeps`, `createLogger`, `silentLogger`, `WorkspaceState`, `createPnpmRunner`, `ensurePnpmAvailable`, injectable `PnpmRunner`.
- CLI flags: `--dry-run`, `--verbose`, `--quiet`, `--no-audit`, `--no-dedupe`, `--force`/`--yes`, `--path`.
