# Integration fixtures

These workspaces are copied into a temp dir by
[`setupRealWorkspace.ts`](../setupRealWorkspace.ts) and then operated on by
real `pnpm` and the `refreshDeps` API. Tests are gated behind
`RUN_INTEGRATION=1` (`pnpm test:integration`).

## Determinism

Each fixture deliberately pins a known-vulnerable version with a stable
fix:

| Fixture            | Vulnerable dep   | Advisory                                  | Fixed in  |
| ------------------ | ---------------- | ----------------------------------------- | --------- |
| `v10-direct-vuln/` | `lodash@4.17.20` | GHSA-35jh-r3h4-6jhm (prototype pollution) | `4.17.21` |
| `v11-direct-vuln/` | `lodash@4.17.20` | GHSA-35jh-r3h4-6jhm (prototype pollution) | `4.17.21` |

If the npm registry ever unpublishes one of these versions, refresh the
fixture with the next stable equivalent — the harness will fail loudly so
the drift cannot pass silently.

## Fixture rules

- No `node_modules/` or `pnpm-lock.yaml` committed — the harness expects to
  install fresh.
- Each fixture is self-contained (root `package.json` declares pnpm via
  `packageManager` for v10 or `devEngines.packageManager` for v11).
- Children (under `apps/`) reference the catalog with `catalog:` so a
  catalog bump propagates without further edits.
