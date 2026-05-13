import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceState } from '../../src/workspace';
import { silentLogger } from '../../src/logger';
import { makeRecordingRunner } from '../helpers/recordingRunner';
import {
  extractVersionPrefix,
  getDirectDepPackageJsonBumps,
  applyPackageJsonDepBumps,
  type PackageJsonDepBump,
} from '../../src/audit/bumpPackageJsonDeps';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-bump-pkgjson-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractVersionPrefix
// ---------------------------------------------------------------------------

describe('extractVersionPrefix', () => {
  it('REQ-AUDIT-005: returns empty prefix for bare semver', () => {
    expect(extractVersionPrefix('1.2.3')).toEqual({ prefix: '', bare: '1.2.3' });
  });

  it('REQ-AUDIT-005: returns ^ prefix', () => {
    expect(extractVersionPrefix('^2.0.0')).toEqual({ prefix: '^', bare: '2.0.0' });
  });

  it('REQ-AUDIT-005: returns ~ prefix', () => {
    expect(extractVersionPrefix('~3.4.5')).toEqual({ prefix: '~', bare: '3.4.5' });
  });

  it('REQ-AUDIT-006: returns null for catalog: specifier', () => {
    expect(extractVersionPrefix('catalog:default')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for workspace: specifier', () => {
    expect(extractVersionPrefix('workspace:*')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for complex range with >=', () => {
    expect(extractVersionPrefix('>=1.0.0 <2.0.0')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for range with *', () => {
    expect(extractVersionPrefix('*')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for x-range', () => {
    expect(extractVersionPrefix('1.x')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for || union', () => {
    expect(extractVersionPrefix('1.0.0 || 2.0.0')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for http URL', () => {
    expect(extractVersionPrefix('https://example.com/pkg.tgz')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for file: specifier', () => {
    expect(extractVersionPrefix('file:../local-pkg')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for empty string', () => {
    expect(extractVersionPrefix('')).toBeNull();
  });

  it('REQ-AUDIT-006: returns null for undefined', () => {
    expect(extractVersionPrefix(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MINIMAL_WORKSPACE_YAML = "packages:\n  - 'packages/*'\n\ncatalog:\n  react: '18.2.0'\n";

function writeWorkspace(yaml: string, rootPkg?: string): WorkspaceState {
  fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
  if (rootPkg) fs.writeFileSync(path.join(tmp, 'package.json'), rootPkg, 'utf8');
  return WorkspaceState.initialize(tmp);
}

function makeAuditJson(
  module: string,
  vulnerableVersions: string,
  patchedVersions: string,
  severity = 'high',
): string {
  return JSON.stringify({
    advisories: {
      '1': {
        module_name: module,
        vulnerable_versions: vulnerableVersions,
        patched_versions: patchedVersions,
        severity,
      },
    },
  });
}

function makeVersionsJson(versions: string[]): string {
  return JSON.stringify(versions);
}

// ---------------------------------------------------------------------------
// getDirectDepPackageJsonBumps
// ---------------------------------------------------------------------------

describe('getDirectDepPackageJsonBumps', () => {
  it('REQ-AUDIT-005: returns empty array when no advisories', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': JSON.stringify({ advisories: {} }),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-008: returns empty array when audit stdout is empty', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({ 'audit --json': '' });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-006: skips deps that use catalog: syntax (resolved by catalog bump instead)', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      // react uses catalog: syntax; lodash uses explicit version
      JSON.stringify(
        { name: 'root', dependencies: { react: 'catalog:', lodash: '4.17.20' } },
        null,
        2,
      ),
    );
    // Advisory for react — should be skipped because version field is catalog: syntax.
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('react', '<=18.2.0', '>=18.3.0'),
      'view react versions --json': makeVersionsJson(['18.2.0', '18.3.0', '18.3.1']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-005: bumps explicit version even when the same package is also in the catalog', async () => {
    // Root uses an explicit version for react (not catalog: syntax), even though
    // react is catalog-managed. The explicit entry must be bumped directly.
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { react: '18.2.0' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('react', '<=18.2.0', '>=18.3.0'),
      'view react versions --json': makeVersionsJson(['18.2.0', '18.3.0', '18.3.1']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatchObject({ name: 'react', before: '18.2.0', after: '18.3.0' });
  });

  it('REQ-AUDIT-005: bumps bare version and preserves no prefix', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatchObject({
      name: 'lodash',
      before: '4.17.20',
      after: '4.17.21',
      tier: 'patch',
    });
  });

  it('REQ-AUDIT-005: bumps ^-prefixed version and preserves ^ prefix', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatchObject({ before: '^4.17.20', after: '^4.17.21', tier: 'patch' });
  });

  it('REQ-AUDIT-005: bumps ~-prefixed version and preserves ~ prefix', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', devDependencies: { axios: '~1.6.0' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('axios', '<=1.6.7', '>=1.7.0'),
      'view axios versions --json': makeVersionsJson(['1.6.0', '1.7.0', '1.7.1']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatchObject({ before: '~1.6.0', after: '~1.7.0' });
  });

  it('REQ-AUDIT-006: skips catalog: version field', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: 'catalog:' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-006: skips workspace: version field', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { 'my-pkg': 'workspace:*' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('my-pkg', '<=1.0.0', '>=1.0.1'),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-006: skips complex range version field', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { axios: '>=1.0.0 <2.0.0' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('axios', '<=1.6.7', '>=1.7.0'),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-007: skips version already outside the vulnerable range', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.21' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-002: skips major bump when allowMajor=false and logs warning', async () => {
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (m: string) => {
        warnings.push(m);
      },
    };

    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { express: '4.21.2' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('express', '<=4.21.2', '>=5.0.0'),
      'view express versions --json': makeVersionsJson(['4.21.2', '5.0.0', '5.1.0']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, logger, {
      allowMajor: false,
    });
    expect(bumps).toHaveLength(0);
    expect(warnings.some((w) => w.includes('MAJOR'))).toBe(true);
  });

  it('REQ-AUDIT-003: emits MAJOR bump when allowMajor=true (default)', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { express: '4.21.2' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('express', '<=4.21.2', '>=5.0.0'),
      'view express versions --json': makeVersionsJson(['4.21.2', '5.0.0']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatchObject({ name: 'express', after: '5.0.0', tier: 'major' });
  });

  it('REQ-AUDIT-008: uses pre-fetched auditJsonStdout to avoid second audit call', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner, calls } = makeRecordingRunner({
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    await getDirectDepPackageJsonBumps(state, runner, silentLogger, {
      auditJsonStdout: makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
    });
    expect(calls.every((c) => c.args[0] !== 'audit')).toBe(true);
  });

  it('REQ-AUDIT-005: scans devDependencies and optionalDependencies', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify(
        {
          name: 'root',
          devDependencies: { jest: '29.0.0' },
          optionalDependencies: { fsevents: '2.3.2' },
        },
        null,
        2,
      ),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': JSON.stringify({
        advisories: {
          '1': {
            module_name: 'jest',
            vulnerable_versions: '<=29.0.0',
            patched_versions: '>=29.0.1',
          },
          '2': {
            module_name: 'fsevents',
            vulnerable_versions: '<=2.3.2',
            patched_versions: '>=2.3.3',
          },
        },
      }),
      'view jest versions --json': makeVersionsJson(['29.0.0', '29.0.1']),
      'view fsevents versions --json': makeVersionsJson(['2.3.2', '2.3.3']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    const names = bumps.map((b) => b.name).sort();
    expect(names).toEqual(['fsevents', 'jest']);
  });

  it('REQ-WORKSPACE-009: only bumps the vulnerable package across multiple workspace packages', async () => {
    // Set up a child package.
    const pkgDir = path.join(tmp, 'packages', 'app');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.21' } }, null, 2),
      'utf8',
    );

    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );

    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });

    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    // Only root package.json has the vulnerable version; child has 4.17.21 (safe).
    expect(bumps).toHaveLength(1);
    expect(bumps[0]!.pkgJsonPath).toBe(path.join(tmp, 'package.json'));
  });

  it('REQ-WORKSPACE-009, REQ-AUDIT-005: bumps both root and child workspace packages when both have a vulnerable dep', async () => {
    const pkgDir = path.join(tmp, 'packages', 'app');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.20' } }, null, 2),
      'utf8',
    );

    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
    );

    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });

    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(2);
    const bumpPaths = bumps.map((b) => b.pkgJsonPath).sort();
    expect(bumpPaths).toContain(path.join(tmp, 'package.json'));
    expect(bumpPaths).toContain(path.join(pkgDir, 'package.json'));
    for (const b of bumps) {
      expect(b.before).toBe('^4.17.20');
      expect(b.after).toBe('^4.17.21');
    }
  });

  it('REQ-AUDIT-007: skips ranged dep (^) when advisory severity is moderate', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'moderate'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-007: skips ranged dep (~) when advisory severity is low', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '~4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'low'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-005: bumps ranged dep (^) when advisory severity is critical', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'critical'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.after).toBe('^4.17.21');
  });

  it('REQ-AUDIT-005: bumps exact-pinned dep for moderate severity (no prefix = not filtered)', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'moderate'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.after).toBe('4.17.21');
  });

  it('REQ-AUDIT-001: deduplicates when multiple advisories affect the same dep, keeping highest safe version', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': JSON.stringify({
        advisories: {
          '1': {
            module_name: 'lodash',
            vulnerable_versions: '<=4.17.20',
            patched_versions: '>=4.17.21',
          },
          '2': {
            module_name: 'lodash',
            vulnerable_versions: '<=4.17.21',
            patched_versions: '>=4.17.22',
          },
        },
      }),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21', '4.17.22']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.after).toBe('4.17.22');
  });
});

// ---------------------------------------------------------------------------
// applyPackageJsonDepBumps
// ---------------------------------------------------------------------------

describe('applyPackageJsonDepBumps', () => {
  it('REQ-AUDIT-005: writes bumped version to package.json', () => {
    const pkgJsonPath = path.join(tmp, 'package.json');
    const original = JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2);
    fs.writeFileSync(pkgJsonPath, original, 'utf8');

    const bump: PackageJsonDepBump = {
      pkgJsonPath,
      depType: 'dependencies',
      name: 'lodash',
      before: '4.17.20',
      after: '4.17.21',
      tier: 'patch',
    };
    applyPackageJsonDepBumps([bump], false);

    const result = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(result.dependencies['lodash']).toBe('4.17.21');
  });

  it('REQ-AUDIT-005: preserves ^ prefix in written value', () => {
    const pkgJsonPath = path.join(tmp, 'package.json');
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
      'utf8',
    );

    const bump: PackageJsonDepBump = {
      pkgJsonPath,
      depType: 'dependencies',
      name: 'lodash',
      before: '^4.17.20',
      after: '^4.17.21',
      tier: 'patch',
    };
    applyPackageJsonDepBumps([bump], false);

    const result = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(result.dependencies['lodash']).toBe('^4.17.21');
  });

  it('REQ-CORE-002: does not write when dryRun=true', () => {
    const pkgJsonPath = path.join(tmp, 'package.json');
    const original = JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2);
    fs.writeFileSync(pkgJsonPath, original, 'utf8');

    const bump: PackageJsonDepBump = {
      pkgJsonPath,
      depType: 'dependencies',
      name: 'lodash',
      before: '4.17.20',
      after: '4.17.21',
      tier: 'patch',
    };
    applyPackageJsonDepBumps([bump], true);

    expect(fs.readFileSync(pkgJsonPath, 'utf8')).toBe(original);
  });

  it('REQ-AUDIT-005: applies multiple bumps to the same file in one pass', () => {
    const pkgJsonPath = path.join(tmp, 'package.json');
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        { name: 'root', dependencies: { lodash: '4.17.20', axios: '~1.6.0' } },
        null,
        2,
      ),
      'utf8',
    );

    const bumps: PackageJsonDepBump[] = [
      {
        pkgJsonPath,
        depType: 'dependencies',
        name: 'lodash',
        before: '4.17.20',
        after: '4.17.21',
        tier: 'patch',
      },
      {
        pkgJsonPath,
        depType: 'dependencies',
        name: 'axios',
        before: '~1.6.0',
        after: '~1.7.0',
        tier: 'minor',
      },
    ];
    applyPackageJsonDepBumps(bumps, false);

    const result = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(result.dependencies['lodash']).toBe('4.17.21');
    expect(result.dependencies['axios']).toBe('~1.7.0');
  });

  it('REQ-AUDIT-005: applies bumps across different files', () => {
    const pkgA = path.join(tmp, 'a.json');
    const pkgB = path.join(tmp, 'b.json');
    fs.writeFileSync(
      pkgA,
      JSON.stringify({ dependencies: { lodash: '4.17.20' } }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      pkgB,
      JSON.stringify({ devDependencies: { axios: '1.6.0' } }, null, 2),
      'utf8',
    );

    const bumps: PackageJsonDepBump[] = [
      {
        pkgJsonPath: pkgA,
        depType: 'dependencies',
        name: 'lodash',
        before: '4.17.20',
        after: '4.17.21',
        tier: 'patch',
      },
      {
        pkgJsonPath: pkgB,
        depType: 'devDependencies',
        name: 'axios',
        before: '1.6.0',
        after: '1.7.0',
        tier: 'minor',
      },
    ];
    applyPackageJsonDepBumps(bumps, false);

    expect(
      (JSON.parse(fs.readFileSync(pkgA, 'utf8')) as { dependencies: Record<string, string> })
        .dependencies['lodash'],
    ).toBe('4.17.21');
    expect(
      (JSON.parse(fs.readFileSync(pkgB, 'utf8')) as { devDependencies: Record<string, string> })
        .devDependencies['axios'],
    ).toBe('1.7.0');
  });
});

// ---------------------------------------------------------------------------
// Single-package mode: scan must be confined to root package.json
// ---------------------------------------------------------------------------

describe('getDirectDepPackageJsonBumps — single-package mode', () => {
  it('REQ-WORKSPACE-009: only inspects the root package.json when no workspace is configured', async () => {
    // Root package.json — pnpm-managed, no pnpm-workspace.yaml, no workspaces field.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify(
        {
          name: 'app',
          packageManager: 'pnpm@10.8.0',
          dependencies: { lodash: '4.17.20' },
        },
        null,
        2,
      ),
      'utf8',
    );
    // Nested unrelated package that owns the same vulnerable dep — must be ignored.
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(
      path.join(tmp, 'sub', 'package.json'),
      JSON.stringify({ name: 'sub', dependencies: { lodash: '4.17.20' } }, null, 2),
      'utf8',
    );

    const state = WorkspaceState.initialize(tmp);
    expect(state.isMultiPackageWorkspace).toBe(false);

    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });

    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.pkgJsonPath).toBe(path.join(tmp, 'package.json'));
  });

  it('REQ-AUDIT-009: ranged dep (^) is NOT bumped when advisory severity is below high/critical', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '^4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'moderate'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(0);
  });

  it('REQ-AUDIT-009: exact-pinned dep IS bumped for moderate severity (no prefix skips severity filter)', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21', 'moderate'),
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.after).toBe('4.17.21');
  });

  it('REQ-AUDIT-010: prerelease versions in the available list are excluded from bump candidates', async () => {
    const state = writeWorkspace(
      MINIMAL_WORKSPACE_YAML,
      JSON.stringify({ name: 'root', dependencies: { lodash: '4.17.20' } }, null, 2),
    );
    const { runner } = makeRecordingRunner({
      'audit --json': makeAuditJson('lodash', '<=4.17.20', '>=4.17.21'),
      // Only a prerelease satisfies the range — the stable 4.17.21 is not present.
      // selectSafeBump should fall back to the range minimum (4.17.21) instead of picking a prerelease.
      'view lodash versions --json': makeVersionsJson(['4.17.20', '4.17.21-beta.1', '4.17.21']),
    });
    const bumps = await getDirectDepPackageJsonBumps(state, runner, silentLogger);
    // The stable 4.17.21 is present and should be chosen, not the beta.
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.after).toBe('4.17.21');
  });
});
