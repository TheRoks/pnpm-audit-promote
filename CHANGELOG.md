# pnpm-audit-promote

## [1.9.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.8.0...v1.9.0) (2026-07-21)


### Features

* add audit status tracking to refreshDeps and related summary functions ([#103](https://github.com/TheRoks/pnpm-audit-promote/issues/103)) ([2bdae23](https://github.com/TheRoks/pnpm-audit-promote/commit/2bdae23e7a5ee88e024f4b2dccf202149149de87))

## [1.8.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.7.0...v1.8.0) (2026-06-08)


### Features

* **audit:** enhance advisory matching with case-insensitive checks and improve error handling for non-string module names ([#46](https://github.com/TheRoks/pnpm-audit-promote/issues/46)) ([59cfa97](https://github.com/TheRoks/pnpm-audit-promote/commit/59cfa9755ee54bcb7bd3aa52dff44e362dc71ac4))
* **override:** enhance collapse logic to merge overlapping selectors with stronger fix floor ([#72](https://github.com/TheRoks/pnpm-audit-promote/issues/72)) ([c8fa34e](https://github.com/TheRoks/pnpm-audit-promote/commit/c8fa34e768c86209d028167a7952f016f9c8f57d))

## [1.7.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.6.0...v1.7.0) (2026-05-14)


### Features

* enhance audit features and improve logging output handling ([#44](https://github.com/TheRoks/pnpm-audit-promote/issues/44)) ([e635c5b](https://github.com/TheRoks/pnpm-audit-promote/commit/e635c5bbe1ebf07f5f8f621aece802e63eb8ecc7))
* enhance audit handling and improve test coverage for traceability ([#43](https://github.com/TheRoks/pnpm-audit-promote/issues/43)) ([eaf537a](https://github.com/TheRoks/pnpm-audit-promote/commit/eaf537acb3b6460671cfdedef5d59a1dd4706301))


### Bug Fixes

* **deps:** add unrun as a dev dependency in package.json and update pnpm-lock.yaml ([#41](https://github.com/TheRoks/pnpm-audit-promote/issues/41)) ([af29c85](https://github.com/TheRoks/pnpm-audit-promote/commit/af29c85964339b60b242c012f30df50367aeedb4))
* **summary:** adjust terminal output color based on TTY detection ([e635c5b](https://github.com/TheRoks/pnpm-audit-promote/commit/e635c5bbe1ebf07f5f8f621aece802e63eb8ecc7))
* **traceability:** improve test coverage reporting for deprecated requirements ([eaf537a](https://github.com/TheRoks/pnpm-audit-promote/commit/eaf537acb3b6460671cfdedef5d59a1dd4706301))

## [1.6.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.5.0...v1.6.0) (2026-05-12)


### Features

* **cli:** normalize summary file path and improve error handling ([#39](https://github.com/TheRoks/pnpm-audit-promote/issues/39)) ([e531bb9](https://github.com/TheRoks/pnpm-audit-promote/commit/e531bb94109bea8b22dd62f53ad4dffdf16c3639))
* **pnpm:** allow explicit pnpm executable path ([e531bb9](https://github.com/TheRoks/pnpm-audit-promote/commit/e531bb94109bea8b22dd62f53ad4dffdf16c3639))
* **summary:** enhance summary file writing and validation ([e531bb9](https://github.com/TheRoks/pnpm-audit-promote/commit/e531bb94109bea8b22dd62f53ad4dffdf16c3639))
* **workspace:** implement single-package mode for audit and cleanup operations ([#37](https://github.com/TheRoks/pnpm-audit-promote/issues/37)) ([39b053e](https://github.com/TheRoks/pnpm-audit-promote/commit/39b053e097a003d551457777c85ea0c8f42867d3))


### Bug Fixes

* **catalog:** preserve range prefixes on version bumps in catalog updates ([#40](https://github.com/TheRoks/pnpm-audit-promote/issues/40)) ([21c5358](https://github.com/TheRoks/pnpm-audit-promote/commit/21c53582b68cd96d262c3f99f87716522f8742bb))
* **render:** sanitize advisory fields to remove control characters ([e531bb9](https://github.com/TheRoks/pnpm-audit-promote/commit/e531bb94109bea8b22dd62f53ad4dffdf16c3639))

## [1.5.0](https://github.com/TheRoks/pnpm-audit-promote/compare/v1.4.1...v1.5.0) (2026-05-11)


### Features

* **errors:** enhance error handling for enclosing workspaces ([6085ffe](https://github.com/TheRoks/pnpm-audit-promote/commit/6085ffe1cf0414f81d6568c74d26e5d1d9cbcdcb))
* **pnpm:** support extraArgs for forwarding flags to pnpm invocations ([6085ffe](https://github.com/TheRoks/pnpm-audit-promote/commit/6085ffe1cf0414f81d6568c74d26e5d1d9cbcdcb))
* **refresh:** include ignoreWorkspace option in refresh options ([6085ffe](https://github.com/TheRoks/pnpm-audit-promote/commit/6085ffe1cf0414f81d6568c74d26e5d1d9cbcdcb))
* **workspace:** enhance pnpm integration with workspace detection and error handling ([#33](https://github.com/TheRoks/pnpm-audit-promote/issues/33)) ([6085ffe](https://github.com/TheRoks/pnpm-audit-promote/commit/6085ffe1cf0414f81d6568c74d26e5d1d9cbcdcb))
* **workspace:** implement pnpm 11 workspace tweaks and related tests ([#35](https://github.com/TheRoks/pnpm-audit-promote/issues/35)) ([b3fcfa7](https://github.com/TheRoks/pnpm-audit-promote/commit/b3fcfa7b5db5d7eff553d91b08639342d6cd4796))

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
