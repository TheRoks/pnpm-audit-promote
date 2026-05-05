import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  shims: false,
  // Emit `.js`/`.d.ts` (rather than tsdown's default `.mjs`/`.d.mts`) so the
  // published `bin` and `exports` paths in package.json resolve correctly.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // Keep all runtime dependencies external (default) so we ship a thin wrapper.
});
