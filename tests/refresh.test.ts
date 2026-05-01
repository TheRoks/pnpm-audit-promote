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

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view react versions --json': JSON.stringify(['18.2.0', '18.3.1']),
    });

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

  it('prefers patch over minor when both satisfy the advisory', async () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'react',
          patched_versions: '>=18.2.1',
          findings: [{ paths: ['. > react'] }],
        },
      },
    });

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view react versions --json': JSON.stringify(['18.2.1', '18.3.1', '19.0.0']),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(final).toContain("react: '18.2.1'");
  });

  it('bumps catalog entries for packages that are deps of child workspace packages (not root)', async () => {
    // Regression: the old `isDirect` check required the audit finding path to
    // start with `.`, so packages like `vite` that appeared as
    // `apps/web > vite` were skipped, and pnpm audit --fix would then write
    // a broad range override that resolved to the latest (major) version.
    const yaml = "catalog:\n  vite: '6.3.5'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'vite',
          patched_versions: '>=6.4.2',
          // path starts with a child workspace package, NOT `.`
          findings: [{ paths: ['apps__web>vite'] }],
        },
      },
    });

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view vite versions --json': JSON.stringify([
        '6.3.5',
        '6.4.0',
        '6.4.1',
        '6.4.2',
        '7.0.0',
        '7.3.2',
      ]),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    // Should pick the smallest patched version in the same major (minor bump),
    // NOT the latest available (7.3.2).
    expect(final).toContain("vite: '6.4.2'");
    expect(final).not.toContain('7.');
  });

  it('warns and bumps to major when only a major satisfies', async () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'react',
          patched_versions: '>=19.0.0',
          findings: [{ paths: ['. > react'] }],
        },
      },
    });

    const warnings: string[] = [];
    const recordingLogger = {
      ...silentLogger,
      warn(msg: string) {
        warnings.push(msg);
      },
    };

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view react versions --json': JSON.stringify(['18.2.0', '18.3.1', '19.0.0']),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: recordingLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(final).toContain("react: '19.0.0'");
    expect(warnings.some((w) => /Major version bump required for react/.test(w))).toBe(true);
  });

  it('skips a major bump when allowMajor is false', async () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'react',
          patched_versions: '>=19.0.0',
          findings: [{ paths: ['. > react'] }],
        },
      },
    });

    const warnings: string[] = [];
    const recordingLogger = {
      ...silentLogger,
      warn(msg: string) {
        warnings.push(msg);
      },
    };

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view react versions --json': JSON.stringify(['18.2.0', '19.0.0']),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: recordingLogger,
      pnpm: runner,
      skipDedupe: true,
      allowMajor: false,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(final).toContain("react: '18.2.0'"); // unchanged
    expect(warnings.some((w) => /--no-allow-major/.test(w) || /--allow-major/.test(w))).toBe(true);
  });

  it('does not strip pnpm.overrides from package.json excluded by workspace config', async () => {
    // packages: only includes storybook/*, explicitly excludes examples/*
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      ['packages:', '  - "packages/@repo/*"', '  - "storybook/*"', '  - "!examples/*"', ''].join(
        '\n',
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', private: true }, null, 2),
      'utf8',
    );

    // Included workspace package — overrides SHOULD be stripped
    const includedDir = path.join(tmp, 'storybook', 'app');
    fs.mkdirSync(includedDir, { recursive: true });
    const includedPj = JSON.stringify(
      { name: 'storybook-app', pnpm: { overrides: { lodash: '^4.17.21' } } },
      null,
      2,
    );
    fs.writeFileSync(path.join(includedDir, 'package.json'), includedPj, 'utf8');

    // Excluded package — overrides should NOT be stripped
    const excludedDir = path.join(tmp, 'examples', 'ng16');
    fs.mkdirSync(excludedDir, { recursive: true });
    const excludedPj = JSON.stringify(
      { name: 'example-ng16', pnpm: { overrides: { lodash: '^4.17.21' } } },
      null,
      2,
    );
    fs.writeFileSync(path.join(excludedDir, 'package.json'), excludedPj, 'utf8');

    const { runner } = makeRecordingRunner();
    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipAudit: true,
      skipDedupe: true,
    });

    // Included package should have overrides stripped
    const includedResult = fs.readFileSync(path.join(includedDir, 'package.json'), 'utf8');
    expect(includedResult).not.toContain('"overrides"');

    // Excluded package must be left untouched
    const excludedResult = fs.readFileSync(path.join(excludedDir, 'package.json'), 'utf8');
    expect(excludedResult).toContain('"overrides"');
  });
});
