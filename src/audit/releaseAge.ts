import semver from 'semver';
import picomatch from 'picomatch';
import { parse as parseYaml, isMap, isScalar, type Pair } from 'yaml';
import type { Logger } from '../logger';
import type { PnpmRunner } from '../pnpm';
import type { WorkspaceState } from '../workspace';
import { parseWorkspaceDoc, serializeDoc } from '../catalog';
import { getBarePackageName } from '../semverUtil';
import { getAvailableVersions } from './parseAdvisories';

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
 * Fetch the registry publish timestamps (`version -> ISO date`) for `pkg` via
 * `pnpm view <pkg> time --json`. Results are cached per call site. Returns an
 * empty map on any failure, which callers treat as "publish time unavailable"
 * (and therefore old enough, honouring `minimumReleaseAgeIgnoreMissingTime`).
 */
export async function fetchPublishTimes(
  pnpm: PnpmRunner,
  pkg: string,
  cache: Map<string, Map<string, string>>,
): Promise<Map<string, string>> {
  const cached = cache.get(pkg);
  if (cached) return cached;
  const times = new Map<string, string>();
  try {
    const { stdout } = await pnpm.capture(['view', pkg, 'time', '--json']);
    const text = stdout.trim();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [version, iso] of Object.entries(parsed as Record<string, unknown>)) {
          if (version === 'created' || version === 'modified') continue;
          if (typeof iso === 'string' && semver.valid(version)) times.set(version, iso);
        }
      }
    }
  } catch {
    // leave empty
  }
  cache.set(pkg, times);
  return times;
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
}

/**
 * REQ-PNPM11-012: after `pnpm audit --fix`, verify every override pnpm wrote
 * into `pnpm-workspace.yaml` against the user's `minimumReleaseAge` gate.
 *
 * An override is dropped when **all** of its satisfying published versions were
 * published more recently than `minimumReleaseAge` ago (i.e. none is old
 * enough). Leaving such an override in place would make the subsequent
 * `pnpm install` fail under pnpm's strict release-age resolution; dropping it
 * keeps the install working without expanding the user's
 * `minimumReleaseAgeExclude` list (REQ-PNPM11-011).
 *
 * Overrides matching the user's own exclude entries are kept, as are overrides
 * whose value is not a plain version/range (e.g. `npm:`/`catalog:`/`link:`),
 * and those for which no candidate version or publish time can be resolved.
 *
 * No-op when there is no workspace yaml, no `overrides` block, or no positive
 * `minimumReleaseAge`. Honours `dryRun` via {@link WorkspaceState.saveWorkspaceYaml}.
 */
export async function guardWorkspaceOverrideReleaseAge(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  options: { now?: Date } = {},
): Promise<BlockedOverride[]> {
  if (!state.hasWorkspaceYaml) return [];
  const current = state.readWorkspaceYaml();
  const minutes = readMinimumReleaseAge(current);
  if (minutes === null) return [];

  const doc = parseWorkspaceDoc(current);
  if (!doc) return [];
  const overridesNode = doc.get('overrides', true);
  if (!isMap(overridesNode)) return [];

  const excludeEntries = parseMinimumReleaseAgeExclude(current);
  const now = options.now ?? new Date();
  const versionsCache = new Map<string, string[]>();
  const timesCache = new Map<string, Map<string, string>>();

  const keepItems: Pair[] = [];
  const dropped: BlockedOverride[] = [];

  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const val = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || val === null) {
      keepItems.push(item);
      continue;
    }

    const name = getBarePackageName(key);
    const refVersion = semver.valid(val) ?? semver.minVersion(val)?.version ?? null;
    if (isExcludedByReleaseAge(name, refVersion, excludeEntries)) {
      keepItems.push(item);
      continue;
    }

    let candidates: string[];
    if (semver.valid(val)) {
      candidates = [val];
    } else if (semver.validRange(val)) {
      const available = await getAvailableVersions(pnpm, name, versionsCache);
      candidates = available.filter((v) => semver.satisfies(v, val, { includePrerelease: false }));
    } else {
      keepItems.push(item);
      continue;
    }

    if (candidates.length === 0) {
      keepItems.push(item);
      continue;
    }

    const times = await fetchPublishTimes(pnpm, name, timesCache);
    const someOldEnough = candidates.some((v) => isOldEnough(times.get(v), minutes, now));
    if (someOldEnough) {
      keepItems.push(item);
      continue;
    }

    dropped.push({ key, name, value: val });
    logger.warn(
      `Dropping override ${key} -> ${val}: no published version satisfying it is older than ` +
        `minimumReleaseAge (${minutes} min). Re-run once the patch matures, or add it to ` +
        `minimumReleaseAgeExclude yourself to allow the fresh version.`,
    );
  }

  if (dropped.length === 0) return [];

  if (keepItems.length === 0) {
    doc.delete('overrides');
  } else {
    overridesNode.items = keepItems;
  }
  const next = serializeDoc(doc, current);
  state.saveWorkspaceYaml(next);
  state.desiredWorkspaceYaml = next;
  logger.detail(
    `Dropped ${dropped.length} override(s) blocked by minimumReleaseAge before reinstall.`,
  );
  return dropped;
}
