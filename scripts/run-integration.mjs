#!/usr/bin/env node
/**
 * Cross-platform launcher for the integration test suite.
 * Sets RUN_INTEGRATION=1 and forwards extra args to vitest.
 */
import { spawn } from 'node:child_process';

const args = ['vitest', 'run', 'tests/integration', ...process.argv.slice(2)];
const child = spawn('pnpm', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, RUN_INTEGRATION: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
