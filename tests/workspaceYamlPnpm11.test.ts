import { describe, expect, it } from 'vitest';
import {
  forceMinimumReleaseAgeZero,
  getTopLevelScalar,
  hasTopLevelKey,
  mergeMinimumReleaseAgeExclude,
  restoreMinimumReleaseAge,
} from '../src/workspaceYamlPnpm11';

describe('getTopLevelScalar', () => {
  it('returns the scalar value when present', () => {
    expect(getTopLevelScalar('minimumReleaseAge: 1440\n', 'minimumReleaseAge')).toBe('1440');
    expect(getTopLevelScalar("minimumReleaseAge: '720'\n", 'minimumReleaseAge')).toBe("'720'");
  });

  it('returns null when the key is missing', () => {
    expect(getTopLevelScalar('packages:\n  - apps/*\n', 'minimumReleaseAge')).toBeNull();
  });

  it('returns null when the key starts a block (no inline value)', () => {
    expect(
      getTopLevelScalar('minimumReleaseAgeExclude:\n  foo: 1.0.0\n', 'minimumReleaseAgeExclude'),
    ).toBeNull();
  });
});

describe('hasTopLevelKey', () => {
  it('detects scalar, block, and missing keys', () => {
    expect(hasTopLevelKey('minimumReleaseAge: 0\n', 'minimumReleaseAge')).toBe(true);
    expect(hasTopLevelKey('minimumReleaseAge:\n  foo: 1\n', 'minimumReleaseAge')).toBe(true);
    expect(hasTopLevelKey('packages:\n  - apps/*\n', 'minimumReleaseAge')).toBe(false);
  });
});

describe('forceMinimumReleaseAgeZero', () => {
  it('appends the key when it is missing', () => {
    const out = forceMinimumReleaseAgeZero('packages:\n  - apps/*\n');
    expect(out).toBe('packages:\n  - apps/*\nminimumReleaseAge: 0\n');
  });

  it('replaces an existing scalar value', () => {
    const out = forceMinimumReleaseAgeZero('minimumReleaseAge: 1440\npackages:\n  - apps/*\n');
    expect(out).toBe('minimumReleaseAge: 0\npackages:\n  - apps/*\n');
  });

  it('preserves CRLF line endings', () => {
    const out = forceMinimumReleaseAgeZero('packages:\r\n  - apps/*\r\n');
    expect(out).toBe('packages:\r\n  - apps/*\r\nminimumReleaseAge: 0\r\n');
  });

  it('adds a trailing newline when the file lacks one', () => {
    const out = forceMinimumReleaseAgeZero('packages:\n  - apps/*');
    expect(out).toBe('packages:\n  - apps/*\nminimumReleaseAge: 0\n');
  });

  it('handles an empty input', () => {
    expect(forceMinimumReleaseAgeZero('')).toBe('minimumReleaseAge: 0\n');
  });
});

describe('restoreMinimumReleaseAge', () => {
  it('removes the injected line when the original value was null', () => {
    const patched = 'minimumReleaseAge: 0\npackages:\n  - apps/*\n';
    expect(restoreMinimumReleaseAge(patched, null)).toBe('packages:\n  - apps/*\n');
  });

  it('writes the original value back when one was captured', () => {
    const patched = 'minimumReleaseAge: 0\npackages:\n  - apps/*\n';
    expect(restoreMinimumReleaseAge(patched, '720')).toBe(
      'minimumReleaseAge: 720\npackages:\n  - apps/*\n',
    );
  });

  it('is a no-op when the key is absent', () => {
    const yaml = 'packages:\n  - apps/*\n';
    expect(restoreMinimumReleaseAge(yaml, null)).toBe(yaml);
  });
});

describe('mergeMinimumReleaseAgeExclude', () => {
  it('appends a new block when target has none', () => {
    const target = 'packages:\n  - apps/*\n';
    const source = 'minimumReleaseAgeExclude:\n  lodash: 4.17.21\n';
    const out = mergeMinimumReleaseAgeExclude(target, source);
    expect(out).toBe('packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  lodash: 4.17.21\n');
  });

  it('merges entries entry-by-entry, with source overriding target', () => {
    const target =
      'minimumReleaseAgeExclude:\n  lodash: 4.17.20\n  axios: 1.6.0\npackages:\n  - apps/*\n';
    const source = 'minimumReleaseAgeExclude:\n  lodash: 4.17.21\n  vite: 5.4.0\n';
    const out = mergeMinimumReleaseAgeExclude(target, source);
    expect(out).toContain('  lodash: 4.17.21');
    expect(out).toContain('  axios: 1.6.0');
    expect(out).toContain('  vite: 5.4.0');
    expect(out).toContain('packages:');
  });

  it('returns the target unchanged when source has no exclude block', () => {
    const target = 'packages:\n  - apps/*\n';
    expect(mergeMinimumReleaseAgeExclude(target, 'overrides:\n  foo: 1\n')).toBe(target);
  });
});
