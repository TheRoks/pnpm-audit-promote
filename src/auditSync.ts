import * as fs from 'node:fs';
import semver from 'semver';
import type { Logger } from './logger.js';
import type { WorkspaceState } from './workspace.js';
import type { PnpmRunner } from './pnpm.js';
import {
  CATALOG_BLOCK_PATTERN,
  OVERRIDES_BLOCK_PATTERN,
  applyCatalogUpdates,
  collapseBlankLines,
  getCatalogNames,
  getCatalogVersions,
} from './catalog.js';
import { findMatchingBrace } from './jsonEdit.js';
import {
  compareSemVer,
  getBarePackageName,
  getConcreteVersion,
  isPlainPackageName,
  selectSafeBump,
  type BumpTier,
} from './semverUtil.js';

interface PnpmAuditAdvisory {
  module_name?: string;
  patched_versions?: string;
  findings?: Array<{ paths?: string[] }>;
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
 * Compute catalog version bumps for direct-dependency vulnerabilities found
 * by `pnpm audit --json`. Picks the smallest non-vulnerable version that is
 * `>= the current catalog version`, preferring patch over minor over major.
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
  const { stdout } = await pnpm.capture(['audit', '--json']);
  if (!stdout.trim()) return { bumps, tiers };

  let audit: PnpmAuditOutput;
  try {
    audit = JSON.parse(stdout) as PnpmAuditOutput;
  } catch {
    logger.warn('Could not parse audit JSON; skipping pre-audit bump.');
    return { bumps, tiers };
  }
  if (!audit.advisories) return { bumps, tiers };

  const catalogNames = getCatalogNames(state.desiredWorkspaceYaml);
  const catalogVersions = getCatalogVersions(state.desiredWorkspaceYaml);
  const versionCache = new Map<string, string[]>();

  for (const adv of Object.values(audit.advisories)) {
    const module = adv.module_name ?? '';
    if (!catalogNames.has(module)) continue;

    let isDirect = false;
    for (const f of adv.findings ?? []) {
      for (const p of f.paths ?? []) {
        const segs = p.split('>').map((s) => s.trim());
        if (segs.length < 1) continue;
        const first = segs[0] === '.' && segs.length >= 2 ? segs[1] : segs[0];
        if (first === module) {
          isDirect = true;
          break;
        }
      }
      if (isDirect) break;
    }
    if (!isDirect) continue;

    const patchedRange = adv.patched_versions ?? '';
    const current = catalogVersions.get(module);
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
          `No non-vulnerable version >= ${current} found for ${module} (range: ${patchedRange}); falling back to advisory-suggested version.`,
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
        `Skipping ${module}: only a MAJOR bump (${current ?? '?'} -> ${chosen}) satisfies the advisory and --no-allow-major is set. Re-run with --allow-major to apply.`,
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

/**
 * Fetch the published version list for `module` via `pnpm view`. Results are
 * cached per call site to avoid duplicate network/registry hits when the
 * same package appears in multiple advisories. Returns `[]` on any failure
 * so callers transparently fall back to `semver.minVersion`-based logic.
 */
async function getAvailableVersions(
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
 * Promote direct-dependency audit fixes from the workspace yaml `overrides:`
 * block into the `catalog:` block. Transitive-only overrides (those whose key
 * carries a version qualifier or names a non-catalog package) are kept.
 * Returns the new desired workspace yaml content.
 */
export function syncAuditOverridesIntoCatalog(state: WorkspaceState, logger: Logger): string {
  const current = state.readWorkspaceYaml();
  const om = OVERRIDES_BLOCK_PATTERN.exec(current);
  const cm = CATALOG_BLOCK_PATTERN.exec(current);
  if (!om || !cm) return current;

  const overridesBody = om[2] ?? '';
  const catalogNames = getCatalogNames(current);
  const remaining: string[] = [];
  const updates = new Map<string, string>();
  const entryPattern =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/;

  for (const line of overridesBody.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = entryPattern.exec(line);
    if (m) {
      const key = m[1] ?? m[2] ?? m[3] ?? '';
      const val = m[4] ?? m[5] ?? m[6] ?? '';
      if (isPlainPackageName(key) && catalogNames.has(key)) {
        updates.set(key, val);
        continue;
      }
    }
    remaining.push(line);
  }

  if (updates.size === 0) return current;

  const priorVersions = getCatalogVersions(current);
  logger.detail('Promoting direct-dep audit fixes into catalog:');
  for (const [k, v] of updates) {
    const annotation = majorBumpAnnotation(priorVersions.get(k), v);
    logger.bullet(`${k} -> ${v}${annotation}`);
  }
  warnOnMajorPromotions(updates, priorVersions, logger);

  let newYaml = applyCatalogUpdates(current, updates);

  // Re-locate the overrides block in the rewritten yaml and replace or strip.
  const om2 = OVERRIDES_BLOCK_PATTERN.exec(newYaml);
  if (om2) {
    const eol = state.yamlEol;
    if (remaining.length > 0) {
      const remainingBody = remaining.join(eol).replace(/\s+$/, '') + eol;
      const newBlock = `overrides:${eol}${remainingBody}`;
      newYaml = newYaml.slice(0, om2.index) + newBlock + newYaml.slice(om2.index + om2[0].length);
    } else {
      newYaml = newYaml.slice(0, om2.index) + newYaml.slice(om2.index + om2[0].length);
    }
    newYaml = collapseBlankLines(newYaml);
  }

  state.saveWorkspaceYaml(newYaml);
  return newYaml;
}

/**
 * Promote direct-dependency audit fixes from the root package.json's
 * `pnpm.overrides` block into the pnpm catalog. Returns the (possibly
 * updated) desired workspace yaml content.
 */
export function syncPackageJsonOverridesIntoCatalog(
  state: WorkspaceState,
  desiredYaml: string,
  logger: Logger,
): string {
  if (!fs.existsSync(state.rootPackageJson)) return desiredYaml;

  const pjText = fs.readFileSync(state.rootPackageJson, 'utf8');
  const startMatch = /"overrides"\s*:\s*\{/.exec(pjText);
  if (!startMatch) return desiredYaml;

  const bodyStart = startMatch.index + startMatch[0].length;
  const end = findMatchingBrace(pjText, bodyStart - 1);
  if (end < 0) return desiredYaml;

  const body = pjText.slice(bodyStart, end);

  const catalogNames = getCatalogNames(desiredYaml);
  const promotions = new Map<string, string>();
  const keptLines: string[] = [];
  const entryRe = /^([ \t]*)"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,?)\s*$/;

  for (const line of body.split(/\r?\n/)) {
    const m = entryRe.exec(line);
    if (m) {
      const key = m[2] ?? '';
      const val = m[3] ?? '';
      const bare = getBarePackageName(key);
      if (catalogNames.has(bare)) {
        const version = getConcreteVersion(val);
        if (version) {
          const existing = promotions.get(bare);
          if (!existing || compareSemVer(version, existing) > 0) {
            promotions.set(bare, version);
          }
          continue;
        }
      }
    }
    keptLines.push(line);
  }

  if (promotions.size === 0) return desiredYaml;

  const priorVersions = getCatalogVersions(desiredYaml);
  logger.detail('Promoting direct-dep audit fixes from package.json into catalog:');
  for (const [k, v] of promotions) {
    const annotation = majorBumpAnnotation(priorVersions.get(k), v);
    logger.bullet(`${k} -> ${v}${annotation}`);
  }
  warnOnMajorPromotions(promotions, priorVersions, logger);

  const newYaml = applyCatalogUpdates(desiredYaml, promotions);
  state.saveWorkspaceYaml(newYaml);

  // Trim leading/trailing blank lines from the kept entries.
  const cleaned = [...keptLines];
  while (cleaned.length > 0 && !cleaned[0]!.trim()) cleaned.shift();
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1]!.trim()) cleaned.pop();

  // Strip any dangling comma from the last remaining entry.
  for (let j = cleaned.length - 1; j >= 0; j--) {
    const l = cleaned[j]!;
    const trailing = /^(.*"\s*)\s*,\s*$/.exec(l);
    if (trailing) {
      cleaned[j] = trailing[1] ?? l;
      break;
    } else if (/"\s*$/.test(l)) {
      break;
    }
  }

  const eol = pjText.includes('\r\n') ? '\r\n' : '\n';
  const newBody = cleaned.length === 0 ? '' : `${eol}${cleaned.join(eol)}${eol}  `;

  let newPj = pjText.slice(0, bodyStart) + newBody + pjText.slice(end);

  if (cleaned.length === 0) {
    newPj = newPj.replace(/,?\s*"overrides"\s*:\s*\{\s*\}\s*,?/s, '');
    newPj = newPj.replace(/,?\s*"pnpm"\s*:\s*\{\s*\}\s*,?/s, '');
    newPj = newPj.replace(/,(\s*,)+/g, ',');
    newPj = newPj.replace(/\{\s*,/g, '{');
    newPj = newPj.replace(/,\s*\}/g, ' }');
  }

  if (!state.dryRun) {
    fs.writeFileSync(state.rootPackageJson, newPj, 'utf8');
  }
  return newYaml;
}

function majorBumpAnnotation(prior: string | undefined, next: string): string {
  if (!prior) return '';
  try {
    const a = semver.coerce(prior)?.version;
    const b = semver.coerce(next)?.version;
    if (a && b && semver.major(b) > semver.major(a)) return ' (MAJOR)';
  } catch {
    // ignore
  }
  return '';
}

function warnOnMajorPromotions(
  updates: ReadonlyMap<string, string>,
  priorVersions: ReadonlyMap<string, string>,
  logger: Logger,
): void {
  for (const [k, v] of updates) {
    const prior = priorVersions.get(k);
    if (!prior) continue;
    const a = semver.coerce(prior)?.version;
    const b = semver.coerce(v)?.version;
    if (a && b && semver.major(b) > semver.major(a)) {
      logger.warn(`Major bump promoted for ${k}: ${prior} -> ${v}; review for breaking changes.`);
    }
  }
}
