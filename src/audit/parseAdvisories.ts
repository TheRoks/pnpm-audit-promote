import semver from 'semver';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import type { PnpmRunner } from '../pnpm';
import { readCatalog } from '../catalog';
import {
  compareSemVer,
  getConcreteVersion,
  normalizeRange,
  selectSafeBump,
  type BumpTier,
} from '../semverUtil';

interface PnpmAuditAdvisory {
  module_name?: string;
  patched_versions?: string;
  vulnerable_versions?: string;
  findings?: Array<{ paths?: string[] }>;
  github_advisory_id?: string;
  cves?: string[];
  url?: string;
}

interface PnpmAuditOutput {
  advisories?: Record<string, PnpmAuditAdvisory>;
}

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
  /**
   * Pre-fetched `pnpm audit --json` stdout. When provided, the function
   * skips its own capture call. Used by the run-summary feature to avoid
   * running audit twice.
   */
  auditJsonStdout?: string;
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

/**
 * Compute catalog version bumps for vulnerabilities found by `pnpm audit
 * --json`. Picks the smallest non-vulnerable version that is `>= the current
 * catalog version`, preferring patch over minor over major. Processes every
 * package listed in the pnpm catalog — including those that are direct deps
 * of child workspace packages rather than the root — because a catalog entry
 * controls the resolved version for all workspace consumers.
 * Major bumps are explicitly logged via `logger.warn` because they can
 * introduce breaking changes.
 */
export async function getDirectDepCatalogBumps(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  options: DirectDepBumpOptions = {},
): Promise<DirectDepBumpResult> {
  const allowMajor = options.allowMajor ?? true;
  const bumps = new Map<string, string>();
  const tiers = new Map<string, BumpTier>();
  const stdout = options.auditJsonStdout ?? (await pnpm.capture(['audit', '--json'])).stdout;
  if (!stdout.trim()) return { bumps, tiers };

  let audit: PnpmAuditOutput;
  try {
    audit = JSON.parse(stdout) as PnpmAuditOutput;
  } catch {
    logger.warn('Could not parse audit JSON. Skipping pre-audit catalog bump.');
    return { bumps, tiers };
  }
  if (!audit.advisories) {
    // pnpm 11 switched to the bulk-advisories endpoint but kept the
    // top-level `advisories` map. If we see an unrecognized shape, surface
    // a warning so the user knows to file an issue rather than silently
    // skip every advisory.
    const keys = Object.keys((audit as Record<string, unknown>) ?? {});
    if (keys.length > 0) {
      logger.warn(
        `Audit JSON did not include an \`advisories\` field (saw: ${keys.join(', ')}). ` +
          'This may indicate an unsupported pnpm audit output shape.',
      );
    }
    return { bumps, tiers };
  }

  const { names: catalogNames, versions: catalogVersions } = readCatalog(
    state.desiredWorkspaceYaml,
  );
  const versionCache = new Map<string, string[]>();

  // Pre-fetch version lists for all affected catalog modules in parallel so
  // each registry round-trip fires concurrently instead of sequentially.
  const affectedModules = [
    ...new Set(
      Object.values(audit.advisories)
        .map((adv) => adv.module_name ?? '')
        .filter((m) => catalogNames.has(m)),
    ),
  ];
  await Promise.all(affectedModules.map((m) => getAvailableVersions(pnpm, m, versionCache)));

  for (const adv of Object.values(audit.advisories)) {
    const module = adv.module_name ?? '';
    if (!catalogNames.has(module)) continue;

    if (options.ignoredAdvisoryIds && advisoryMatchesIgnoreList(adv, options.ignoredAdvisoryIds)) {
      logger.detail(`Skipped ignored advisory for ${module}.`);
      continue;
    }

    const current = catalogVersions.get(module);
    if (!advisoryAppliesToCurrent(current, adv.vulnerable_versions)) {
      logger.detail(
        `Skipped advisory for ${module}: catalog version ${current ?? '?'} is outside vulnerable range ${adv.vulnerable_versions ?? '?'}.`,
      );
      continue;
    }

    const patchedRange = adv.patched_versions ?? '';
    let chosen: string | null = null;
    let tier: BumpTier | null = null;

    if (current) {
      const available = await getAvailableVersions(pnpm, module, versionCache);
      const safe = selectSafeBump(current, patchedRange, available);
      if (safe) {
        chosen = safe.version;
        tier = safe.tier;
      } else {
        logger.warn(
          `No non-vulnerable version >= ${current} found for ${module} (range: ${patchedRange}). Falling back to advisory-suggested version.`,
        );
      }
    }

    if (!chosen) {
      // Fallback: advisory-derived concrete version (legacy behavior).
      chosen = getConcreteVersion(patchedRange);
      if (chosen && current) {
        tier = classifyTier(current, chosen);
      }
    }
    if (!chosen) continue;

    if (tier === 'major' && !allowMajor) {
      logger.warn(
        `Skipped ${module}: only a MAJOR bump (${current ?? '?'} -> ${chosen}) satisfies the advisory and --no-allow-major is set. Re-run with --allow-major to apply.`,
      );
      continue;
    }

    if (tier === 'major') {
      logger.warn(
        `Major version bump required for ${module}: ${current ?? '?'} -> ${chosen}. Review changelog for breaking changes before merging.`,
      );
    }

    const existing = bumps.get(module);
    if (!existing || compareSemVer(chosen, existing) > 0) {
      bumps.set(module, chosen);
      if (tier) tiers.set(module, tier);
    }
  }
  return { bumps, tiers };
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

/**
 * Fetch the published version list for `module` via `pnpm view`. Results are
 * cached per call site to avoid duplicate network/registry hits when the
 * same package appears in multiple advisories. Returns `[]` on any failure
 * so callers transparently fall back to `semver.minVersion`-based logic.
 */
export async function getAvailableVersions(
  pnpm: PnpmRunner,
  module: string,
  cache: Map<string, string[]>,
): Promise<string[]> {
  const cached = cache.get(module);
  if (cached) return cached;
  let versions: string[] = [];
  try {
    const { stdout } = await pnpm.capture(['view', module, 'versions', '--json']);
    const text = stdout.trim();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        versions = parsed.filter((v): v is string => typeof v === 'string');
      } else if (typeof parsed === 'string') {
        versions = [parsed];
      }
    }
  } catch {
    versions = [];
  }
  cache.set(module, versions);
  return versions;
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
