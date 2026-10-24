import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import semver from 'semver';
import * as YAML from 'yaml';
import { refreshDeps } from '../../src/refresh';
import { silentLogger } from '../../src/logger';
import {
  detectPnpmMajor,
  detectPnpmVersion,
  expectedPnpmMajor,
  setupRealWorkspace,
  shouldRunIntegration,
  type RealWorkspace,
} from './setupRealWorkspace';

/**
 * End-to-end suite that drives `refreshDeps` against a real pnpm binary.
 *
 * Selection rules:
 *  - The whole suite is skipped unless `RUN_INTEGRATION=1` is set.
 *  - Per-major describe blocks are skipped when the local `pnpm --version`
 *    does not match the expected major (CI sets `INTEGRATION_PNPM_MAJOR`
 *    per matrix entry).
 *
 * Tests assert on the post-run state of the workspace yaml + package.json,
 * not on log output, so they are stable across pnpm patch upgrades.
 */
describe.skipIf(!shouldRunIntegration())('integration: refreshDeps against real pnpm', () => {
  const localMajor = detectPnpmMajor();
  const localVersion = detectPnpmVersion();
  const wantMajor = expectedPnpmMajor();
  const hasMajorMismatch = wantMajor != null && localMajor != null && wantMajor !== localMajor;
  if (wantMajor != null && localMajor !== wantMajor) {
    throw new Error(
      `[integration] Expected pnpm ${wantMajor}, but pnpm --version reports ${localMajor ?? 'unavailable'}.`,
    );
  }

  let ws: RealWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  describe.skipIf(hasMajorMismatch || localMajor !== 10)('pnpm 10', () => {
    it('REQ-INT-PNPM10-001: bumps a vulnerable direct catalog dep and leaves no override', async () => {
      ws = setupRealWorkspace('v10-direct-vuln');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
      });

      expect(result.canceled).toBe(false);

      const yamlText = ws.readWorkspaceYaml();
      const parsed = YAML.parse(yamlText) as {
        catalog?: Record<string, string>;
        overrides?: Record<string, string>;
      };

      // The catalog version must have been raised at or above the fix
      // (4.17.21). Allow newer patches to satisfy "at least 4.17.21".
      expect(parsed.catalog?.['lodash']).toBeDefined();
      expect(compareSemver(parsed.catalog!['lodash']!, '4.17.21')).toBeGreaterThanOrEqual(0);

      // Direct-dep promotion should leave no `overrides` block for lodash.
      const lodashOverride = parsed.overrides?.['lodash'];
      expect(lodashOverride ?? null).toBeNull();
    });

    it('REQ-INT-PNPM10-002: non-catalog vulnerable dep has member package.json floor raised, not promoted to catalog', async () => {
      ws = setupRealWorkspace('v10-non-catalog-vuln');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
      });

      expect(result.canceled).toBe(false);

      const yamlText = ws.readWorkspaceYaml();
      const parsed = YAML.parse(yamlText) as {
        catalog?: Record<string, string>;
        overrides?: Record<string, string>;
      };

      // lodash is NOT in the catalog, so it should NOT appear there after the run.
      expect(parsed.catalog?.['lodash']).toBeUndefined();

      // The member package.json floor should be raised to >= 4.17.21 directly.
      // (Exact-pinned deps are fixed at the package.json level by raising the
      // declared floor rather than adding a transient workspace override.)
      const appPkgText = fs.readFileSync(path.join(ws.root, 'apps', 'app', 'package.json'), 'utf8');
      const appPkg = JSON.parse(appPkgText) as { dependencies?: Record<string, string> };
      const lodashVersion = appPkg.dependencies?.['lodash'];
      expect(lodashVersion).toBeDefined();
      expect(compareSemver(String(lodashVersion), '4.17.21')).toBeGreaterThanOrEqual(0);
    });
  });

  describe.skipIf(hasMajorMismatch || localMajor !== 11)('pnpm 11', () => {
    it('REQ-INT-PNPM11-001, REQ-PNPM11-010, REQ-INT-PNPM11-004: bumps catalog and preserves user minimumReleaseAge verbatim', async () => {
      ws = setupRealWorkspace('v11-direct-vuln');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
      });

      expect(result.canceled).toBe(false);

      const yamlText = ws.readWorkspaceYaml();
      const parsed = YAML.parse(yamlText) as {
        catalog?: Record<string, string>;
        overrides?: Record<string, string>;
        minimumReleaseAge?: number;
      };

      expect(parsed.catalog?.['lodash']).toBeDefined();
      expect(compareSemver(parsed.catalog!['lodash']!, '4.17.21')).toBeGreaterThanOrEqual(0);

      // The user's original minimumReleaseAge must be preserved exactly.
      expect(parsed.minimumReleaseAge).toBe(720);
      expect(yamlText).not.toMatch(/^minimumReleaseAge:\s*0\s*$/m);
    });

    it('REQ-INT-PNPM11-003: --ignore-workspace migrates audit overrides to package.json pnpm.overrides', async () => {
      ws = setupRealWorkspace('v11-ignore-workspace');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
        ignoreWorkspace: true,
      });

      expect(result.canceled).toBe(false);

      const pkgText = fs.readFileSync(path.join(ws.root, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgText) as { pnpm?: { overrides?: Record<string, string> } };

      // pnpm.overrides must exist and contain a lodash entry above the vulnerable range.
      expect(pkg.pnpm?.overrides).toBeDefined();
      const overrides = pkg.pnpm!.overrides!;
      const lodashEntry = Object.entries(overrides).find(
        ([k]) => k === 'lodash' || k.startsWith('lodash@'),
      );
      expect(lodashEntry).toBeDefined();
      expect(compareSemver(String(lodashEntry![1]), '4.17.21')).toBeGreaterThanOrEqual(0);
    });
  });

  describe.skipIf(hasMajorMismatch || localMajor !== 12)('pnpm 12', () => {
    it('REQ-INT-PNPM12-001, REQ-PNPM12-010: promotes a catalog fix and preserves release-age settings', async () => {
      ws = setupRealWorkspace('v12-direct-vuln');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
      });

      expect(result.canceled).toBe(false);
      const yamlText = ws.readWorkspaceYaml();
      const parsed = YAML.parse(yamlText) as {
        autoDedupe?: boolean;
        audit?: { ignore?: string[]; ignorePrune?: boolean; level?: string };
        catalog?: Record<string, string>;
        minimumReleaseAge?: number;
        minimumReleaseAgeExclude?: string[];
        overrides?: Record<string, string>;
      };
      expect(parsed.catalog?.['lodash']).toBeDefined();
      expect(compareSemver(parsed.catalog!['lodash']!, '4.17.21')).toBeGreaterThanOrEqual(0);
      expect(parsed.minimumReleaseAge).toBe(720);
      expect(parsed.minimumReleaseAgeExclude).toEqual(['@scope/*']);
      expect(parsed.autoDedupe).toBe(true);
      expect(parsed.audit?.level).toBe('high');
      expect(parsed.audit?.ignorePrune).toBe(true);
      expect(parsed.audit?.ignore ?? []).toEqual([]);
      expect(parsed.overrides?.['lodash'] ?? null).toBeNull();
    });

    it('REQ-INT-PNPM12-002, REQ-WORKSPACE-010: adopts workspace yaml generated from package.json workspaces', async () => {
      ws = setupRealWorkspace('v12-workspaces-autocreate');

      const result = await refreshDeps({
        path: ws.root,
        force: true,
        logger: silentLogger,
        summary: false,
        skipDedupe: true,
      });

      expect(result.canceled).toBe(false);
      const generated = YAML.parse(ws.readWorkspaceYaml()) as { packages?: string[] };
      expect(generated.packages).toContain('apps/*');
    });

    describe.skipIf(!localVersion || !semver.gte(localVersion, '12.15.0'))(
      'pnpm 12.15 delegated settings',
      () => {
        it('REQ-INT-PNPM12-003: writes a delegated catalog to its owner and preserves include mappings', async () => {
          ws = setupRealWorkspace('v12-delegated-config');

          const result = await refreshDeps({
            path: ws.root,
            force: true,
            logger: silentLogger,
            summary: false,
          });

          expect(result.canceled).toBe(false);
          const rootYaml = ws.readWorkspaceYaml();
          const catalogYaml = fs.readFileSync(path.join(ws.root, 'config', 'catalog.yaml'), 'utf8');
          const policyYaml = fs.readFileSync(path.join(ws.root, 'config', 'policy.yaml'), 'utf8');
          const catalog = YAML.parse(catalogYaml) as { catalog?: Record<string, string> };
          const policy = YAML.parse(policyYaml) as {
            audit?: { level?: string };
            minimumReleaseAge?: number;
            minimumReleaseAgeExclude?: string[];
          };

          expect(rootYaml).toContain('./config/catalog.yaml: [catalog]');
          expect(rootYaml).toContain(
            './config/policy.yaml: [audit, minimumReleaseAge, minimumReleaseAgeExclude, overrides]',
          );
          expect(catalog.catalog?.['lodash']).toBeDefined();
          expect(compareSemver(catalog.catalog!['lodash']!, '4.17.21')).toBeGreaterThanOrEqual(0);
          expect(policy.audit?.level).toBe('high');
          expect(policy.minimumReleaseAge).toBe(720);
          expect(policy.minimumReleaseAgeExclude).toEqual(['@scope/*']);
        });

        it('REQ-INT-PNPM12-004: stops before cleanup when an audit setting is owned by a config dependency', async () => {
          ws = setupRealWorkspace('v12-workspaces-autocreate');
          const rootPackagePath = path.join(ws.root, 'package.json');
          const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8')) as {
            packageManager?: string;
          };
          rootPackage.packageManager = 'pnpm@12.15.0';
          fs.writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
          fs.writeFileSync(
            path.join(ws.root, 'pnpm-workspace.yaml'),
            [
              'configDependencies:',
              "  '@test/policy': 1.0.0",
              'include:',
              "  '@test/policy': [overrides]",
              '',
            ].join('\n'),
          );
          const dependencyPath = path.join(ws.root, 'node_modules', '@test', 'policy');
          fs.mkdirSync(dependencyPath, { recursive: true });
          fs.writeFileSync(
            path.join(dependencyPath, 'package.json'),
            JSON.stringify({
              name: '@test/policy',
              version: '1.0.0',
              pnpm: { config: './config.yaml' },
            }),
          );
          fs.writeFileSync(
            path.join(dependencyPath, 'config.yaml'),
            'overrides:\n  lodash: 4.17.21\n',
          );
          const sentinelPath = path.join(ws.root, 'node_modules', 'keep-me.txt');
          fs.writeFileSync(sentinelPath, 'preserve');

          await expect(
            refreshDeps({
              path: ws.root,
              force: true,
              logger: silentLogger,
              summary: false,
            }),
          ).rejects.toThrow(/owned by config dependency '@test\/policy'/);

          expect(fs.readFileSync(sentinelPath, 'utf8')).toBe('preserve');
        });

        it('REQ-INT-PNPM12-006: bumps package.json5 and package.yaml dependencies in place', async () => {
          ws = setupRealWorkspace('v12-manifest-formats');

          const result = await refreshDeps({
            path: ws.root,
            force: true,
            logger: silentLogger,
            summary: false,
          });

          expect(result.canceled).toBe(false);
          const json5Path = path.join(ws.root, 'apps', 'json5-app', 'package.json5');
          const yamlPath = path.join(ws.root, 'apps', 'yaml-app', 'package.yaml');
          const json5Text = fs.readFileSync(json5Path, 'utf8');
          const yamlText = fs.readFileSync(yamlPath, 'utf8');
          const json5Manifest = JSON5.parse(json5Text) as {
            name?: string;
            private?: boolean;
            dependencies?: Record<string, string>;
          };
          const yamlManifest = YAML.parse(yamlText) as {
            name?: string;
            private?: boolean;
            dependencies?: Record<string, string>;
          };

          expect(json5Manifest.dependencies?.['lodash']).toBeDefined();
          expect(
            compareSemver(json5Manifest.dependencies!['lodash']!, '4.17.21'),
          ).toBeGreaterThanOrEqual(0);
          expect(json5Manifest.name).toBe('json5-app');
          expect(json5Manifest.private).toBe(true);
          expect(json5Text).toContain("name: 'json5-app'");
          expect(yamlManifest.dependencies?.['lodash']).toBeDefined();
          expect(
            compareSemver(yamlManifest.dependencies!['lodash']!, '4.17.21'),
          ).toBeGreaterThanOrEqual(0);
          expect(yamlManifest.name).toBe('yaml-app');
          expect(yamlManifest.private).toBe(true);
        });
      },
    );
  });
});

/**
 * Tiny semver comparator that tolerates an optional caret/tilde prefix and
 * extra patch segments. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .replace(/^[^\d]*/u, '')
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0);
  const [a1, a2, a3] = norm(a);
  const [b1, b2, b3] = norm(b);
  return a1! - b1! || a2! - b2! || a3! - b3!;
}
