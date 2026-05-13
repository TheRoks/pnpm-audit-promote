import { describe, expect, it } from 'vitest';
import { extractMinimumPatchedVersions } from '../../src/audit/parseAdvisories';

function makeAuditJson(advisories: Array<{ id: string; module: string; patched: string }>): string {
  const map: Record<string, { module_name: string; patched_versions: string }> = {};
  for (const a of advisories) {
    map[a.id] = { module_name: a.module, patched_versions: a.patched };
  }
  return JSON.stringify({ advisories: map });
}

describe('extractMinimumPatchedVersions', () => {
  it('REQ-PNPM11-009: returns the minimum patched version for a single advisory', () => {
    const out = extractMinimumPatchedVersions(
      makeAuditJson([{ id: '1', module: 'lodash', patched: '>=4.17.21' }]),
    );
    expect(out.get('lodash')).toBe('4.17.21');
  });

  it('REQ-PNPM11-009: when one package has multiple advisories, the highest minimum wins', () => {
    const out = extractMinimumPatchedVersions(
      makeAuditJson([
        { id: '1', module: 'axios', patched: '>=1.6.0' },
        { id: '2', module: 'axios', patched: '>=1.7.4' },
        { id: '3', module: 'axios', patched: '>=1.6.7' },
      ]),
    );
    // The install must satisfy every advisory, so we need the highest of
    // the per-advisory minima.
    expect(out.get('axios')).toBe('1.7.4');
  });

  it('REQ-PNPM11-009: skips advisories with an empty patched_versions range', () => {
    const out = extractMinimumPatchedVersions(
      makeAuditJson([
        { id: '1', module: 'foo', patched: '' },
        { id: '2', module: 'bar', patched: '>=2.0.0' },
      ]),
    );
    expect(out.has('foo')).toBe(false);
    expect(out.get('bar')).toBe('2.0.0');
  });

  it('REQ-PNPM11-009: returns an empty map for empty input', () => {
    expect(extractMinimumPatchedVersions('').size).toBe(0);
    expect(extractMinimumPatchedVersions('   ').size).toBe(0);
  });

  it('REQ-PNPM11-009: returns an empty map for malformed JSON', () => {
    expect(extractMinimumPatchedVersions('not json').size).toBe(0);
  });

  it('REQ-PNPM11-009: tolerates compound semver ranges', () => {
    const out = extractMinimumPatchedVersions(
      makeAuditJson([{ id: '1', module: 'vite', patched: '>=5.4.6 <6.0.0 || >=6.0.1' }]),
    );
    expect(out.get('vite')).toBe('5.4.6');
  });
});
