import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * End-to-end CLI tests: spawn the built `dist/cli.js` and assert on exit
 * code + stdout/stderr. The build is performed once on demand if `dist/cli.js`
 * is missing so the suite is self-sufficient locally and in CI.
 *
 * These tests are intentionally lightweight — they exercise argument parsing
 * and exit-code surface only; the underlying `refreshDeps` behavior is
 * already covered by unit + integration tests.
 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const cliEntry = path.join(repoRoot, 'dist', 'cli.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  .version as string;

beforeAll(() => {
  if (!fs.existsSync(cliEntry)) {
    const result = spawnSync('pnpm', ['run', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(`pnpm run build failed:\n${result.stdout}\n${result.stderr}`);
    }
  }
}, 120_000);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd?: string; stdinTty?: boolean } = {}): RunResult {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    // Closing stdin (no inherit, no pipe by default? spawnSync defaults to
    // 'pipe') simulates a non-TTY for the prompt path.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-cli-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeBasicFixture(): string {
  fs.writeFileSync(
    path.join(tmp, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n\ncatalog:\n  react: '18.2.0'\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@10.33.0' }, null, 2),
    'utf8',
  );
  return tmp;
}

describe('CLI: built dist/cli.js', () => {
  it('REQ-CLI-001: --help prints usage and exits 0', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:.*pnpm-audit-promote/);
    expect(r.stdout).toContain('--path');
    expect(r.stdout).toContain('--force');
    expect(r.stdout).toContain('--dry-run');
  });

  it('REQ-CLI-001: -h prints usage and exits 0', () => {
    const r = runCli(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:.*pnpm-audit-promote/);
  });

  it('REQ-CLI-002: --version prints package.json version and exits 0', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion);
  });

  it('REQ-CLI-002: -V prints package.json version and exits 0', () => {
    const r = runCli(['-V']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion);
  });

  it('REQ-CLI-003: an unknown flag exits non-zero with a usage error', () => {
    const r = runCli(['--definitely-not-a-flag']);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/unknown option|error/);
  });

  it('REQ-CLI-015, REQ-WORKSPACE-006: a non-existent path exits non-zero with the workspace error', () => {
    const missing = path.join(tmp, 'does-not-exist');
    const r = runCli(['--path', missing, '--force', '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/No pnpm workspace found/);
  });

  it('REQ-CLI-015, REQ-SAFETY-002: non-TTY stdin without --force exits non-zero with NonInteractiveConfirmationError', () => {
    const root = makeBasicFixture();
    const r = runCli(['--path', root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/non-interactively/i);
  });

  it('REQ-CLI-004, REQ-CLI-005, REQ-CLI-006, REQ-CLI-007, REQ-CLI-008: --path/--force/--dry-run/--no-audit/--no-dedupe accept values and exit 0', () => {
    const root = makeBasicFixture();
    const r = runCli(['--path', root, '--force', '--dry-run', '--no-audit', '--no-dedupe']);
    expect(r.status).toBe(0);
    // Dry-run guarantees the workspace yaml is unchanged.
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).toContain("react: '18.2.0'");
  });

  it('REQ-CLI-005: -y is an alias for --force', () => {
    const root = makeBasicFixture();
    const r = runCli(['--path', root, '-y', '--dry-run', '--no-audit', '--no-dedupe']);
    expect(r.status).toBe(0);
  });

  it('REQ-CLI-009: --no-allow-major is accepted and exits 0', () => {
    const root = makeBasicFixture();
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--no-allow-major',
    ]);
    expect(r.status).toBe(0);
  });

  it('REQ-CLI-010: --no-summary suppresses the summary banner', () => {
    const root = makeBasicFixture();
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--no-summary',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Run summary|Catalog changes/i);
  });

  it('REQ-CLI-011, REQ-SUMMARY-005: --summary-file accepts an in-workspace path and skips writing during --dry-run', () => {
    const root = makeBasicFixture();
    const summaryPath = path.join(root, 'summary.txt');
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--summary-file',
      summaryPath,
    ]);
    expect(r.status).toBe(0);
    // Dry-run must not write the summary file (REQ-SUMMARY-005).
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it('REQ-CLI-012: --ignore-workspace is accepted and exits 0', () => {
    const root = makeBasicFixture();
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--ignore-workspace',
    ]);
    expect(r.status).toBe(0);
  });

  it('REQ-CLI-013: --verbose is accepted and exits 0 (and emits more output than default)', () => {
    const root = makeBasicFixture();
    const verbose = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--verbose',
    ]);
    const normal = runCli(['--path', root, '--force', '--dry-run', '--no-audit', '--no-dedupe']);
    expect(verbose.status).toBe(0);
    expect(normal.status).toBe(0);
    // Verbose should never produce strictly less output than normal.
    expect(verbose.stdout.length).toBeGreaterThanOrEqual(normal.stdout.length);
  });

  it('REQ-CLI-014: --quiet is accepted and exits 0 (and emits less output than default)', () => {
    const root = makeBasicFixture();
    const quiet = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--quiet',
    ]);
    const normal = runCli(['--path', root, '--force', '--dry-run', '--no-audit', '--no-dedupe']);
    expect(quiet.status).toBe(0);
    expect(normal.status).toBe(0);
    expect(quiet.stdout.length).toBeLessThanOrEqual(normal.stdout.length);
  });

  it('REQ-LOGGING-007: last flag wins when --verbose precedes --quiet', () => {
    const root = makeBasicFixture();
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--verbose',
      '--quiet',
    ]);
    const verbose = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--verbose',
    ]);
    expect(r.status).toBe(0);
    // With --quiet last, output should be no more than verbose-only run.
    expect(r.stdout.length).toBeLessThanOrEqual(verbose.stdout.length);
  });

  it('REQ-LOGGING-007: last flag wins when --quiet precedes --verbose', () => {
    const root = makeBasicFixture();
    const r = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--quiet',
      '--verbose',
    ]);
    const quiet = runCli([
      '--path',
      root,
      '--force',
      '--dry-run',
      '--no-audit',
      '--no-dedupe',
      '--quiet',
    ]);
    expect(r.status).toBe(0);
    // With --verbose last, output should be at least as much as quiet-only run.
    expect(r.stdout.length).toBeGreaterThanOrEqual(quiet.stdout.length);
  });
});
