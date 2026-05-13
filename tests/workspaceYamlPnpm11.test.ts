import { describe, expect, it } from 'vitest';
import {
  addMinimumReleaseAgeExcludeEntries,
  getTopLevelScalar,
  hasTopLevelKey,
  mergeMinimumReleaseAgeExclude,
} from '../src/workspaceYamlPnpm11';

describe('getTopLevelScalar', () => {
  it('REQ-PNPM11-010: returns the scalar value when present', () => {
    expect(getTopLevelScalar('minimumReleaseAge: 1440\n', 'minimumReleaseAge')).toBe('1440');
    expect(getTopLevelScalar("minimumReleaseAge: '720'\n", 'minimumReleaseAge')).toBe("'720'");
  });

  it('REQ-PNPM11-010: returns null when the key is missing', () => {
    expect(getTopLevelScalar('packages:\n  - apps/*\n', 'minimumReleaseAge')).toBeNull();
  });

  it('REQ-PNPM11-010: returns null when the key starts a block (no inline value)', () => {
    expect(
      getTopLevelScalar('minimumReleaseAgeExclude:\n  foo: 1.0.0\n', 'minimumReleaseAgeExclude'),
    ).toBeNull();
  });
});

describe('hasTopLevelKey', () => {
  it('REQ-PNPM11-010: detects scalar, block, and missing keys', () => {
    expect(hasTopLevelKey('minimumReleaseAge: 0\n', 'minimumReleaseAge')).toBe(true);
    expect(hasTopLevelKey('minimumReleaseAge:\n  foo: 1\n', 'minimumReleaseAge')).toBe(true);
    expect(hasTopLevelKey('packages:\n  - apps/*\n', 'minimumReleaseAge')).toBe(false);
  });
});

describe('addMinimumReleaseAgeExcludeEntries', () => {
  it('REQ-PNPM11-009: appends a new block when none exists', () => {
    const yaml = 'packages:\n  - apps/*\n';
    const out = addMinimumReleaseAgeExcludeEntries(
      yaml,
      new Map([
        ['lodash', '4.17.21'],
        ['axios', '1.7.4'],
      ]),
    );
    expect(out).toBe(
      'packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  axios: 1.7.4\n  lodash: 4.17.21\n',
    );
  });

  it('REQ-PNPM11-009: merges new entries into an existing block, preserving prior entries', () => {
    const yaml =
      'minimumReleaseAgeExclude:\n  lodash: 4.17.20\n  axios: 1.6.0\npackages:\n  - apps/*\n';
    const out = addMinimumReleaseAgeExcludeEntries(
      yaml,
      new Map([
        ['lodash', '4.17.21'],
        ['vite', '5.4.0'],
      ]),
    );
    expect(out).toContain('  lodash: 4.17.21');
    expect(out).toContain('  axios: 1.6.0');
    expect(out).toContain('  vite: 5.4.0');
    expect(out).toContain('packages:');
    expect(out).not.toContain('  lodash: 4.17.20');
  });

  it('REQ-PNPM11-009: returns the yaml unchanged when the additions map is empty', () => {
    const yaml = 'packages:\n  - apps/*\n';
    expect(addMinimumReleaseAgeExcludeEntries(yaml, new Map())).toBe(yaml);
  });

  it('REQ-PNPM11-009, REQ-PORTABILITY-003: preserves CRLF line endings', () => {
    const yaml = 'packages:\r\n  - apps/*\r\n';
    const out = addMinimumReleaseAgeExcludeEntries(yaml, new Map([['lodash', '4.17.21']]));
    expect(out).toBe(
      'packages:\r\n  - apps/*\r\nminimumReleaseAgeExclude:\r\n  lodash: 4.17.21\r\n',
    );
  });

  it('REQ-PNPM11-010: does NOT add or modify the top-level minimumReleaseAge scalar', () => {
    const yaml = 'minimumReleaseAge: 1440\npackages:\n  - apps/*\n';
    const out = addMinimumReleaseAgeExcludeEntries(yaml, new Map([['lodash', '4.17.21']]));
    expect(out).toContain('minimumReleaseAge: 1440\n');
    expect(out).not.toContain('minimumReleaseAge: 0');
  });
});

describe('mergeMinimumReleaseAgeExclude', () => {
  it('REQ-PNPM11-004: appends a new block when target has none', () => {
    const target = 'packages:\n  - apps/*\n';
    const source = 'minimumReleaseAgeExclude:\n  lodash: 4.17.21\n';
    const out = mergeMinimumReleaseAgeExclude(target, source);
    expect(out).toBe('packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  lodash: 4.17.21\n');
  });

  it('REQ-PNPM11-004: merges entries entry-by-entry, with source overriding target', () => {
    const target =
      'minimumReleaseAgeExclude:\n  lodash: 4.17.20\n  axios: 1.6.0\npackages:\n  - apps/*\n';
    const source = 'minimumReleaseAgeExclude:\n  lodash: 4.17.21\n  vite: 5.4.0\n';
    const out = mergeMinimumReleaseAgeExclude(target, source);
    expect(out).toContain('  lodash: 4.17.21');
    expect(out).toContain('  axios: 1.6.0');
    expect(out).toContain('  vite: 5.4.0');
    expect(out).toContain('packages:');
  });

  it('REQ-PNPM11-004: returns the target unchanged when source has no exclude block', () => {
    const target = 'packages:\n  - apps/*\n';
    expect(mergeMinimumReleaseAgeExclude(target, 'overrides:\n  foo: 1\n')).toBe(target);
  });
});
