import semver from 'semver';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner } from '../pnpm';
import { getAvailableVersions } from './registry';
export { getAvailableVersions } from './registry';
import { parsePnpmAuditOutput, type PnpmAuditParseResult, type PnpmAuditOutput } from './pnpmAudit';
export type { PnpmAuditAdvisory, PnpmAuditOutput } from './pnpmAudit';
import { readCatalog } from '../catalog';
import {
  compareSemVer,
  getConcreteVersion,
  normalizeRange,
  selectSafeBump,
  type BumpTier,
} from '../semverUtil';

/**
 * Options for `getDirectDepCatalogBumps`.
 */
export interface DirectDepBumpOptions {
  /**
   * When false, packages whose only non-vulnerable upgrade crosses a major
   * boundary are skipped (and a warning is logged) instead of being
   * promoted into the catalog. Defaults to true.
   */
  allowMajor?: boolean;
  /** Raw pre-fetched audit output for direct callers that have not parsed it. */
  auditJsonStdout?: string;
  /** Parsed result for an audit command already consumed by the caller. */
  auditSnapshot?: PnpmAuditParseResult;
  /**
   * Set of GHSA or CVE identifiers that should be ignored. Any advisory
   * matching one of these IDs is excluded from bump decisions.
   */
  ignoredAdvisoryIds?: ReadonlySet<string>;
}

/**
 * Result of computing direct-dep catalog bumps. The `tiers` map records
 * which tier (`patch` | `minor` | `major`) was selected for each bumped
 * package, primarily so callers can render `(MAJOR)` annotations.
 */
export interface DirectDepBumpResult {
  bumps: Map<string, string>;
  tiers: Map<string, BumpTier>;
}

export interface CatalogBumpDiagnostic {
  level: 'detail' | 'warn';
  message: string;
}

export interface CatalogBumpPlan extends DirectDepBumpResult {
  diagnostics: CatalogBumpDiagnostic[];
}

/** Deterministic catalog bump policy; performs no registry calls or logging. */
export function planCatalogBumps(input: {
  audit: PnpmAuditOutput;
  catalogNames: ReadonlySet<string>;
  catalogVersions: ReadonlyMap<string, string>;
  availableVersions: ReadonlyMap<string, readonly string[]>;
  allowMajor?: boolean;
  ignoredAdvisoryIds?: ReadonlySet<string>;
}): CatalogBumpPlan {
  const { audit, catalogNames, catalogVersions, availableVersions } = input;
  const allowMajor = input.allowMajor ?? true;
  const bumps = new Map<string, string>();
  const tiers = new Map<string, BumpTier>();
  const diagnostics: CatalogBumpDiagnostic[] = [];
  const detail = (message: string): void => {
    diagnostics.push({ level: 'detail', message });
  };
  const warn = (message: string): void => {
    diagnostics.push({ level: 'warn', message });
  };

  for (const advisory of Object.values(audit.advisories ?? {})) {
    const module = advisory.module_name ?? '';
    if (!catalogNames.has(module)) continue;

    if (input.ignoredAdvisoryIds && advisoryMatchesIgnoreList(advisory, input.ignoredAdvisoryIds)) {
      detail(`Skipped ignored advisory for ${module}.`);
      continue;
    }

    const current = catalogVersions.get(module);
    if (!advisoryAppliesToCurrent(current, advisory.vulnerable_versions)) {
      detail(
        `Skipped advisory for ${module}: catalog version ${current ?? '?'} is outside vulnerable range ${advisory.vulnerable_versions ?? '?'}.`,
      );
      continue;
    }

    const patchedRange = advisory.patched_versions ?? '';
    let chosen: string | null = null;
    let tier: BumpTier | null = null;
    const publishedVersions = availableVersions.get(module) ?? [];

    if (current) {
      const safe = selectSafeBump(current, patchedRange, publishedVersions);
      if (safe) {
        chosen = safe.version;
        tier = safe.tier;
      } else if (publishedVersions.length === 0) {
        warn(
          `No non-vulnerable version >= ${current} found for ${module} (range: ${patchedRange}). Falling back to advisory-suggested version.`,
        );
      } else {
        warn(
          `No published non-vulnerable version >= ${current} found for ${module} (range: ${patchedRange}); skipping the catalog bump.`,
        );
      }
    }

    if (!chosen && (!current || publishedVersions.length === 0)) {
      chosen = getConcreteVersion(patchedRange);
      if (chosen && current) tier = classifyTier(current, chosen);
    }
    if (!chosen) continue;

    if (tier === 'major' && !allowMajor) {
      warn(
        `Skipped ${module}: only a MAJOR bump (${current ?? '?'} -> ${chosen}) satisfies the advisory and --no-allow-major is set. Re-run with --allow-major to apply.`,
      );
      continue;
    }
    if (tier === 'major') {
      warn(
        `Major version bump required for ${module}: ${current ?? '?'} -> ${chosen}. Review changelog for breaking changes before merging.`,
      );
    }

    const existing = bumps.get(module);
    if (!existing || compareSemVer(chosen, existing) > 0) {
      bumps.set(module, chosen);
      if (tier) tiers.set(module, tier);
    }
  }
  return { bumps, tiers, diagnostics };
}

/** Fetch metadata, run the catalog policy, and report its decisions. */
export async function getDirectDepCatalogBumps(
  workspaceYaml: string,
  pnpm: PnpmCaptureRunner,
  logger: Logger,
  options: DirectDepBumpOptions = {},
): Promise<DirectDepBumpResult> {
  let snapshot = options.auditSnapshot;
  if (!snapshot) {
    const stdout = options.auditJsonStdout ?? (await pnpm.capture(['audit', '--json'])).stdout;
    snapshot = parsePnpmAuditOutput(stdout);
  }
  if (!snapshot.complete) {
    if (snapshot.reason === 'invalid-json') {
      logger.warn('Could not parse audit JSON. Skipping pre-audit catalog bump.');
    } else if (snapshot.reason === 'invalid-shape' && snapshot.topLevelKeys.length > 0) {
      logger.warn(
        `Audit JSON did not include an \`advisories\` field (saw: ${snapshot.topLevelKeys.join(', ')}). ` +
          'This may indicate an unsupported pnpm audit output shape.',
      );
    }
    return { bumps: new Map(), tiers: new Map() };
  }
  const audit = snapshot.audit;

  const { names: catalogNames, versions: catalogVersions } = readCatalog(workspaceYaml);
  const affectedModules = [
    ...new Set(
      Object.values(audit.advisories)
        .map((advisory) => advisory.module_name ?? '')
        .filter((name) => catalogNames.has(name)),
    ),
  ];
  const versionCache = new Map<string, string[]>();
  await Promise.all(affectedModules.map((name) => getAvailableVersions(pnpm, name, versionCache)));

  const plan = planCatalogBumps({
    audit,
    catalogNames,
    catalogVersions,
    availableVersions: versionCache,
    allowMajor: options.allowMajor,
    ignoredAdvisoryIds: options.ignoredAdvisoryIds,
  });
  for (const diagnostic of plan.diagnostics) {
    logger[diagnostic.level](diagnostic.message);
  }
  return { bumps: plan.bumps, tiers: plan.tiers };
}

export function advisoryAppliesToCurrent(
  current: string | undefined,
  vulnerableRange: string | undefined,
): boolean {
  if (!current || !vulnerableRange?.trim()) return true;
  const currentClean = semver.coerce(current)?.version;
  if (!currentClean) return true;

  const range = normalizeRange(vulnerableRange);
  if (!range) return true;
  return semver.satisfies(currentClean, range, { includePrerelease: false });
}

function classifyTier(from: string, to: string): BumpTier | null {
  const a = semver.coerce(from)?.version;
  const b = semver.coerce(to)?.version;
  if (!a || !b) return null;
  if (semver.major(b) > semver.major(a)) return 'major';
  if (semver.minor(b) > semver.minor(a)) return 'minor';
  return 'patch';
}

/**
 * Returns `true` when the advisory matches any ID in the ignore list.
 *
 * Matching rules:
 *  - `adv.github_advisory_id` is compared directly against `ignoredIds`.
 *  - The last path segment of `adv.url` matching `GHSA-*` is extracted and
 *    compared (handles advisories that embed the GHSA ID only in the URL).
 *  - Each entry in `adv.cves` is compared directly against `ignoredIds`.
 */
export function advisoryMatchesIgnoreList(
  adv: { github_advisory_id?: string; cves?: string[]; url?: string },
  ignoredIds: ReadonlySet<string>,
): boolean {
  if (ignoredIds.size === 0) return false;
  if (adv.github_advisory_id) {
    const normalizedId = adv.github_advisory_id.toLowerCase();
    for (const id of ignoredIds) {
      if (id.toLowerCase() === normalizedId) return true;
    }
  }
  if (adv.url) {
    const m = /\/(GHSA-[a-z0-9-]+)$/i.exec(adv.url);
    if (m?.[1]) {
      const ghsaFromUrl = m[1].toLowerCase();
      for (const id of ignoredIds) {
        if (id.toLowerCase() === ghsaFromUrl) return true;
      }
    }
  }
  if (Array.isArray(adv.cves)) {
    for (const cve of adv.cves) {
      if (typeof cve === 'string' && ignoredIds.has(cve)) return true;
    }
  }
  return false;
}
