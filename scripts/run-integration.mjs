#!/usr/bin/env node
/**
 * Cross-platform launcher for the integration test suite.
 * Sets RUN_INTEGRATION=1 and forwards extra args to vitest.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const args = [vitestCli, 'run', 'tests/integration', ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, RUN_INTEGRATION: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
