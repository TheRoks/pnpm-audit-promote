# pnpm-audit-promote

## [1.4.1](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.4.0...v1.4.1) (2026-05-06)


### Bug Fixes

* **audit:** implement qualified override collapsing in workspace promotion ([#24](https://github.com/TheRoks/pnpm-audit-promote/issues/24)) ([6670958](https://github.com/TheRoks/pnpm-audit-promote/commit/6670958731212715b11a78c8d02498a02c4acbe0))

## [1.4.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.3.0...v1.4.0) (2026-05-05)


### Features

* enhance dependency management by applying package.json version bumps ([#21](https://github.com/TheRoks/pnpm-audit-promote/issues/21)) ([dc91069](https://github.com/TheRoks/pnpm-audit-promote/commit/dc91069785ec2a888ee0bd321dd217f1bc0305d8))

## [1.3.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.2.0...v1.3.0) (2026-05-04)


### Features

* **summary:** add summary collector and terminal renderer for dependency changes ([#18](https://github.com/TheRoks/pnpm-audit-promote/issues/18)) ([b201ec4](https://github.com/TheRoks/pnpm-audit-promote/commit/b201ec429542ad930866b9f2743163587d8d7b47))

## [1.2.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.1.0...v1.2.0) (2026-05-04)


### Features

* enhance logging clarity and add comprehensive tests for modules ([#16](https://github.com/TheRoks/pnpm-audit-promote/issues/16)) ([2e50ff9](https://github.com/TheRoks/pnpm-audit-promote/commit/2e50ff93adb4b211b8953667907e60e086580d07))

## [1.1.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.0.0...v1.1.0) (2026-05-01)


### Features

* implement safe version bumping for direct dependencies with major version handling ([#8](https://github.com/TheRoks/pnpm-audit-promote/issues/8)) ([d632396](https://github.com/TheRoks/pnpm-audit-promote/commit/d6323963717ee1136d47223b4a56a645cec5ef42))


### Bug Fixes

* implement workspace package directory resolution and update cleanup logic ([#7](https://github.com/TheRoks/pnpm-audit-promote/issues/7)) ([dc09960](https://github.com/TheRoks/pnpm-audit-promote/commit/dc09960d7e9805d1c82631d910ecf0eb3749903d))
* preserve quoting style when updating catalog versions ([#9](https://github.com/TheRoks/pnpm-audit-promote/issues/9)) ([7bcfb9a](https://github.com/TheRoks/pnpm-audit-promote/commit/7bcfb9aba529f29e0dd469ef5df28e440d0e04eb))
* remove version specification for pnpm/action-setup in CI and release workflows ([#4](https://github.com/TheRoks/pnpm-audit-promote/issues/4)) ([e15e419](https://github.com/TheRoks/pnpm-audit-promote/commit/e15e4196a3035ed1e5c5e046b765b22c9bcf4385))
* rename NPM_TOKEN to NODE_AUTH_TOKEN in release workflow ([#5](https://github.com/TheRoks/pnpm-audit-promote/issues/5)) ([f0aa658](https://github.com/TheRoks/pnpm-audit-promote/commit/f0aa658d36defcc7e7d51e364d61d636e30c728d))

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
