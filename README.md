# pnpm-audit-promote

[![CI](https://github.com/TheRoks/pnpm-audit-promote/actions/workflows/ci.yml/badge.svg)](https://github.com/TheRoks/pnpm-audit-promote/actions/workflows/ci.yml)
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

The target directory qualifies as a workspace root when **any** of the following are present:

- `pnpm-workspace.yaml`, or
- `pnpm-lock.yaml`, or
- `package.json` whose `packageManager` field starts with `pnpm@` (e.g. `"pnpm@10.0.0"`), or
- `package.json` with a `pnpm` config object (e.g. a bare `pnpm.overrides`).

When `pnpm-workspace.yaml` is absent, the tool still runs the lockfile / `node_modules` cleanup, strips `pnpm.overrides` from `package.json`, and runs `pnpm install` and `pnpm audit --fix`. Catalog promotion steps are skipped because pnpm catalogs only live in `pnpm-workspace.yaml`.

If an **enclosing** `pnpm-workspace.yaml` is found in any parent directory, the tool refuses to run by default and throws `EnclosingWorkspaceError`. This prevents `pnpm install` from silently walking up and mutating the parent monorepo's lockfile and `pnpm-workspace.yaml`. To proceed, either re-run with `--path <enclosing workspace root>` to operate on the parent, or pass `--ignore-workspace` to keep all operations local to `--path`.

## Usage

```sh
pnpm-audit-promote [options]
```

| Flag                        | Description                                                                                                                                                                                                | Default |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-p, --path <dir>`          | Workspace root (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, or `package.json` declaring pnpm)                                                                                                                 | `cwd`   |
| `-f, --force` / `-y, --yes` | Skip the destructive-action confirmation prompt                                                                                                                                                            | `false` |
| `-n, --dry-run`             | Plan and log changes without writing files or pnpm                                                                                                                                                         | `false` |
| `--no-audit`                | Skip the audit + catalog promotion phase                                                                                                                                                                   |         |
| `--no-dedupe`               | Skip `pnpm dedupe` calls                                                                                                                                                                                   |         |
| `--allow-major`             | Allow catalog bumps that cross a major version boundary (still logged as warnings). Use `--no-allow-major` to refuse them and keep the bump as an override.                                                | `true`  |
| `--no-summary`              | Suppress the terminal-pretty run summary printed at the end                                                                                                                                                |         |
| `--summary-file <path>`     | Also write a plain-text (no ANSI) copy of the run summary to the given path                                                                                                                                |         |
| `--ignore-workspace`        | Treat `--path` as the workspace root even when an enclosing `pnpm-workspace.yaml` is found in a parent directory. Forwards `--ignore-workspace` to every pnpm invocation so installs/overrides stay local. | `false` |
| `-v, --verbose`             | Verbose output (raw pnpm output + tracing)                                                                                                                                                                 | `false` |
| `-q, --quiet`               | Quiet output (warnings + errors only)                                                                                                                                                                      | `false` |
| `-V, --version`             | Print version                                                                                                                                                                                              |         |
| `-h, --help`                | Print help                                                                                                                                                                                                 |         |

### Example

```sh
pnpm-audit-promote --force
pnpm-audit-promote --dry-run --verbose

# operate on a single package nested inside another pnpm monorepo
pnpm-audit-promote --path ./examples/angular-v20 --ignore-workspace --force
```

A minimal end-to-end fixture lives under [`examples/basic`](./examples/basic/) — see its [README](./examples/basic/README.md) for a `--dry-run` walkthrough.

### Output modes

- **Default (`normal`)**: clean, decision-focused CLI output (phases, actions, and outcomes).
- **`--verbose`**: includes everything from default mode plus raw `pnpm` command output.
- **`--quiet`**: warnings + errors only.

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

const result = await refreshDeps({
  path: '/path/to/workspace',
  force: true,
  dryRun: false,
  logger: createLogger({ level: 'verbose' }),
  // Optional — all default-friendly:
  // skipAudit: false,
  // skipDedupe: false,
  // allowMajor: true,
  // ignoreWorkspace: false, // forward --ignore-workspace to pnpm
  // summary: true,          // render terminal summary at the end
  // summaryFile: './summary.txt',
  // confirm: async ({ force, dryRun }) => true, // override the destructive-action prompt
  // pnpm: customPnpmRunner, // inject a fake/recording PnpmRunner in tests
});

console.log(`Fixed ${result.fixedAdvisories.length} vulnerabilities in ${result.durationMs}ms.`);
```

`refreshDeps` resolves to a [`RefreshResult`](./src/refresh.ts) with:

- `canceled` — `true` when the destructive-action prompt was declined.
- `durationMs` — wall-clock duration of the run.
- `catalogChanges`, `overrideChanges` — direct-dep catalog bumps and the overrides that were added/modified.
- `initialAdvisories`, `finalAdvisories`, `fixedAdvisories` — the audit-derived vulnerability sets before, after, and the diff.
- `summary` — the full structured `RunSummaryData` regardless of the `summary` rendering flag (so CI can serialize it).

### Exported surface

`refreshDeps`, `RefreshOptions`, `RefreshResult`,
`createLogger`, `consoleLogger`, `silentLogger`, `Logger`, `LogLevel`, `ConsoleLoggerOptions`,
`WorkspaceState`,
`createPnpmRunner`, `ensurePnpmAvailable`, `PnpmRunner`, `PnpmOptions`,
`renderTerminalSummary`, `RenderOptions`,
`AdvisorySummary`, `CatalogChange`, `OverrideChange`, `RunSummaryData`, `Severity`,
`ConfirmFn`, `ConfirmContext`,
and the typed errors
`WorkspaceNotFoundError`, `EnclosingWorkspaceError`, `PnpmNotInstalledError`, `PnpmCommandFailedError`, `NonInteractiveConfirmationError`.

The `pnpm` option on `RefreshOptions` allows injecting a custom `PnpmRunner` implementation (for tests or advanced integrations). The `confirm` option overrides the default stdin-based destructive-action prompt — useful in CI or when wrapping the tool in another UI.

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
- **`Refusing to operate on '<path>': an enclosing pnpm workspace was found at '<parent>'`**
  — the directory you targeted sits inside another pnpm workspace. `pnpm install` would walk up and mutate that parent's `pnpm-workspace.yaml` and `pnpm-lock.yaml`. Either re-run with `--path <parent>` to refresh the whole monorepo, or pass `--ignore-workspace` to keep every pnpm invocation local to your `--path`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
