import { describe, expect, it } from 'vitest';
import {
  extractMinimumPatchedVersions,
  advisoryMatchesIgnoreList,
} from '../../src/audit/parseAdvisories';

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

describe('advisoryMatchesIgnoreList', () => {
  it('REQ-AUDIT-011: returns false when ignoredIds is empty', () => {
    expect(advisoryMatchesIgnoreList({}, new Set())).toBe(false);
  });

  it('REQ-AUDIT-011: returns false when advisory has no identifiers', () => {
    expect(advisoryMatchesIgnoreList({}, new Set(['GHSA-aaaa-bbbb-cccc']))).toBe(false);
  });

  it('REQ-AUDIT-011: matches by github_advisory_id', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match a different github_advisory_id', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-1111-2222-3333']),
      ),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: matches GHSA ID extracted from advisory url', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match when url GHSA differs from ignore list', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-1111-2222-3333']),
      ),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: matches by CVE in cves array', () => {
    expect(
      advisoryMatchesIgnoreList({ cves: ['CVE-2021-12345'] }, new Set(['CVE-2021-12345'])),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match when no CVE in ignore list', () => {
    expect(
      advisoryMatchesIgnoreList({ cves: ['CVE-2021-12345'] }, new Set(['CVE-2099-99999'])),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: case-insensitively matches GHSA from url', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/ghsa-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: case-insensitively matches github_advisory_id when ignore list uses lowercase', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['ghsa-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: case-insensitively matches github_advisory_id when advisory id is lowercase', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'ghsa-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: matches github_advisory_id when no url is present and only direct id check applies', () => {
    // Ensures the case-insensitive direct-id check works even when adv.url is absent,
    // covering the gap where a user writes lowercase IDs in ignoreGhsas config.
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-xxxx-yyyy-zzzz' },
        new Set(['ghsa-xxxx-yyyy-zzzz']),
      ),
    ).toBe(true);
  });
});

describe('extractMinimumPatchedVersions — malformed input', () => {
  it('REQ-AUDIT-008: handles non-string module_name (null) without error', () => {
    const json = JSON.stringify({
      advisories: { '1': { module_name: null, patched_versions: '>=1.0.0' } },
    });
    expect(extractMinimumPatchedVersions(json).size).toBe(0);
  });

  it('REQ-AUDIT-008: handles non-string module_name (number) without adding junk Map keys', () => {
    const json = JSON.stringify({
      advisories: { '1': { module_name: 42, patched_versions: '>=1.0.0' } },
    });
    const out = extractMinimumPatchedVersions(json);
    expect(out.size).toBe(0);
  });

  it('REQ-AUDIT-008: handles non-string module_name (object) without error', () => {
    const json = JSON.stringify({
      advisories: { '1': { module_name: { nested: true }, patched_versions: '>=1.0.0' } },
    });
    expect(extractMinimumPatchedVersions(json).size).toBe(0);
  });
});
