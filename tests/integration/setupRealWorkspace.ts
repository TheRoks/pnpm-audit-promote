import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Whether integration tests should run. Use as
 * `describe.skipIf(!shouldRunIntegration())(...)` so unit runs stay fast.
 */
export function shouldRunIntegration(): boolean {
  return process.env['RUN_INTEGRATION'] === '1' || process.env['RUN_INTEGRATION'] === 'true';
}

/**
 * The pnpm major version the harness should set up. Defaults to whatever the
 * shell `pnpm --version` reports. CI sets `INTEGRATION_PNPM_MAJOR` per matrix
 * entry so we can sanity-check the fixture matches the binary.
 */
export function expectedPnpmMajor(): number | null {
  const raw = process.env['INTEGRATION_PNPM_MAJOR'];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the actual pnpm binary major by invoking `pnpm --version`. Returns
 * null when pnpm is not on PATH (in which case integration tests should be
 * skipped with a clear message).
 */
export function detectPnpmMajor(): number | null {
  const result = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return null;
  const m = /^v?(\d+)\./.exec(result.stdout.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

export interface RealWorkspace {
  /** Absolute path to the temp workspace. */
  root: string;
  /** Read the current contents of `pnpm-workspace.yaml`, or '' if missing. */
  readWorkspaceYaml(): string;
  /** Read the current contents of root `package.json`, parsed. */
  readPackageJson(): unknown;
  /** Cleanup temp dir; safe to call repeatedly. */
  cleanup(): void;
}

/**
 * Copy a fixture from `tests/integration/fixtures/<name>/` into a fresh temp
 * directory. The temp dir is registered for cleanup by the caller's
 * `afterEach`.
 *
 * Fixtures must be self-contained pnpm workspaces (a pnpm-workspace.yaml
 * and/or root package.json with `packageManager` set). Fixtures must NOT
 * commit `node_modules` or `pnpm-lock.yaml` — the harness expects to install
 * fresh.
 */
export function setupRealWorkspace(fixtureName: string): RealWorkspace {
  const fixtureDir = path.join(import.meta.dirname, 'fixtures', fixtureName);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`Integration fixture not found: ${fixtureDir}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pap-int-${fixtureName}-`));
  copyDir(fixtureDir, tmp);
  return {
    root: tmp,
    readWorkspaceYaml() {
      const p = path.join(tmp, 'pnpm-workspace.yaml');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    },
    readPackageJson() {
      return JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    },
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
