/**
 * Run-summary data collection: parsing pnpm audit output, diffing
 * catalog/override snapshots, and reading workspace/package.json
 * overrides. Pure functions only — no rendering, no logging.
 */
import * as fs from 'node:fs';
export {
  readAllOverrides,
  readPackageJsonOverrides,
  readWorkspaceOverrides,
} from '../workspaceOverrides';
import semver from 'semver';
import { getCatalogVersions } from '../catalog';
import { parsePnpmAuditOutput, type PnpmAuditOutput } from '../audit/pnpmAudit';
import {
  SEVERITY_RANK,
  type AdvisorySummary,
  type CatalogChange,
  type OverrideChange,
  type Severity,
} from './types';

const PNPM_AUDIT_SEVERITIES = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
  'unknown',
]);

interface AuditAdvisoryExtraction {
  complete: boolean;
  advisories: AdvisorySummary[];
}

/**
 * Parse `pnpm audit --json` stdout into a normalized advisory list.
 * Tolerates malformed input by returning an empty array.
 */
export function extractAdvisories(jsonStdout: string): AdvisorySummary[] {
  return extractAdvisoriesWithStatus(jsonStdout).advisories;
}

/**
 * Internal status-aware audit parser. A valid audit response must contain an
 * `advisories` object; malformed and error-shaped payloads are incomplete.
 */
export function extractAdvisoriesWithStatus(jsonStdout: string): AuditAdvisoryExtraction {
  const parsed = parsePnpmAuditOutput(jsonStdout);
  if (!parsed.complete) {
    return { complete: false, advisories: [] };
  }

  return { complete: true, advisories: summarizeAuditAdvisories(parsed.audit) };
}

/** Convert the shared pnpm audit model into the summary's presentation rows. */
export function summarizeAuditAdvisories(audit: PnpmAuditOutput): AdvisorySummary[] {
  const out: AdvisorySummary[] = [];
  for (const [id, advisory] of Object.entries(audit.advisories)) {
    const sevRaw = advisory.severity?.toLowerCase() ?? 'unknown';
    const severity: Severity = (PNPM_AUDIT_SEVERITIES as Set<string>).has(sevRaw)
      ? (sevRaw as Severity)
      : 'unknown';
    out.push({
      id,
      module: advisory.module_name ?? '',
      severity,
      title: advisory.title ?? '',
      url: advisory.url,
      cves: advisory.cves ?? [],
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

/** Convenience: catalog snapshot from yaml text, only entries with concrete versions. */
export function readCatalogSnapshot(yaml: string): Map<string, string> {
  return new Map(getCatalogVersions(yaml));
}

/** Read a file, returning null on any error. */
export function safeReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
