import semver from 'semver';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

/**
 * Parse the top-level `minimumReleaseAge` (minutes) from a
 * `pnpm-workspace.yaml` file. Returns the positive numeric value when present,
 * `null` otherwise (absent, zero, negative, or unparseable). pnpm only enforces
 * the release-age gate when this value is `> 0`, so `null` means "guard
 * inactive".
 */
export function readMinimumReleaseAge(yamlContent: string): number | null {
  if (!yamlContent.trim()) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = (parsed as Record<string, unknown>)['minimumReleaseAge'];
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** A single parsed `minimumReleaseAgeExclude` entry. */
export interface ReleaseAgeExcludeEntry {
  /** Package-name glob (e.g. `lodash`, `@myorg/*`). */
  name: string;
  /** Optional semver range qualifier (the part after `@`). */
  range?: string;
}

function splitNameAndRange(spec: string): ReleaseAgeExcludeEntry {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  if (at <= 0) return { name: spec };
  const range = spec.slice(at + 1).trim();
  return range ? { name: spec.slice(0, at), range } : { name: spec.slice(0, at) };
}

/**
 * Parse the user's `minimumReleaseAgeExclude` block (string-sequence or
 * mapping form) into structured entries. Returns `[]` on any parse failure or
 * when the block is absent.
 */
export function parseMinimumReleaseAgeExclude(yamlContent: string): ReleaseAgeExcludeEntry[] {
  if (!yamlContent.trim()) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const raw = (parsed as Record<string, unknown>)['minimumReleaseAgeExclude'];
  const entries: ReleaseAgeExcludeEntry[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) entries.push(splitNameAndRange(item.trim()));
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) entries.push({ name, range: value.trim() });
      else entries.push({ name });
    }
  }
  return entries;
}

function nameMatches(name: string, pattern: string): boolean {
  try {
    return picomatch(pattern)(name);
  } catch {
    return name === pattern;
  }
}

/**
 * Determine whether the user's `minimumReleaseAgeExclude` list already covers
 * `name`/`version`, meaning the user has opted that package out of the
 * release-age gate and the override must be kept untouched.
 */
export function isExcludedByReleaseAge(
  name: string,
  version: string | null,
  entries: readonly ReleaseAgeExcludeEntry[],
): boolean {
  for (const entry of entries) {
    if (!nameMatches(name, entry.name)) continue;
    if (!entry.range) return true;
    if (version === null) return true;
    const clean = semver.valid(version) ?? semver.coerce(version)?.version ?? null;
    if (clean && semver.satisfies(clean, entry.range, { includePrerelease: true })) return true;
  }
  return false;
}

/**
 * Whether a version published at `publishedIso` is at least `minutes` old as of
 * `now`. A missing or unparseable timestamp returns `true` (the version is
 * treated as allowed, honouring pnpm's `minimumReleaseAgeIgnoreMissingTime`).
 */
export function isOldEnough(publishedIso: string | undefined, minutes: number, now: Date): boolean {
  if (!publishedIso) return true;
  const published = Date.parse(publishedIso);
  if (Number.isNaN(published)) return true;
  const ageMinutes = (now.getTime() - published) / 60_000;
  return ageMinutes >= minutes;
}

/** An override dropped because no satisfying version is old enough. */
export interface BlockedOverride {
  /** The override key as written (may carry a selector). */
  key: string;
  /** Bare package name. */
  name: string;
  /** The override value pnpm wrote (exact version or range). */
  value: string;
  /** The configured minimum age that blocked the override. */
  minimumReleaseAgeMinutes: number;
}
/** Return the satisfying versions for an override value, or null for protocols. */
export function selectReleaseAgeCandidates(
  value: string,
  availableVersions: readonly string[],
): string[] | null {
  if (semver.valid(value)) return [value];
  if (!semver.validRange(value)) return null;
  return availableVersions.filter((version) =>
    semver.satisfies(version, value, { includePrerelease: false }),
  );
}

/** Pure decision: true only when every candidate is too fresh under the configured gate. */
export function shouldBlockOverrideForReleaseAge(options: {
  name: string;
  value: string;
  minutes: number;
  excludeEntries: readonly ReleaseAgeExcludeEntry[];
  candidates: readonly string[];
  publishTimes: ReadonlyMap<string, string>;
  now: Date;
}): boolean {
  const { name, value, minutes, excludeEntries, candidates, publishTimes, now } = options;
  const referenceVersion = semver.valid(value) ?? semver.minVersion(value)?.version ?? null;
  if (isExcludedByReleaseAge(name, referenceVersion, excludeEntries) || candidates.length === 0) {
    return false;
  }
  return !candidates.some((version) => isOldEnough(publishTimes.get(version), minutes, now));
}
