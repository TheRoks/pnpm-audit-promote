import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshDeps } from '../src/refresh';
import { silentLogger } from '../src/logger';
import { makeRecordingRunner } from './helpers/recordingRunner';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-int-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('refreshDeps integration (mocked pnpm)', () => {
  it('REQ-SAFETY-002: rejects destructive execution in non-interactive mode without --force', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const { runner } = makeRecordingRunner();
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(
        refreshDeps({
          path: tmp,
          logger: silentLogger,
          pnpm: runner,
        }),
      ).rejects.toThrow(/Refusing to run destructive operations non-interactively/);
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      }
    }
  });

  it('REQ-CORE-001, REQ-CORE-005, REQ-CORE-006, REQ-CORE-007, REQ-RUNNER-007: completes happy path with skipAudit and skipDedupe', async () => {
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
    // REQ-CORE-007: every install must use --no-frozen-lockfile so that
    // CI runs (which default pnpm to --frozen-lockfile) don't reject installs
    // that follow the tool's own catalog/override mutations.
    expect(installs[0]!.args).toEqual(['install', '--no-frozen-lockfile']);
  });

  it('REQ-WORKSPACE-008: runs without a pnpm-workspace.yaml when package.json declares pnpm', async () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify(
        {
          name: 'root',
          private: true,
          packageManager: 'pnpm@10.0.0',
          pnpm: { overrides: { react: '18.3.1' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const { runner, calls } = makeRecordingRunner();

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'pnpm-lock.yaml'))).toBe(false);
    const installs = calls.filter((c) => c.args[0] === 'install');
    expect(installs).toHaveLength(1);
    // pnpm.overrides should still be stripped from root package.json
    const pj = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: unknown;
    };
    expect(pj.pnpm).toBeUndefined();
  });

  it('REQ-WORKSPACE-007: throws EnclosingWorkspaceError when a parent workspace is detected', async () => {
    const sub = path.join(tmp, 'examples', 'angular');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'examples/*'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(sub, 'package.json'),
      JSON.stringify({ name: 'sub', pnpm: { overrides: {} } }),
      'utf8',
    );

    const { runner } = makeRecordingRunner();

    await expect(
      refreshDeps({
        path: sub,
        force: true,
        logger: silentLogger,
        pnpm: runner,
        skipAudit: true,
        skipDedupe: true,
      }),
    ).rejects.toThrow(/enclosing pnpm workspace/i);
  });

  it('REQ-WORKSPACE-007, REQ-PNPM11-008: honors ignoreWorkspace and proceeds despite an enclosing workspace', async () => {
    const sub = path.join(tmp, 'examples', 'angular');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'examples/*'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(sub, 'package.json'),
      JSON.stringify({ name: 'sub', pnpm: { overrides: { react: '18.3.1' } } }),
      'utf8',
    );
    fs.writeFileSync(path.join(sub, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const { runner, calls } = makeRecordingRunner();

    const result = await refreshDeps({
      path: sub,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      ignoreWorkspace: true,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(false);
    // The local sub-package's lockfile is removed, but the parent's is untouched.
    expect(fs.existsSync(path.join(sub, 'pnpm-lock.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(true);
    const installs = calls.filter((c) => c.args[0] === 'install');
    expect(installs).toHaveLength(1);
    // pnpm.overrides was stripped from the sub-package's package.json
    const pj = JSON.parse(fs.readFileSync(path.join(sub, 'package.json'), 'utf8')) as {
      pnpm?: unknown;
    };
    expect(pj.pnpm).toBeUndefined();
  });

  it('REQ-CORE-002: dry-run does not delete the lockfile or invoke pnpm', async () => {
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

  it('REQ-LOGGING-006: reports numbered progress steps including cleanup phase', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const steps: string[] = [];
    const recordingLogger = {
      ...silentLogger,
      step(message: string) {
        steps.push(message);
      },
    };

    const { runner } = makeRecordingRunner();

    await refreshDeps({
      path: tmp,
      force: true,
      logger: recordingLogger,
      pnpm: runner,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(steps).toContain('Step 1/6 — Remove pnpm lockfile');
    expect(steps).toContain('Step 2/6 — Remove node_modules directories');
    expect(steps).toContain('Step 6/6 — Deduplicate dependency graph');
  });

  it('REQ-AUDIT-001, REQ-OVERRIDES-001: promotes direct-dep audit findings into catalog', async () => {
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

  it('REQ-AUDIT-001: prefers patch over minor when both satisfy the advisory', async () => {
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

  it('REQ-AUDIT-001: bumps catalog entries for packages that are deps of child workspace packages (not root)', async () => {
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

  it('REQ-AUDIT-001, REQ-AUDIT-007: uses the patched version for the matching vulnerable range, not another range', async () => {
    const yaml = "catalog:\n  vite: '6.3.5'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'vite',
          vulnerable_versions: '<=6.4.1',
          patched_versions: '>=6.4.2',
          findings: [{ paths: ['. > vite'] }],
        },
        '2': {
          module_name: 'vite',
          vulnerable_versions: '>=7.0.0 <=7.3.1',
          patched_versions: '>=7.3.2',
          findings: [{ paths: ['. > vite'] }],
        },
      },
    });

    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view vite versions --json': JSON.stringify(['6.3.5', '6.4.2', '7.3.2']),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    const final = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(final).toContain("vite: '6.4.2'");
    expect(final).not.toContain('7.3.2');
  });

  it('REQ-AUDIT-003: warns and bumps to major when only a major satisfies', async () => {
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

  it('REQ-AUDIT-002: skips a major bump when allowMajor is false', async () => {
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

  it('REQ-WORKSPACE-009: does not strip pnpm.overrides from package.json excluded by workspace config', async () => {
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

  it('REQ-SAFETY-004, REQ-SAFETY-005: honors an injected confirm() that returns false (canceled result)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const { runner, calls } = makeRecordingRunner();

    const result = await refreshDeps({
      path: tmp,
      logger: silentLogger,
      pnpm: runner,
      confirm: async () => false,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(true);
    expect(result.auditStatus).toBe('skipped');
    expect(result.summary).toBeNull();
    // No pnpm commands should run when canceled.
    expect(calls).toEqual([]);
  });

  it('REQ-CORE-004: returns RefreshResult with catalog diff data on success', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const { runner } = makeRecordingRunner();

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(false);
    expect(result.auditStatus).toBe('skipped');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.catalogChanges)).toBe(true);
    expect(Array.isArray(result.overrideChanges)).toBe(true);
    expect(Array.isArray(result.fixedAdvisories)).toBe(true);
  });

  it('REQ-AUDIT-005: raises the declared floor for ranged deps whose installed version is safe but minimum is not', async () => {
    // Scenario: package.json has `"lodash": "^4.17.20"`.
    // The pre-cleanup locked version is 4.17.20 (vulnerable <=4.17.20).
    // After cleanup + fresh install, pnpm resolves to 4.17.21 (latest in
    // range, safe). The post-cleanup audit sees no lodash advisory.
    // We must still raise the declared minimum from ^4.17.20 to ^4.17.21
    // using the pre-cleanup audit data.
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n\ncatalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
      'utf8',
    );

    // Pre-cleanup audit: lodash 4.17.20 is flagged (the locked minimum).
    const preCleanupAudit = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'lodash',
          vulnerable_versions: '<=4.17.20',
          patched_versions: '>=4.17.21',
          severity: 'high',
        },
      },
    });
    // Post-cleanup audit: 4.17.21 is installed (safe) — no lodash advisory.
    const postCleanupAudit = JSON.stringify({ advisories: {} });

    // The runner returns pre-cleanup data on the first `audit --json` call
    // (before cleanup) and post-cleanup data on subsequent calls.
    let auditCallCount = 0;
    const { runner } = makeRecordingRunner();
    const statefulRunner: typeof runner = {
      ...runner,
      async capture(args) {
        const key = args.join(' ');
        if (key === 'audit --json') {
          auditCallCount += 1;
          return { stdout: auditCallCount === 1 ? preCleanupAudit : postCleanupAudit, exitCode: 0 };
        }
        if (key === 'view lodash versions --json') {
          return { stdout: JSON.stringify(['4.17.20', '4.17.21']), exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
    };

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: statefulRunner,
      skipDedupe: true,
    });

    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Declared minimum must be raised to the smallest non-vulnerable version,
    // preserving the caret prefix.
    expect(result.dependencies['lodash']).toBe('^4.17.21');
  });

  it('REQ-SUMMARY-002, REQ-SUMMARY-006: returns a populated summary and accurate fixedAdvisories even when summary: false', async () => {
    // Regression: previously the `summary: false` branch passed an empty
    // `finalAdvisories: []` to `diffAdvisories`, so every initial advisory
    // was incorrectly reported as fixed and `result.summary` was null.
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    // Same advisory reported on every `audit --json` call: nothing was fixed.
    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'left-pad',
          vulnerable_versions: '<2.0.0',
          patched_versions: '>=2.0.0',
          severity: 'high',
        },
      },
    });
    const { runner } = makeRecordingRunner();
    const stableRunner: typeof runner = {
      ...runner,
      async capture(args) {
        if (args.join(' ') === 'audit --json') {
          return { stdout: auditJson, exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
    };

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: stableRunner,
      skipDedupe: true,
      summary: false,
    });

    // Summary is now always populated on a successful run.
    expect(result.summary).not.toBeNull();
    expect(result.summary?.initialAdvisories).toHaveLength(1);
    expect(result.summary?.finalAdvisories).toHaveLength(1);
    // Nothing was actually cleared, so fixedAdvisories must be empty.
    expect(result.fixedAdvisories).toEqual([]);
    expect(result.finalAdvisories).toHaveLength(1);
    expect(result.auditStatus).toBe('complete');
  });

  it('REQ-SUMMARY-009: accepts valid final audit JSON as complete despite a non-zero exit', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const { runner } = makeRecordingRunner();
    const nonZeroAuditRunner: typeof runner = {
      ...runner,
      async capture(args) {
        if (args.join(' ') === 'audit --json') {
          return { stdout: JSON.stringify({ advisories: {} }), exitCode: 1 };
        }
        return runner.capture(args);
      },
    };

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: nonZeroAuditRunner,
      skipDedupe: true,
      summary: false,
    });

    expect(result.auditStatus).toBe('complete');
    expect(result.fixedAdvisories).toEqual([]);
  });

  it('REQ-SUMMARY-009: preserves unknown status when the final audit capture throws', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const initialAudit = JSON.stringify({
      advisories: {
        '1': { module_name: 'left-pad', severity: 'high', title: 'Example advisory' },
      },
    });
    const warnings: string[] = [];
    const warningLogger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const { runner } = makeRecordingRunner();
    let auditCallCount = 0;
    const throwingFinalRunner: typeof runner = {
      ...runner,
      async capture(args) {
        if (args.join(' ') === 'audit --json') {
          auditCallCount += 1;
          if (auditCallCount === 1) return { stdout: initialAudit, exitCode: 1 };
          if (auditCallCount === 2) {
            return { stdout: JSON.stringify({ advisories: {} }), exitCode: 0 };
          }
          throw new Error('registry unavailable');
        }
        return runner.capture(args);
      },
    };

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: warningLogger,
      pnpm: throwingFinalRunner,
      skipDedupe: true,
      summary: false,
    });

    expect(result.auditStatus).toBe('failed');
    expect(result.summary?.auditStatus).toBe('failed');
    expect(result.finalAdvisories).toEqual([]);
    expect(result.fixedAdvisories).toEqual([]);
    expect(warnings).toContain(
      'Final audit verification failed; fixed and remaining vulnerability counts are unknown.',
    );
  });

  it("REQ-PNPM10-001: uses bare 'audit --fix' when the target workspace pins pnpm 10", async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@10.33.0' }),
      'utf8',
    );
    // Runner reports pnpm 11 to prove the workspace pin wins over the
    // CLI's own pnpm version on PATH.
    const { runner, calls } = makeRecordingRunner({}, { version: '11.0.0' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls).toHaveLength(1);
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix']);
  });

  it("REQ-PNPM11-001: uses 'audit --fix override' when the target workspace pins pnpm 11", async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@11.0.0' }),
      'utf8',
    );
    // Runner reports pnpm 10 to prove the workspace pin wins over the
    // CLI's own pnpm version on PATH.
    const { runner, calls } = makeRecordingRunner({}, { version: '10.33.0' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls).toHaveLength(1);
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix', 'override']);
  });

  it("REQ-PNPM11-001, REQ-PNPM11-005, REQ-WORKSPACE-004: uses 'audit --fix override' when the target workspace declares devEngines.packageManager pnpm 11", async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'root',
        devEngines: { packageManager: { name: 'pnpm', version: '^11.0.0' } },
      }),
      'utf8',
    );
    const { runner, calls } = makeRecordingRunner({}, { version: '10.33.0' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix', 'override']);
  });

  it("REQ-PNPM11-001: falls back to runner.version() and uses 'audit --fix override' when workspace has no pnpm pin", async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    const { runner, calls } = makeRecordingRunner({}, { version: '11.0.0' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls).toHaveLength(1);
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix', 'override']);
  });

  it("REQ-PNPM10-001: falls back to bare 'audit --fix' when runner.version() is unparseable", async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    const { runner, calls } = makeRecordingRunner({}, { version: 'latest' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls).toHaveLength(1);
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix']);
  });

  it('REQ-PNPM11-010: never injects `minimumReleaseAge: 0` even when a later step throws', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@11.0.0' }),
      'utf8',
    );

    const { runner } = makeRecordingRunner();
    const failingRunner = {
      ...runner,
      async run(args: string[]) {
        if (args[0] === 'install') {
          throw new Error('install failed');
        }
        return runner.run(args);
      },
    };

    await expect(
      refreshDeps({
        path: tmp,
        force: true,
        logger: silentLogger,
        pnpm: failingRunner,
        skipAudit: true,
        skipDedupe: true,
        summary: false,
      }),
    ).rejects.toThrow('install failed');

    const yamlAfter = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(yamlAfter).not.toContain('minimumReleaseAge: 0');
    expect(yamlAfter).toBe("catalog:\n  react: '18.2.0'\n");
  });

  it('REQ-PNPM11-011: does not add minimumReleaseAgeExclude entries on pnpm 11', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "minimumReleaseAge: 720\ncatalog:\n  lodash: '4.17.20'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@11.0.0' }),
      'utf8',
    );
    const auditJson = JSON.stringify({
      advisories: {
        '1': { module_name: 'lodash', patched_versions: '>=4.17.21' },
      },
    });
    const { runner } = makeRecordingRunner({ 'audit --json': auditJson });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    const yamlAfter = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    // The tool must never add the exclude block, even when advisories exist.
    expect(yamlAfter).not.toContain('minimumReleaseAgeExclude');
    // REQ-PNPM11-010: the user's global gate is preserved verbatim.
    expect(yamlAfter).toContain('minimumReleaseAge: 720');
    expect(yamlAfter).not.toMatch(/^minimumReleaseAge:\s*0\s*$/m);
  });

  it("REQ-PNPM11-011: preserves the user's existing minimumReleaseAgeExclude block verbatim", async () => {
    const original =
      "minimumReleaseAge: 720\nminimumReleaseAgeExclude:\n  - '@achmea/*'\ncatalog:\n  lodash: '4.17.20'\n";
    const wsPath = path.join(tmp, 'pnpm-workspace.yaml');
    fs.writeFileSync(wsPath, original, 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@11.0.0' }),
      'utf8',
    );
    const auditJson = JSON.stringify({
      advisories: {
        '1': { module_name: 'axios', patched_versions: '>=1.7.4' },
      },
    });
    const { runner } = makeRecordingRunner({ 'audit --json': auditJson }, { version: '11.0.0' });
    // Simulate pnpm 11 `audit --fix override` expanding the exclude list on
    // disk with freshly-patched advisory versions (block-sequence form).
    const expandingRunner = {
      ...runner,
      async runAllowFail(args: string[]) {
        if (args[0] === 'audit' && args.includes('--fix')) {
          fs.writeFileSync(
            wsPath,
            "minimumReleaseAge: 720\nminimumReleaseAgeExclude:\n  - '@achmea/*'\n  - 'axios@1.7.4'\n  - 'lodash@4.17.21'\ncatalog:\n  lodash: '4.17.20'\n",
            'utf8',
          );
        }
        return runner.runAllowFail(args);
      },
    };

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: expandingRunner,
      skipDedupe: true,
      summary: false,
    });

    const yamlAfter = fs.readFileSync(wsPath, 'utf8');
    // The user's single original entry is kept; pnpm's additions are discarded.
    expect(yamlAfter).toContain("  - '@achmea/*'");
    expect(yamlAfter).not.toContain('axios@1.7.4');
    expect(yamlAfter).not.toContain('lodash@4.17.21');
    // Exactly one exclude entry remains.
    const excludeLines = yamlAfter.split('\n').filter((l) => /^\s+-\s/.test(l));
    expect(excludeLines).toHaveLength(1);
  });

  it('REQ-CORE-008: runs pnpm audit --json before any cleanup or pnpm install', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const { runner, calls } = makeRecordingRunner({
      'audit --json': JSON.stringify({ advisories: {} }),
    });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    // The first captured call must be 'audit --json' — before any install.
    const firstCapture = calls.find((c) => c.capture === true);
    expect(firstCapture?.args).toEqual(['audit', '--json']);

    // Verify install comes after audit in the call list.
    const auditIdx = calls.findIndex(
      (c) => c.capture && c.args[0] === 'audit' && !c.args.includes('--fix'),
    );
    const installIdx = calls.findIndex((c) => c.args[0] === 'install');
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(auditIdx);
  });

  it('REQ-RUNNER-010: workspace packageManager pin takes precedence over pnpm --version on PATH for major detection', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    // package.json pins pnpm 10, but the runner mock reports pnpm 11 on PATH.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@10.33.0' }),
      'utf8',
    );
    const { runner, calls } = makeRecordingRunner({}, { version: '11.9.9' });

    await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
      summary: false,
    });

    // Because workspace pins pnpm 10, audit --fix must NOT include 'override'.
    const auditFixCalls = calls.filter((c) => c.args[0] === 'audit' && c.args.includes('--fix'));
    expect(auditFixCalls).toHaveLength(1);
    expect(auditFixCalls[0]!.args).toEqual(['audit', '--fix']);
  });

  it('REQ-INVARIANT-001: second run on an already-clean workspace produces empty change sets', async () => {
    const yaml = "catalog:\n  react: '18.3.1'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    // No advisories: catalog is already at the patched version.
    const { runner } = makeRecordingRunner({
      'audit --json': JSON.stringify({ advisories: {} }),
    });

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      pnpm: runner,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(false);
    expect(result.catalogChanges).toHaveLength(0);
    expect(result.overrideChanges).toHaveLength(0);
    expect(result.fixedAdvisories).toHaveLength(0);
  });

  it('REQ-INVARIANT-002: dry-run does not mutate workspace yaml, lockfile, or package.json', async () => {
    const yamlContent = "catalog:\n  react: '18.2.0'\n";
    const pkgContent = '{"name":"root"}';
    const lockContent = 'lockfileVersion: 9.0\n';
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yamlContent, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), pkgContent, 'utf8');
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), lockContent, 'utf8');

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: silentLogger,
      dryRun: true,
      skipAudit: true,
      skipDedupe: true,
    });

    expect(result.auditStatus).toBe('skipped');
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toBe(yamlContent);
    expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).toBe(pkgContent);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'utf8')).toBe(lockContent);
  });

  it('REQ-CORE-009: logs a warning and continues with empty advisory baseline when pre-cleanup audit throws', async () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "root" }', 'utf8');

    const warnings: string[] = [];
    const warningLogger = {
      ...silentLogger,
      warn(msg: string) {
        warnings.push(msg);
      },
    };

    // A runner whose capture() throws only on the FIRST audit call (pre-cleanup).
    const { runner } = makeRecordingRunner();
    let auditCallCount = 0;
    const throwingRunner = {
      ...runner,
      async capture(args: string[]) {
        if (args[0] === 'audit') {
          auditCallCount++;
          if (auditCallCount === 1) throw new Error('no lockfile');
        }
        return runner.capture(args);
      },
    };

    const result = await refreshDeps({
      path: tmp,
      force: true,
      logger: warningLogger,
      pnpm: throwingRunner,
      skipDedupe: true,
    });

    expect(result.canceled).toBe(false);
    expect(result.initialAdvisories).toHaveLength(0);
    expect(warnings.some((w) => w.includes('Pre-cleanup audit failed'))).toBe(true);
  });
});
