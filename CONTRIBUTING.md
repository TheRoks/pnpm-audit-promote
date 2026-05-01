# Contributing

Thanks for your interest in contributing!

## Prerequisites

- Node.js >= 22
- pnpm >= 10

## Setup

```sh
pnpm install
pnpm run gen:version  # generates src/version.ts
```

## Development scripts

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `pnpm test`          | Run the Vitest suite once                     |
| `pnpm test:watch`    | Watch mode                                    |
| `pnpm coverage`      | Run tests with v8 coverage                    |
| `pnpm typecheck`     | Type-check without emit                       |
| `pnpm lint`          | ESLint                                        |
| `pnpm format`        | Prettier write                                |
| `pnpm format:check`  | Prettier check (CI)                           |
| `pnpm build`         | Compile to `dist/`                            |
| `pnpm check:exports` | `publint` + `attw` against the packed tarball |

## Pull requests

1. Fork and create a topic branch.
2. Add a changeset for any user-visible change: `pnpm changeset`.
3. Ensure CI passes locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
4. Open a PR. Describe the change and link any relevant issue.

## Releasing

Releases are automated via [Changesets](https://github.com/changesets/changesets). Merging
the auto-generated "Version Packages" PR triggers `pnpm publish` with npm provenance via
GitHub Actions OIDC. Maintainers must configure the `NPM_TOKEN` secret.
