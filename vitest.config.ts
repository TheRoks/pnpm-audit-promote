import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/version.ts', 'src/index.ts'],
      thresholds: {
        statements: 65,
        branches: 65,
        functions: 70,
        lines: 65,
      },
    },
  },
});
