# pnpm-audit-promote

[![CI](https://github.com/theroks/pnpm-audit-promote/actions/workflows/ci.yml/badge.svg)](https://github.com/theroks/pnpm-audit-promote/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pnpm-audit-promote.svg)](https://www.npmjs.com/package/pnpm-audit-promote)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/pnpm-audit-promote.svg)](./package.json)

Refresh a pnpm workspace, run `pnpm audit --fix`, and **promote any
catalog-eligible overrides back into the pnpm catalog**.

Direct-dependency vulnerabilities (those resolved by a catalog package) get the
catalog bumped _before_ `pnpm audit --fix` runs, so they never end up as
overrides. Transitive-only vulnerabilities are still handled by
`pnpm audit --fix` adding overrides as usual.

## Why

In a pnpm 10+ workspace using [catalogs][pnpm-catalogs], `pnpm audit --fix`
naively pins fixes via `overrides:`. For packages that are already declared in
the catalog, this is the wrong place — the fix should land in the catalog so
every workspace package picks it up consistently. This tool runs the audit
flow and then reconciles overrides back into the catalog.

[pnpm-catalogs]: https://pnpm.io/catalogs

## Install

```sh
# global
npm i -g pnpm-audit-promote

# or run on demand
pnpm dlx pnpm-audit-promote
npx pnpm-audit-promote
```

Requires Node.js >= 22 and `pnpm` available on `PATH`.

## Usage

```sh
pnpm-audit-promote [options]
```

| Flag                        | Description                                                 | Default |
| --------------------------- | ----------------------------------------------------------- | ------- |
| `-p, --path <dir>`          | Workspace root containing `pnpm-workspace.yaml`             | `cwd`   |
| `-f, --force` / `-y, --yes` | Skip the destructive-action confirmation prompt             | `false` |
| `-n, --dry-run`             | Plan and log changes without writing files or invoking pnpm | `false` |
| `--no-audit`                | Skip the audit + catalog promotion phase                    |         |
| `--no-dedupe`               | Skip `pnpm dedupe` calls                                    |         |
| `-v, --verbose`             | Verbose output                                              | `false` |
| `-q, --quiet`               | Quiet output (warnings + errors only)                       | `false` |
| `-V, --version`             | Print version                                               |         |
| `-h, --help`                | Print help                                                  |         |

### Example

```sh
pnpm-audit-promote --force
pnpm-audit-promote --dry-run --verbose
```

## What it does (in order)

1. Remove `pnpm-lock.yaml`
2. Remove every `node_modules` folder under the workspace
3. Strip the `overrides:` block from `pnpm-workspace.yaml`
4. Strip `pnpm.overrides` from every `package.json`
5. `pnpm install`
6. `pnpm dedupe` (skip with `--no-dedupe`)
7. Pre-audit catalog bump for direct-dep vulnerabilities
8. `pnpm audit --fix` (transitive vulnerabilities)
9. Promote any catalog-eligible audit overrides back into the catalog
10. `pnpm install`
11. `pnpm dedupe` (skip with `--no-dedupe`)

After every pnpm command the tool re-applies the _desired_ `pnpm-workspace.yaml`
because pnpm 10 normalizes the file on install/up and may silently drop
settings (e.g. `savePrefix: ''`) or bump catalog versions.

### Concrete example

Before:

```yaml
# pnpm-workspace.yaml
catalog:
  react: '18.2.0'
  lodash: '4.17.20'
```

`pnpm audit --fix` would normally produce:

```yaml
catalog:
  react: '18.2.0'
  lodash: '4.17.20'
overrides:
  react: '18.3.1' # direct dep — should live in the catalog
  'foo@<1.0.0': '1.0.1' # transitive — keep as override
```

After `pnpm-audit-promote`:

```yaml
catalog:
  react: '18.3.1'
  lodash: '4.17.20'
overrides:
  'foo@<1.0.0': '1.0.1'
```

## Programmatic API

```ts
import { refreshDeps, createLogger } from 'pnpm-audit-promote';

await refreshDeps({
  path: '/path/to/workspace',
  force: true,
  dryRun: false,
  logger: createLogger({ level: 'verbose' }),
});
```

The exported surface includes `refreshDeps`, `createLogger`, `consoleLogger`,
`silentLogger`, `WorkspaceState`, `createPnpmRunner`, and `ensurePnpmAvailable`.
The `pnpm` option on `RefreshOptions` allows injecting a custom `PnpmRunner`
implementation, for example in tests.

## Limitations

- The YAML and JSON edits are regex-based to preserve formatting bit-for-bit;
  unusual constructs (YAML anchors, custom comments inside the catalog block)
  are not deeply parsed.
- Only the root `package.json`'s `pnpm.overrides` is promoted into the catalog.
- `pnpm` must be available on `PATH`. The tool does not bundle pnpm.
- Direct-dependency promotion uses `pnpm audit --json`; if pnpm changes that
  schema, the pre-audit bump becomes a no-op (the safety net via post-audit
  promotion still works).

## Troubleshooting

- **`pnpm is not installed or not on PATH`** — install pnpm globally
  (`npm i -g pnpm`) or use Corepack.
- **Refusing to run destructive operations non-interactively** — re-run with
  `--force` (or `--yes`) when running from CI.
- **A `node_modules` folder cannot be fully removed (Windows)** — close any
  process holding files open (editors, dev servers) and re-run.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
