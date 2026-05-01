# Contributing

Thanks for your interest in contributing!

## Prerequisites

- Node.js >= 22
- pnpm >= 10

## Setup

```sh
pnpm install
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
2. Ensure CI passes locally (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
3. Open a PR. Describe the change and link any relevant issue.

## Releasing

Releases trigger `pnpm publish` with npm provenance via GitHub Actions OIDC.
Maintainers must configure the `NPM_TOKEN` secret.
