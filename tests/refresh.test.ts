import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshDeps } from '../src/refresh.js';
import { silentLogger } from '../src/logger.js';
import type { PnpmRunner } from '../src/pnpm.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-int-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RecordedCall {
  args: string[];
  capture?: boolean;
}

function makeRecordingRunner(stdoutByCmd: Record<string, string> = {}): {
  runner: PnpmRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: PnpmRunner = {
    async run(args) {
      calls.push({ args });
    },
    async runAllowFail(args) {
      calls.push({ args });
      return 0;
    },
    async capture(args) {
      calls.push({ args, capture: true });
      const key = args.join(' ');
      return { stdout: stdoutByCmd[key] ?? '', exitCode: 0 };
    },
  };
  return { runner, calls };
}

describe('refreshDeps integration (mocked pnpm)', () => {
  it('completes happy path with skipAudit and skipDedupe', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n\ncatalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', private: true }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const { runner, calls } = makeRecordingRunner();

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(fs.existsSync(path.join(tmp, 'pnpm-lock.yaml'))).toBe(false);
    // exactly one pnpm install call when audit + dedupe skipped
    const installs = calls.filter((c) => c.args[0] === 'install');
    expect(installs).toHaveLength(1);
  });

  it('dry-run does not delete the lockfile or invoke pnpm', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'x', 'utf8');

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      dryRun: true,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(fs.existsSync(path.join(tmp, 'pnpm-lock.yaml'))).toBe(true);
  });

  it('promotes direct-dep audit findings into catalog', async () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'react',
          patched_versions: '>=18.3.1',
          findings: [{ paths: ['. > react'] }],
        },
      },
    });

    const { runner } = makeRecordingRunner({ 'audit --json': auditJson });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(final).toContain("react: '18.3.1'");
  });
});
