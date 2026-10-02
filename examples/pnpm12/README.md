# pnpm 12 example workspace

This workspace demonstrates the pnpm 12 settings supported by
`pnpm-audit-promote`. It pins pnpm 12.8.1, uses the canonical `audit` config,
and enables install-time deduplication.

Preview the workflow without invoking pnpm or modifying files:

```sh
pnpm-audit-promote --path examples/pnpm12 --dry-run --force
```

The default audit strategy is `override`, which keeps catalog promotion
available. To use pnpm's direct lockfile update mode instead, pass
`--audit-fix-mode update` (pnpm 11 or newer).
