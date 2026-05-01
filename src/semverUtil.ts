import semver from 'semver';

/**
 * Compare two version strings, tolerating SemVer prerelease/build suffixes.
 * Returns -1, 0, or 1 — `a` relative to `b`.
 */
export function compareSemVer(a: string, b: string): number {
  const ca = semver.coerce(a, { includePrerelease: true });
  const cb = semver.coerce(b, { includePrerelease: true });
  if (ca && cb) {
    const av = `${ca.version}${a.includes('-') ? a.slice(a.indexOf('-')) : ''}`;
    const bv = `${cb.version}${b.includes('-') ? b.slice(b.indexOf('-')) : ''}`;
    try {
      return semver.compare(av, bv);
    } catch {
      // fall through to manual compare
    }
  }
  return manualCompare(a, b);
}

function manualCompare(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split(/[-+]/, 2);
    const nums = (core ?? '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 4) nums.push(0);
    return { nums, pre: pre ?? '' };
  };
  const av = split(a);
  const bv = split(b);
  for (let i = 0; i < 4; i++) {
    const an = av.nums[i] ?? 0;
    const bn = bv.nums[i] ?? 0;
    if (an < bn) return -1;
    if (an > bn) return 1;
  }
  if (av.pre && !bv.pre) return -1;
  if (!av.pre && bv.pre) return 1;
  if (av.pre < bv.pre) return -1;
  if (av.pre > bv.pre) return 1;
  return 0;
}

/**
 * Parse the bare package name from an override key that may carry a version
 * qualifier (e.g. `vite@>=7.0.0 <=7.3.1` -> `vite`,
 * `@scope/pkg@^1.0.0` -> `@scope/pkg`).
 */
export function getBarePackageName(key: string): string {
  if (key.startsWith('@')) {
    const m = key.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/);
    return m?.[1] ?? key;
  }
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * Normalize a version range to a concrete catalog version. Returns null if
 * the value is not a concrete version (e.g. `$name` references or unrecognized
 * formats).
 */
export function getConcreteVersion(range: string | undefined | null): string | null {
  if (!range || !range.trim()) return null;
  if (range.startsWith('$')) return null;
  const m = range.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m?.[1] ?? null;
}

/**
 * Determine if an override key is a plain package name (no `name@range`
 * qualifier).
 */
export function isPlainPackageName(key: string): boolean {
  if (key.startsWith('@')) return /^@[^/@]+\/[^/@]+$/.test(key);
  return !key.includes('@');
}
