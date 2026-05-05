import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import type { PnpmRunner } from '../pnpm';
import { resolveWorkspacePackageDirs } from '../workspace';
import { findWorkspaceFiles } from '../fsWalk';
import { setJsonProperty } from '../jsonEdit';
import { selectSafeBump, type BumpTier, normalizeRange } from '../semverUtil';
import { advisoryAppliesToCurrent, getAvailableVersions } from './parseAdvisories';

/** Dep field types that can hold concrete package versions. */
type DepType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
const DEP_TYPES: DepType[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Parsed result of a version field — prefix (`^`/`~`/``) + bare semver. */
interface ParsedVersion {
  prefix: '' | '^' | '~';
  bare: string;
}

/**
 * Extract a version prefix (`^`, `~`, or empty) and the bare semver from a
 * package.json version field. Returns `null` for anything that is not a plain
 * concrete version with an optional single-character range prefix (`^`/`~`).
 * Specifically skips `catalog:`, `workspace:`, `file:`, `link:`, git URLs,
 * and complex range expressions (`>=`, `<=`, ` `, `||`, `*`, `x`).
 */
export function extractVersionPrefix(
  versionField: string | undefined | null,
): ParsedVersion | null {
  if (!versionField || !versionField.trim()) return null;
  const v = versionField.trim();
  // Reject anything that looks like a non-range specifier protocol or complex range.
  if (/^(catalog:|workspace:|file:|link:|git\+|https?:|github:|bitbucket:|gitlab:)/i.test(v))
    return null;
  if (/[\s*x|><=]/.test(v)) return null;

  const prefix = v[0] === '^' || v[0] === '~' ? (v[0] as '^' | '~') : '';
  const bare = prefix ? v.slice(1) : v;

  // Must be a valid concrete semver (not a range).
  if (!semver.valid(semver.coerce(bare)) || semver.validRange(bare) !== bare) return null;
  // Reject if it's a range-only expression (e.g. "1.x.0" coerces but isn't concrete).
  const coerced = semver.coerce(bare);
  if (!coerced) return null;
  // Ensure the bare string really is the exact coerced version (no wildcards slipped through).
  if (coerced.version !== bare && !bare.match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/))
    return null;

  return { prefix, bare };
}

export interface PackageJsonDepBump {
  /** Absolute path to the package.json file. */
  pkgJsonPath: string;
  depType: DepType;
  name: string;
  before: string;
  after: string;
  tier: BumpTier;
}

export interface DirectDepPkgJsonBumpOptions {
  /** When false, packages requiring a major bump are skipped. Defaults to true. */
  allowMajor?: boolean;
  /** Pre-fetched `pnpm audit --json` stdout. Avoids a second audit call. */
  auditJsonStdout?: string;
}

interface PnpmAuditAdvisory {
  module_name?: string;
  patched_versions?: string;
  vulnerable_versions?: string;
  severity?: string;
}
interface PnpmAuditOutput {
  advisories?: Record<string, PnpmAuditAdvisory>;
}

/**
 * Compute version bumps for direct dependencies declared in workspace
 * `package.json` files that are **not** managed by the pnpm catalog but have
 * a known vulnerability from `pnpm audit --json`.
 *
 * - Skips version fields that use `catalog:`, `workspace:`, `file:`, complex
 *   range expressions, or any protocol URL — only `x.y.z`, `^x.y.z`, and
 *   `~x.y.z` are eligible.
 * - Preserves the original tilde/caret prefix in the emitted `after` value.
 * - Respects `allowMajor`: logs a warning and skips when `false`.
 * - Ranged deps (`^`/`~`) are only bumped when the advisory severity is
 *   `high` or `critical`. Exact-pinned deps are bumped for any severity.
 */
export async function getDirectDepPackageJsonBumps(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  options: DirectDepPkgJsonBumpOptions = {},
): Promise<PackageJsonDepBump[]> {
  const allowMajor = options.allowMajor ?? true;
  const stdout = options.auditJsonStdout ?? (await pnpm.capture(['audit', '--json'])).stdout;

  if (!stdout.trim()) return [];

  let audit: PnpmAuditOutput;
  try {
    audit = JSON.parse(stdout) as PnpmAuditOutput;
  } catch {
    logger.warn('Could not parse audit JSON. Skipping package.json direct-dep bump.');
    return [];
  }
  if (!audit.advisories) return [];

  // Collect all workspace package.json paths.
  const pkgJsonPaths = collectPackageJsonPaths(state);

  // Build lookup: module name → list of locations where it appears as a direct dep.
  const depIndex = buildDepIndex(pkgJsonPaths);

  if (depIndex.size === 0) return [];

  // Pre-fetch versions for affected modules in parallel.
  const affectedModules = [
    ...new Set(
      Object.values(audit.advisories)
        .map((adv) => adv.module_name ?? '')
        .filter((m) => depIndex.has(m)),
    ),
  ];
  const versionCache = new Map<string, string[]>();
  await Promise.all(affectedModules.map((m) => getAvailableVersions(pnpm, m, versionCache)));

  const bumps: PackageJsonDepBump[] = [];

  for (const adv of Object.values(audit.advisories)) {
    const module = adv.module_name ?? '';
    const locations = depIndex.get(module);
    if (!locations) continue;

    const patchedRange = adv.patched_versions ?? '';
    if (!patchedRange || !normalizeRange(patchedRange)) continue;

    const available = await getAvailableVersions(pnpm, module, versionCache);

    for (const loc of locations) {
      const parsed = loc.parsed;

      if (parsed.prefix !== '') {
        const sev = (adv.severity ?? '').toLowerCase();
        if (sev !== 'high' && sev !== 'critical') {
          logger.detail(
            `Skipped ranged dep ${module} in ${loc.pkgJsonPath}: severity "${sev || 'unknown'}" is below high/critical threshold.`,
          );
          continue;
        }
      }

      if (!advisoryAppliesToCurrent(parsed.bare, adv.vulnerable_versions)) {
        logger.detail(
          `Skipped advisory for ${module} in ${loc.pkgJsonPath}: version ${parsed.bare} is outside vulnerable range ${adv.vulnerable_versions ?? '?'}.`,
        );
        continue;
      }

      const safe = selectSafeBump(parsed.bare, patchedRange, available);
      if (!safe) {
        logger.warn(
          `No non-vulnerable version >= ${parsed.bare} found for ${module} in ${loc.pkgJsonPath} (range: ${patchedRange}).`,
        );
        continue;
      }

      if (safe.tier === 'major' && !allowMajor) {
        logger.warn(
          `Skipped ${module} in ${loc.pkgJsonPath}: only a MAJOR bump (${parsed.bare} -> ${safe.version}) satisfies the advisory and --no-allow-major is set.`,
        );
        continue;
      }
      if (safe.tier === 'major') {
        logger.warn(
          `Major version bump required for ${module} in ${loc.pkgJsonPath}: ${parsed.bare} -> ${safe.version}. Review changelog for breaking changes.`,
        );
      }

      bumps.push({
        pkgJsonPath: loc.pkgJsonPath,
        depType: loc.depType,
        name: module,
        before: loc.versionField,
        after: `${parsed.prefix}${safe.version}`,
        tier: safe.tier,
      });
    }
  }

  // Deduplicate: multiple advisories can affect the same dep in the same file.
  // Keep only the bump to the highest safe version per (pkgJsonPath, depType, name).
  const deduped = new Map<string, PackageJsonDepBump>();
  for (const bump of bumps) {
    const key = `${bump.pkgJsonPath}\0${bump.depType}\0${bump.name}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, bump);
    } else {
      const newV = semver.coerce(bump.after)?.version ?? '0.0.0';
      const oldV = semver.coerce(existing.after)?.version ?? '0.0.0';
      if (semver.gt(newV, oldV)) deduped.set(key, bump);
    }
  }
  return [...deduped.values()];
}

/**
 * Apply a list of package.json dep bumps to the filesystem. Groups edits by
 * file and applies them all in one read-modify-write pass. No-ops when
 * `dryRun` is true.
 */
export function applyPackageJsonDepBumps(bumps: PackageJsonDepBump[], dryRun: boolean): void {
  // Group by file.
  const byFile = new Map<string, PackageJsonDepBump[]>();
  for (const bump of bumps) {
    const existing = byFile.get(bump.pkgJsonPath);
    if (existing) {
      existing.push(bump);
    } else {
      byFile.set(bump.pkgJsonPath, [bump]);
    }
  }

  for (const [pkgJsonPath, fileBumps] of byFile) {
    let text: string;
    try {
      text = fs.readFileSync(pkgJsonPath, 'utf8');
    } catch {
      continue;
    }
    for (const bump of fileBumps) {
      text = setJsonProperty(text, bump.after, bump.depType, bump.name);
    }
    if (!dryRun) {
      fs.writeFileSync(pkgJsonPath, text, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DepLocation {
  pkgJsonPath: string;
  depType: DepType;
  versionField: string;
  parsed: ParsedVersion;
}

function collectPackageJsonPaths(state: WorkspaceState): string[] {
  const packageDirs = resolveWorkspacePackageDirs(state);
  return findWorkspaceFiles(state.workspaceRoot, 'package.json').filter(
    (pjPath) => packageDirs === null || packageDirs.has(path.dirname(pjPath)),
  );
}

function buildDepIndex(pkgJsonPaths: string[]): Map<string, DepLocation[]> {
  const index = new Map<string, DepLocation[]>();

  for (const pkgJsonPath of pkgJsonPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(pkgJsonPath, 'utf8');
    } catch {
      continue;
    }
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const depType of DEP_TYPES) {
      const deps = pkg[depType];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, versionField] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof versionField !== 'string') continue;
        // `extractVersionPrefix` returns null for `catalog:`, `workspace:`,
        // and any other non-concrete specifier, so those are automatically
        // excluded without needing an explicit catalog-name guard.
        const parsed = extractVersionPrefix(versionField);
        if (!parsed) continue;

        const loc: DepLocation = { pkgJsonPath, depType, versionField, parsed };
        const existing = index.get(name);
        if (existing) {
          existing.push(loc);
        } else {
          index.set(name, [loc]);
        }
      }
    }
  }

  return index;
}
