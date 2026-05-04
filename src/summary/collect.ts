/**
 * Run-summary data collection: parsing pnpm audit output, diffing
 * catalog/override snapshots, and reading workspace/package.json
 * overrides. Pure functions only — no rendering, no logging.
 */
import * as fs from 'node:fs';
import semver from 'semver';
import { getCatalogVersions } from '../catalog.js';
import {
  SEVERITY_RANK,
  type AdvisorySummary,
  type CatalogChange,
  type OverrideChange,
  type Severity,
} from './types.js';

const PNPM_AUDIT_SEVERITIES = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
  'unknown',
]);

/**
 * Parse `pnpm audit --json` stdout into a normalized advisory list.
 * Tolerates malformed input by returning an empty array.
 */
export function extractAdvisories(jsonStdout: string): AdvisorySummary[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const advisories = (parsed as { advisories?: Record<string, unknown> }).advisories;
  if (!advisories || typeof advisories !== 'object') return [];

  const out: AdvisorySummary[] = [];
  for (const [id, entry] of Object.entries(advisories)) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const sevRaw = typeof a.severity === 'string' ? a.severity.toLowerCase() : 'unknown';
    const severity: Severity = (PNPM_AUDIT_SEVERITIES as Set<string>).has(sevRaw)
      ? (sevRaw as Severity)
      : 'unknown';
    const cves = Array.isArray(a.cves)
      ? a.cves.filter((c): c is string => typeof c === 'string')
      : [];
    out.push({
      id,
      module: typeof a.module_name === 'string' ? a.module_name : '',
      severity,
      title: typeof a.title === 'string' ? a.title : '',
      url: typeof a.url === 'string' ? a.url : undefined,
      cves,
    });
  }
  return out;
}

export function bumpTier(before: string, after: string): CatalogChange['bump'] {
  const a = semver.coerce(before)?.version;
  const b = semver.coerce(after)?.version;
  if (!a || !b) return 'unknown';
  if (semver.major(b) > semver.major(a)) return 'major';
  if (semver.minor(b) > semver.minor(a)) return 'minor';
  if (semver.patch(b) !== semver.patch(a)) return 'patch';
  return 'unknown';
}

/** Compute the delta between two catalog snapshots (entries whose version changed). */
export function diffCatalog(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): CatalogChange[] {
  const changes: CatalogChange[] = [];
  for (const [name, afterVer] of after) {
    const beforeVer = before.get(name);
    if (!beforeVer) continue; // new catalog entries (rare) are out of scope
    if (beforeVer === afterVer) continue;
    changes.push({ name, before: beforeVer, after: afterVer, bump: bumpTier(beforeVer, afterVer) });
  }
  changes.sort((a, b) => a.name.localeCompare(b.name));
  return changes;
}

/**
 * Compute the delta between two override snapshots. Iterates both `before`
 * and `after` so additions, modifications, and removals are all reported.
 *
 * Removals are important when `pnpm audit --fix` re-derives the override
 * list from scratch and replaces user-pinned selectors (e.g. `tar@6.2.1`)
 * with broader range-form selectors (e.g. `tar@<=7.5.10`).
 */
export function diffOverrides(
  before: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>,
  after: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  for (const [selector, { value, source }] of after) {
    const prior = before.get(selector);
    if (!prior) {
      changes.push({ selector, after: value, source, kind: 'added' });
    } else if (prior.value !== value) {
      changes.push({
        selector,
        before: prior.value,
        after: value,
        source,
        kind: 'modified',
      });
    }
  }
  for (const [selector, { value, source }] of before) {
    if (!after.has(selector)) {
      changes.push({ selector, before: value, source, kind: 'removed' });
    }
  }
  changes.sort((a, b) => a.selector.localeCompare(b.selector));
  return changes;
}

/** Fixed = present in initial, absent (by id) from final. */
export function diffAdvisories(
  initial: readonly AdvisorySummary[],
  final: readonly AdvisorySummary[],
): { fixed: AdvisorySummary[]; remaining: AdvisorySummary[] } {
  const finalIds = new Set(final.map((a) => a.id));
  const fixed = initial.filter((a) => !finalIds.has(a.id));
  const sortBySev = (a: AdvisorySummary, b: AdvisorySummary): number =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.module.localeCompare(b.module);
  return {
    fixed: [...fixed].sort(sortBySev),
    remaining: [...final].sort(sortBySev),
  };
}

/**
 * Read the `overrides:` block from a workspace yaml string and return a
 * `selector -> value` map.
 */
export function readWorkspaceOverrides(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const blockRe = /^(overrides:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;
  const m = blockRe.exec(yaml);
  if (!m) return out;
  const body = m[2] ?? '';
  const entryRe =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^'"\r\n]+?))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s]+))\s*$/;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const em = entryRe.exec(line);
    if (!em) continue;
    const key = em[1] ?? em[2] ?? em[3] ?? '';
    const val = em[4] ?? em[5] ?? em[6] ?? '';
    if (key) out.set(key, val);
  }
  return out;
}

/** Read `pnpm.overrides` from a package.json text. Tolerant of malformed input. */
export function readPackageJsonOverrides(jsonText: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(jsonText) as { pnpm?: { overrides?: Record<string, unknown> } };
    const overrides = parsed?.pnpm?.overrides;
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === 'string') out.set(k, v);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/** Convenience: catalog snapshot from yaml text, only entries with concrete versions. */
export function readCatalogSnapshot(yaml: string): Map<string, string> {
  return new Map(getCatalogVersions(yaml));
}

/** Combine workspace + package.json overrides into one selector-keyed map. */
export function readAllOverrides(
  workspaceYaml: string,
  rootPackageJsonText: string | null,
): Map<string, { value: string; source: 'workspace' | 'package.json' }> {
  const out = new Map<string, { value: string; source: 'workspace' | 'package.json' }>();
  for (const [k, v] of readWorkspaceOverrides(workspaceYaml)) {
    out.set(k, { value: v, source: 'workspace' });
  }
  if (rootPackageJsonText) {
    for (const [k, v] of readPackageJsonOverrides(rootPackageJsonText)) {
      // package.json takes precedence in display when keys collide.
      out.set(k, { value: v, source: 'package.json' });
    }
  }
  return out;
}

/** Read a file, returning null on any error. */
export function safeReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
