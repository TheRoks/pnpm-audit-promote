import * as fs from 'node:fs';
import semver from 'semver';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner } from '../pnpm';
import {
  resolveWorkspacePackageDirs,
  type WorkspacePackageScopeSource,
} from '../workspace/packageScope';
import {
  findPackageManifest,
  findWorkspacePackageManifests,
  formatForPath,
  readPackageManifest,
  setManifestProperty,
} from '../workspace/packageManifest';
import type { WorkspaceConfiguration } from '../workspace/configuration';
import { selectSafeBump, type BumpTier, normalizeRange } from '../semverUtil';
import type { WorkspaceMutations } from '../workspace/mutations';
import { advisoryAppliesToCurrent, advisoryMatchesIgnoreList } from './parseAdvisories';
import { parsePnpmAuditOutput, type PnpmAuditParseResult, type PnpmAuditOutput } from './pnpmAudit';
import { getAvailableVersions } from './registry';
export type { PnpmAuditAdvisory, PnpmAuditOutput } from './pnpmAudit';

interface PackageJsonBumpWorkspace extends WorkspacePackageScopeSource {
  isMultiPackageWorkspace: boolean;
  configuration?: Pick<WorkspaceConfiguration, 'readWorkspaceYaml'>;
}

/** Dep field types that can hold concrete package versions. */
export type DepType =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';
const DEP_TYPES: DepType[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Parsed result of a version field — prefix (`^`/`~`/``) + bare semver. */
export interface ParsedVersion {
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
  /** Raw pre-fetched audit output for callers that have not parsed it. */
  auditJsonStdout?: string;
  /** Parsed result for an audit command already consumed by the caller. */
  auditSnapshot?: PnpmAuditParseResult;
  /**
   * Set of GHSA or CVE identifiers to ignore. Advisories matching any ID in
   * this set are excluded from bump decisions.
   */
  ignoredAdvisoryIds?: ReadonlySet<string>;
  /**
   * Minimum severity threshold for ranged-dep (`^`/`~`) bumps. Defaults to
   * `'high'`. Exact-pinned deps are always bumped regardless of severity.
   * Valid values (ascending): `info`, `low`, `moderate`, `high`, `critical`.
   */
  minSeverity?: string;
}

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'] as const;
type AuditSeverity = (typeof SEVERITY_ORDER)[number];

function meetsSeverityThreshold(severity: string, minSeverity: string): boolean {
  const idx = SEVERITY_ORDER.indexOf(severity.toLowerCase() as AuditSeverity);
  const minIdx = SEVERITY_ORDER.indexOf(minSeverity.toLowerCase() as AuditSeverity);
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

export interface DirectDependencyLocation {
  pkgJsonPath: string;
  depType: DepType;
  versionField: string;
  parsed: ParsedVersion;
}

export interface PackageJsonBumpDiagnostic {
  level: 'detail' | 'warn';
  message: string;
}

export interface PackageJsonBumpPlan {
  bumps: PackageJsonDepBump[];
  diagnostics: PackageJsonBumpDiagnostic[];
}

/** Pure package.json bump policy over audit, manifest, and registry snapshots. */
export function planPackageJsonBumps(input: {
  audit: PnpmAuditOutput;
  dependencies: ReadonlyMap<string, readonly DirectDependencyLocation[]>;
  availableVersions: ReadonlyMap<string, readonly string[]>;
  allowMajor?: boolean;
  ignoredAdvisoryIds?: ReadonlySet<string>;
  minSeverity?: string;
}): PackageJsonBumpPlan {
  const allowMajor = input.allowMajor ?? true;
  const diagnostics: PackageJsonBumpDiagnostic[] = [];
  const detail = (message: string): void => {
    diagnostics.push({ level: 'detail', message });
  };
  const warn = (message: string): void => {
    diagnostics.push({ level: 'warn', message });
  };
  const bumps: PackageJsonDepBump[] = [];

  for (const advisory of Object.values(input.audit.advisories ?? {})) {
    const module = advisory.module_name ?? '';
    const locations = input.dependencies.get(module);
    if (!locations) continue;

    const patchedRange = advisory.patched_versions ?? '';
    if (!patchedRange || !normalizeRange(patchedRange)) continue;
    if (input.ignoredAdvisoryIds && advisoryMatchesIgnoreList(advisory, input.ignoredAdvisoryIds)) {
      detail(`Skipped ignored advisory for ${module}.`);
      continue;
    }

    const available = input.availableVersions.get(module) ?? [];
    for (const location of locations) {
      const parsed = location.parsed;
      if (parsed.prefix !== '') {
        const severity = (advisory.severity ?? '').toLowerCase();
        const effectiveMin = input.minSeverity ?? 'high';
        if (!meetsSeverityThreshold(severity, effectiveMin)) {
          detail(
            `Skipped ranged dep ${module} in ${location.pkgJsonPath}: severity "${severity || 'unknown'}" is below ${effectiveMin} threshold.`,
          );
          continue;
        }
      }

      if (!advisoryAppliesToCurrent(parsed.bare, advisory.vulnerable_versions)) {
        detail(
          `Skipped advisory for ${module} in ${location.pkgJsonPath}: version ${parsed.bare} is outside vulnerable range ${advisory.vulnerable_versions ?? '?'}.`,
        );
        continue;
      }

      const safe = selectSafeBump(parsed.bare, patchedRange, available);
      if (!safe) {
        warn(
          `No non-vulnerable version >= ${parsed.bare} found for ${module} in ${location.pkgJsonPath} (range: ${patchedRange}).`,
        );
        continue;
      }
      if (safe.tier === 'major' && !allowMajor) {
        warn(
          `Skipped ${module} in ${location.pkgJsonPath}: only a MAJOR bump (${parsed.bare} -> ${safe.version}) satisfies the advisory and --no-allow-major is set.`,
        );
        continue;
      }
      if (safe.tier === 'major') {
        warn(
          `Major version bump required for ${module} in ${location.pkgJsonPath}: ${parsed.bare} -> ${safe.version}. Review changelog for breaking changes.`,
        );
      }

      bumps.push({
        pkgJsonPath: location.pkgJsonPath,
        depType: location.depType,
        name: module,
        before: location.versionField,
        after: `${parsed.prefix}${safe.version}`,
        tier: safe.tier,
      });
    }
  }

  const deduped = new Map<string, PackageJsonDepBump>();
  for (const bump of bumps) {
    const key = `${bump.pkgJsonPath}\0${bump.depType}\0${bump.name}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, bump);
      continue;
    }
    const newVersion = semver.coerce(bump.after)?.version ?? '0.0.0';
    const oldVersion = semver.coerce(existing.after)?.version ?? '0.0.0';
    if (semver.gt(newVersion, oldVersion)) deduped.set(key, bump);
  }
  return { bumps: [...deduped.values()], diagnostics };
}

/** Read manifests and registry metadata, run policy, and report its decisions. */
export async function getDirectDepPackageJsonBumps(
  workspace: PackageJsonBumpWorkspace,
  pnpm: PnpmCaptureRunner,
  logger: Logger,
  options: DirectDepPkgJsonBumpOptions = {},
): Promise<PackageJsonDepBump[]> {
  let snapshot = options.auditSnapshot;
  if (!snapshot) {
    const stdout = options.auditJsonStdout ?? (await pnpm.capture(['audit', '--json'])).stdout;
    snapshot = parsePnpmAuditOutput(stdout);
  }
  if (!snapshot.complete) {
    if (snapshot.reason === 'invalid-json') {
      logger.warn('Could not parse audit JSON. Skipping package.json direct-dep bump.');
    }
    return [];
  }
  const audit: PnpmAuditOutput = snapshot.audit;

  const dependencies = buildDepIndex(collectPackageJsonPaths(workspace));
  if (dependencies.size === 0) return [];
  const affectedModules = [
    ...new Set(
      Object.values(audit.advisories)
        .map((advisory) => advisory.module_name ?? '')
        .filter((name) => dependencies.has(name)),
    ),
  ];
  const versionCache = new Map<string, string[]>();
  await Promise.all(affectedModules.map((name) => getAvailableVersions(pnpm, name, versionCache)));

  const plan = planPackageJsonBumps({
    audit,
    dependencies,
    availableVersions: versionCache,
    allowMajor: options.allowMajor,
    ignoredAdvisoryIds: options.ignoredAdvisoryIds,
    minSeverity: options.minSeverity,
  });
  for (const diagnostic of plan.diagnostics) {
    logger[diagnostic.level](diagnostic.message);
  }
  return plan.bumps;
}

/**
 * Apply a list of package.json dep bumps to the filesystem. Groups edits by
 * file and applies them all in one read-modify-write pass. No-ops when
 * `dryRun` is true.
 */
export function applyPackageJsonDepBumps(
  bumps: PackageJsonDepBump[],
  mutations: WorkspaceMutations,
): void {
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
      text = setManifestProperty(
        text,
        formatForPath(pkgJsonPath),
        bump.after,
        bump.depType,
        bump.name,
      );
    }
    mutations.writeTextFile(pkgJsonPath, text);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectPackageJsonPaths(workspace: PackageJsonBumpWorkspace): string[] {
  if (!workspace.isMultiPackageWorkspace) {
    // Single-package mode: confine the audit-driven scan to the workspace
    // root. `WorkspaceState.initialize` guarantees the root package.json
    // exists when we get here.
    const manifest = findPackageManifest(workspace.paths.workspaceRoot);
    return manifest ? [manifest.path] : [];
  }
  const packageDirs = resolveWorkspacePackageDirs({
    paths: workspace.paths,
    yaml: workspace.configuration ?? workspace.yaml,
  });
  return findWorkspacePackageManifests(workspace.paths.workspaceRoot, packageDirs).map(
    (manifest) => manifest.path,
  );
}

function buildDepIndex(pkgJsonPaths: string[]): Map<string, DirectDependencyLocation[]> {
  const index = new Map<string, DirectDependencyLocation[]>();

  for (const pkgJsonPath of pkgJsonPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(pkgJsonPath, 'utf8');
    } catch {
      continue;
    }
    let pkg: Record<string, unknown>;
    try {
      pkg = readPackageManifest(raw, formatForPath(pkgJsonPath)) as Record<string, unknown>;
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

        const loc: DirectDependencyLocation = { pkgJsonPath, depType, versionField, parsed };
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
