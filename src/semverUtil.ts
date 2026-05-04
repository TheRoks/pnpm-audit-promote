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

/** Severity tier of a chosen catalog bump relative to the current version. */
export type BumpTier = 'patch' | 'minor' | 'major';

export interface SafeBumpResult {
  version: string;
  tier: BumpTier;
}

/**
 * Pick the smallest non-vulnerable version that is `>= current`, preferring
 * (in order): same `major.minor` (patch tier), same `major` (minor tier),
 * and finally any newer (major tier).
 *
 * `available` is the list of published versions for the package (e.g. from
 * `pnpm view <pkg> versions --json`). If empty, we fall back to deriving a
 * single candidate from `semver.minVersion(patchedRange)`.
 *
 * Returns `null` when no eligible version satisfies `patchedRange` while
 * also being `>= current`.
 */
export function selectSafeBump(
  current: string,
  patchedRange: string,
  available: readonly string[],
): SafeBumpResult | null {
  const currentClean = semver.coerce(current)?.version;
  if (!currentClean) return null;
  if (!patchedRange || !patchedRange.trim()) return null;

  const range = normalizeRange(patchedRange);
  if (!range) return null;

  const candidates = (available.length > 0 ? available : fallbackCandidates(range))
    .map((v) => semver.coerce(v)?.version)
    .filter((v): v is string => Boolean(v))
    // Drop prereleases — promoting a prerelease into a catalog is rarely desired.
    .filter((v) => !semver.prerelease(v))
    .filter((v) => semver.satisfies(v, range, { includePrerelease: false }))
    .filter((v) => semver.gte(v, currentClean));

  if (candidates.length === 0) return null;

  const sorted = [...new Set(candidates)].sort(semver.compare);
  const curMajor = semver.major(currentClean);
  const curMinor = semver.minor(currentClean);

  const samePatchLine = sorted.find(
    (v) => semver.major(v) === curMajor && semver.minor(v) === curMinor,
  );
  if (samePatchLine) return { version: samePatchLine, tier: 'patch' };

  const sameMajor = sorted.find((v) => semver.major(v) === curMajor);
  if (sameMajor) return { version: sameMajor, tier: 'minor' };

  const major = sorted[0];
  if (!major) return null;
  return { version: major, tier: 'major' };
}

/**
 * Normalize an npm/pnpm `patched_versions` string into a SemVer range.
 * Handles common shapes like `>=1.2.3`, `>=1.2.3 <2.0.0`, `1.x`, and
 * comma-separated alternates by converting them to `||` form.
 */
export function normalizeRange(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Some advisories use comma as alternation separator.
  const candidate = trimmed.includes('||') ? trimmed : trimmed.replace(/\s*,\s*/g, ' || ');
  if (semver.validRange(candidate)) return candidate;
  if (semver.validRange(trimmed)) return trimmed;
  return null;
}

/**
 * Fallback when no published-version list is available: derive the lowest
 * version satisfying the range via `semver.minVersion`.
 */
function fallbackCandidates(range: string): string[] {
  try {
    const min = semver.minVersion(range);
    return min ? [min.version] : [];
  } catch {
    return [];
  }
}
