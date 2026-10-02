# Contributing

Thanks for your interest in contributing!

## Prerequisites

- Node.js >= 22
- pnpm 11.1.2 (the repository's `packageManager` pin); pnpm 10, 11, and 12 are supported target workspaces
- Node.js >= 22.13.0 when running a pnpm 12 target

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

## Requirement IDs

Behavioral requirements live in [REQUIREMENTS.md](./REQUIREMENTS.md) and have
stable IDs of the form `REQ-<AREA>-<NNN>` (e.g. `REQ-PNPM11-003`). Tests are
bound to requirements by prefixing the `it()` (or `test()`) title with the
matching ID(s):

```ts
it('REQ-PNPM11-003: restores the user’s original minimumReleaseAge', () => {
  // ...
});

// Multiple IDs allowed when one test covers more than one requirement:
it('REQ-CATALOG-001, REQ-CATALOG-002: preserves quoting and EOL', () => {
  // ...
});
```

Run `node scripts/check-traceability.mjs` (or `pnpm traceability`) to
regenerate [docs/traceability.md](./docs/traceability.md) and to verify that
every requirement is covered by at least one test.

When adding behavior:

1. Add or update a requirement in `REQUIREMENTS.md` (never re-use a deleted
   ID; mark obsolete ones `(deprecated)` and keep them in place).
2. Reference the ID in the corresponding test titles.
3. Re-run the traceability script.

## Integration tests (real pnpm)

Integration tests under `tests/integration/**` shell out to a real `pnpm`
binary and are skipped by default to keep `pnpm test` fast. Enable them with:

```sh
pnpm test:integration
```

CI exercises pnpm 10, 11, and 12 via the `integration` matrix. pnpm 12 also
runs on macOS and Windows to cover its native executables. The launcher invokes
Vitest through Node directly so the repository's package-manager pin cannot
silently replace the integration target.

## Releasing

Releases trigger `pnpm publish` with npm provenance via GitHub Actions OIDC.
Maintainers must configure the `NPM_TOKEN` secret.
