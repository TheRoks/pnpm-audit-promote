# pnpm 11 integration fixture

A deterministic fixture for CI smoke/integration coverage of pnpm 11 behavior.

Used by `.github/workflows/ci.yml` to verify:

- pnpm 11 workspace detection
- audit invocation path (`pnpm audit --fix override`)
- temporary `minimumReleaseAge: 0` override is restored after the run
