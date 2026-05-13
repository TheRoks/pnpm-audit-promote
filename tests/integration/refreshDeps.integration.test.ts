import { afterEach, describe, expect, it } from 'vitest';
import * as YAML from 'yaml';
import { refreshDeps } from '../../src/refresh';
import { silentLogger } from '../../src/logger';
import {
  detectPnpmMajor,
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
  const wantMajor = expectedPnpmMajor();
  if (wantMajor != null && localMajor != null && wantMajor !== localMajor) {
    console.warn(
      `[integration] Skipping: INTEGRATION_PNPM_MAJOR=${wantMajor} but pnpm --version reports ${localMajor}.`,
    );
  }

  let ws: RealWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  describe.skipIf(localMajor !== 10)('pnpm 10', () => {
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
  });

  describe.skipIf(localMajor !== 11)('pnpm 11', () => {
    it('REQ-INT-PNPM11-001, REQ-PNPM11-010: bumps catalog and preserves user minimumReleaseAge verbatim', async () => {
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
  });
});

/**
 * Tiny semver comparator that tolerates an optional caret/tilde prefix and
 * extra patch segments. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .replace(/^[\^~]/, '')
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0);
  const [a1, a2, a3] = norm(a);
  const [b1, b2, b3] = norm(b);
  return a1! - b1! || a2! - b2! || a3! - b3!;
}
