# pnpm 11 example workspace

A deterministic fixture for CI smoke/integration coverage of pnpm 11 behavior.

The workspace pins pnpm 11 and configures a 12-hour `minimumReleaseAge`.
Running `pnpm-audit-promote --path examples/pnpm11 --dry-run --force`
illustrates target-version detection and the override audit-fix path without
changing files.
