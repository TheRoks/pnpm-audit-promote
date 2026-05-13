import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests live under tests/integration/ and are gated behind
    // RUN_INTEGRATION=1 (see `pnpm test:integration` / scripts/run-integration.mjs).
    // They shell out to a real pnpm binary and are slow, so they are
    // excluded from the default unit-test run.
    exclude: process.env['RUN_INTEGRATION']
      ? ['node_modules/**', 'dist/**']
      : ['node_modules/**', 'dist/**', 'tests/integration/**'],
    testTimeout: process.env['RUN_INTEGRATION'] ? 600_000 : 5_000,
    hookTimeout: process.env['RUN_INTEGRATION'] ? 600_000 : 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/index.ts', 'src/summary.ts'],
      thresholds: {
        statements: 90,
        branches: 78,
        functions: 95,
        lines: 93,
      },
    },
  },
});
