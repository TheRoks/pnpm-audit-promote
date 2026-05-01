import { describe, it, expect } from 'vitest';
import {
  compareSemVer,
  getBarePackageName,
  getConcreteVersion,
  isPlainPackageName,
  selectSafeBump,
} from '../src/semverUtil.js';

describe('compareSemVer', () => {
  it('compares basic versions', () => {
    expect(compareSemVer('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemVer('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemVer('1.2.3', '1.2.3')).toBe(0);
  });

  it('handles prerelease ordering', () => {
    expect(compareSemVer('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemVer('1.0.0-beta', '1.0.0-alpha')).toBe(1);
  });

  it('coerces non-strict version strings', () => {
    expect(compareSemVer('1.0', '1.0.1')).toBe(-1);
  });
});

describe('getBarePackageName', () => {
  it('returns plain name unchanged', () => {
    expect(getBarePackageName('lodash')).toBe('lodash');
  });

  it('strips version qualifier', () => {
    expect(getBarePackageName('vite@>=7.0.0 <=7.3.1')).toBe('vite');
  });

  it('preserves scoped package names', () => {
    expect(getBarePackageName('@scope/pkg')).toBe('@scope/pkg');
    expect(getBarePackageName('@scope/pkg@^1.0.0')).toBe('@scope/pkg');
  });
});

describe('getConcreteVersion', () => {
  it('extracts a concrete version from a range', () => {
    expect(getConcreteVersion('^1.2.3')).toBe('1.2.3');
    expect(getConcreteVersion('>=2.0.0 <3.0.0')).toBe('2.0.0');
  });

  it('returns null for catalog references', () => {
    expect(getConcreteVersion('$react')).toBeNull();
  });

  it('returns null for empty/undefined', () => {
    expect(getConcreteVersion('')).toBeNull();
    expect(getConcreteVersion(null)).toBeNull();
    expect(getConcreteVersion(undefined)).toBeNull();
  });

  it('preserves prerelease', () => {
    expect(getConcreteVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });
});

describe('isPlainPackageName', () => {
  it('identifies plain names', () => {
    expect(isPlainPackageName('lodash')).toBe(true);
    expect(isPlainPackageName('@scope/pkg')).toBe(true);
  });

  it('rejects names with qualifiers', () => {
    expect(isPlainPackageName('vite@^7.0.0')).toBe(false);
    expect(isPlainPackageName('@scope/pkg@1.0.0')).toBe(false);
  });
});

describe('selectSafeBump', () => {
  it('prefers patch tier when same major.minor satisfies', () => {
    const r = selectSafeBump('18.2.0', '>=18.2.1', ['18.2.1', '18.3.1', '19.0.0']);
    expect(r).toEqual({ version: '18.2.1', tier: 'patch' });
  });

  it('falls back to minor tier when no patch satisfies', () => {
    const r = selectSafeBump('18.2.0', '>=18.3.1', ['18.3.1', '19.0.0']);
    expect(r).toEqual({ version: '18.3.1', tier: 'minor' });
  });

  it('falls back to major tier when no same-major satisfies', () => {
    const r = selectSafeBump('18.2.0', '>=19.0.0', ['18.2.0', '19.0.0', '20.0.0']);
    expect(r).toEqual({ version: '19.0.0', tier: 'major' });
  });

  it('returns null when no version >= current satisfies', () => {
    const r = selectSafeBump('18.2.0', '<18.0.0', ['17.0.0', '18.0.0']);
    expect(r).toBeNull();
  });

  it('works without an available list (falls back to minVersion)', () => {
    const r = selectSafeBump('1.0.0', '>=1.2.3', []);
    expect(r).toEqual({ version: '1.2.3', tier: 'minor' });
  });

  it('handles comma-separated alternation', () => {
    const r = selectSafeBump('1.0.0', '>=1.2.0, >=1.3.0', ['1.2.0', '1.3.0']);
    expect(r?.version).toBe('1.2.0');
  });

  it('ignores prereleases in the available list', () => {
    const r = selectSafeBump('1.0.0', '>=1.0.1', ['1.0.1-beta.1', '1.0.1', '1.0.2']);
    expect(r).toEqual({ version: '1.0.1', tier: 'patch' });
  });
});
