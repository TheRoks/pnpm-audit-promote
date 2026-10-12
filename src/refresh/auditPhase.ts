import * as path from 'node:path';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { readAuditIgnoreList, readAuditLevel } from '../workspace/pnpmConfig';
import type { PnpmCaptureRunner, PnpmCommandRunner } from '../pnpm';
import type { createProgressLogger } from '../progress';
import { getDirectDepCatalogBumps } from '../audit/parseAdvisories';
import { parsePnpmAuditOutput, type PnpmAuditParseResult } from '../audit/pnpmAudit';
import {
  applyPackageJsonDepBumps,
  getDirectDepPackageJsonBumps,
} from '../audit/bumpPackageJsonDeps';
import {
  guardWorkspaceOverrideAvailability,
  syncAuditOverridesIntoCatalog,
} from '../audit/promoteWorkspaceOverrides';
import { syncPackageJsonOverridesIntoCatalog } from '../audit/promotePackageJsonOverrides';
import { guardWorkspaceOverrideReleaseAge, type BlockedOverride } from '../audit/releaseAge';
import type { PackageJsonDepChange, ReleaseAgeBlockedOverride } from '../summary/types';
import { migrateYamlOverridesToPackageJson } from '../audit/ignoreWorkspaceMigration';
import { applyCatalogUpdates } from '../catalog';
import { INSTALL_ARGS, reconcileAfterAuditRead, runAndRestore } from './commands';
import { runInstallAndDedupe } from './install';
import type { AuditFixMode } from './types';

type AuditPhasePnpm = PnpmCommandRunner & PnpmCaptureRunner;

export async function runAuditPhase(
  state: WorkspaceState,
  pnpm: AuditPhasePnpm,
  logger: Logger,
  progressLogger: ReturnType<typeof createProgressLogger>,
  opts: {
    skipDedupe: boolean;
    allowMajor: boolean;
    releaseAgeCheck: boolean;
    dryRun: boolean;
    preCleanupAudit: PnpmAuditParseResult | null;
    baselineSafeVersions: ReadonlyMap<string, string>;
    originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
    ignoreWorkspace: boolean;
    auditFixMode: AuditFixMode;
  },
): Promise<{
  pkgJsonDepChanges: PackageJsonDepChange[];
  releaseAgeBlockedOverrides: ReleaseAgeBlockedOverride[];
}> {
  // Capture a post-cleanup audit JSON and share it with the pre-audit
  // catalog bump (which needs the unmasked vulnerability set to decide
  // which direct deps to bump). This is *separate* from the initial
  // audit captured before cleanup for the summary.
  let postCleanupAudit = parsePnpmAuditOutput('');
  if (!opts.dryRun) {
    const { stdout } = await pnpm.capture(['audit', '--json']);
    postCleanupAudit = parsePnpmAuditOutput(stdout);
    reconcileAfterAuditRead(state, logger);
  }

  const pkgJsonDepChanges = await preAuditCatalogBump(
    state,
    pnpm,
    progressLogger,
    opts.allowMajor,
    postCleanupAudit,
    opts.preCleanupAudit,
  );
  const blockedOverrides = await auditFix(state, pnpm, progressLogger, {
    releaseAgeCheck: opts.releaseAgeCheck,
    mode: opts.auditFixMode,
    baselineSafeVersions: opts.baselineSafeVersions,
    originalOverrides: opts.originalOverrides,
  });

  // Under `--ignore-workspace`, pnpm deliberately ignores pnpm-workspace.yaml,
  // including any overrides `pnpm audit --fix` just wrote into it. Migrate
  // those overrides into the root package.json's `pnpm.overrides` so the
  // subsequent install actually applies them (and the final audit sees them).
  if (opts.ignoreWorkspace) {
    migrateYamlOverridesToPackageJson(
      { rootPackageJson: state.rootPackageJson, yaml: state.yaml },
      progressLogger,
    );
  }

  await runInstallAndDedupe(pnpm, state, logger, progressLogger, {
    skipDedupe: opts.skipDedupe,
    installLabel: 'Reinstall dependencies (post-audit reconciliation)',
  });

  return {
    pkgJsonDepChanges,
    releaseAgeBlockedOverrides: blockedOverrides.map((blocked) => ({
      selector: blocked.key,
      name: blocked.name,
      value: blocked.value,
      minimumReleaseAgeMinutes: blocked.minimumReleaseAgeMinutes,
    })),
  };
}
async function preAuditCatalogBump(
  state: WorkspaceState,
  pnpm: AuditPhasePnpm,
  logger: Logger,
  allowMajor: boolean,
  postCleanupAudit: PnpmAuditParseResult,
  preCleanupAudit: PnpmAuditParseResult | null,
): Promise<PackageJsonDepChange[]> {
  logger.step('Scan direct dependencies for vulnerable catalog entries');

  const auditConfigVersion =
    state.pnpmVersion ?? (state.pnpmMajor === null ? null : `${state.pnpmMajor}.0.0`);
  const ignoredAdvisoryIds = readAuditIgnoreList(
    state.yaml.desiredWorkspaceYaml,
    auditConfigVersion,
  );
  const minSeverity =
    readAuditLevel(state.yaml.desiredWorkspaceYaml, auditConfigVersion) ?? undefined;

  const { bumps, tiers } = await getDirectDepCatalogBumps(
    state.yaml.desiredWorkspaceYaml,
    pnpm,
    logger,
    {
      allowMajor,
      auditSnapshot: postCleanupAudit,
      ignoredAdvisoryIds: ignoredAdvisoryIds.size > 0 ? ignoredAdvisoryIds : undefined,
    },
  );
  // For package.json ranged deps (^/~), the post-cleanup install may resolve
  // to a safe-in-range version that makes the advisory disappear from the
  // post-install audit. Use the pre-cleanup audit (locked minimums) as the
  // primary source so we still raise the declared floor. Fall back to the
  // post-cleanup data when there was no pre-existing lock file.
  const pkgJsonAudit = preCleanupAudit?.complete ? preCleanupAudit : postCleanupAudit;
  const pkgJsonBumps = await getDirectDepPackageJsonBumps(state, pnpm, logger, {
    allowMajor,
    auditSnapshot: pkgJsonAudit,
    ignoredAdvisoryIds: ignoredAdvisoryIds.size > 0 ? ignoredAdvisoryIds : undefined,
    minSeverity,
  });

  logger.step('Reinstall dependencies after catalog updates');
  if (bumps.size === 0 && pkgJsonBumps.length === 0) {
    logger.detail('No vulnerable direct dependencies detected (catalog or package.json).');
    logger.detail('Skipped reinstall: no catalog updates were required.');
    return [];
  }

  if (bumps.size > 0) {
    logger.detail('Applying catalog updates for vulnerable direct dependencies:');
    for (const [k, v] of bumps) {
      const annotation = tiers.get(k) === 'major' ? ' (MAJOR)' : '';
      logger.bullet(`${k} -> ${v}${annotation}`);
    }
    state.yaml.writeDesiredWorkspaceYaml(
      applyCatalogUpdates(state.yaml.desiredWorkspaceYaml, bumps),
    );
  }

  if (pkgJsonBumps.length > 0) {
    logger.detail('Applying package.json updates for vulnerable direct dependencies:');
    for (const bump of pkgJsonBumps) {
      const rel = path.relative(state.workspaceRoot, bump.pkgJsonPath);
      const annotation = bump.tier === 'major' ? ' (MAJOR)' : '';
      logger.bullet(`${bump.name} (${rel}): ${bump.before} -> ${bump.after}${annotation}`);
    }
    applyPackageJsonDepBumps(pkgJsonBumps, state.yaml.dryRun);
  }

  await runAndRestore(pnpm, state, logger, [...INSTALL_ARGS]);

  // Convert PackageJsonDepBump[] → PackageJsonDepChange[] for the summary.
  return pkgJsonBumps.map((b) => ({
    pkgJsonPath: b.pkgJsonPath,
    name: b.name,
    before: b.before,
    after: b.after,
    bump: b.tier,
  }));
}
async function auditFix(
  state: WorkspaceState,
  pnpm: AuditPhasePnpm,
  logger: Logger,
  options: {
    releaseAgeCheck: boolean;
    mode: AuditFixMode;
    baselineSafeVersions: ReadonlyMap<string, string>;
    originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  },
): Promise<BlockedOverride[]> {
  logger.step('Apply pnpm audit fixes');
  // pnpm 11/12 require `--fix` to include an explicit value (`override` or `update`)
  // and rejects the bare flag with ERR_PNPM_INVALID_FIX_OPTION. We always
  // want override-based fixes because the whole point of this tool is to
  // promote those overrides into the catalog (`--fix=update` patches the
  // lockfile directly and bypasses that pipeline). pnpm 10 still accepts
  // the bare `--fix`, so it stays the default for older / unknown majors.
  const auditArgs =
    (state.pnpmMajor ?? 0) >= 11 ? ['audit', '--fix', options.mode] : ['audit', '--fix'];
  // pnpm audit returns non-zero when vulnerabilities remain; don't fail.
  const code = await pnpm.runAllowFail(auditArgs);
  logger.detail(`pnpm ${auditArgs.join(' ')} completed with exit code ${code}.`);

  // pnpm 11/12's `audit --fix override` writes its overrides into
  // pnpm-workspace.yaml even when the workspace started without one
  // (notably under `--ignore-workspace`). Re-detect the file before the
  // sync/collapse passes so the new content is not silently ignored.
  if (state.yaml.refreshHasWorkspaceYaml()) {
    logger.detail('Detected pnpm-workspace.yaml created by `pnpm audit --fix`.');
  }
  state.yaml.preserveAuditIgnorePrune(state.pnpmMajor, logger);

  // pnpm 11/12's `audit --fix` appends the patched version of every fixed
  // advisory to the top-level `minimumReleaseAgeExclude` block. The tool must
  // never expand that list (REQ-PNPM11-011): reset it to the user's original
  // on disk *before* the override-promotion pass below reads (and would
  // otherwise re-serialise) the file, so the user's exclude list is preserved
  // verbatim.
  state.yaml.resetMinimumReleaseAgeExclude(logger);

  await guardWorkspaceOverrideAvailability(
    state.yaml,
    pnpm,
    logger,
    options.baselineSafeVersions,
    options.originalOverrides,
  );

  // REQ-PNPM11-012: validate release age after availability reconciliation,
  // which may raise an audit override's floor. Checking before that adjustment
  // could accept an old version from the original range, then leave only fresh
  // versions for the post-audit install to resolve.
  const blockedOverrides =
    options.mode === 'override' && options.releaseAgeCheck
      ? await guardWorkspaceOverrideReleaseAge(state.yaml, pnpm, logger)
      : [];

  // Safety net: promote any catalog-eligible overrides into the catalog.
  syncAuditOverridesIntoCatalog(state.yaml, logger);
  syncPackageJsonOverridesIntoCatalog(
    { rootPackageJson: state.rootPackageJson, yaml: state.yaml },
    state.yaml.desiredWorkspaceYaml,
    logger,
  );
  return blockedOverrides;
}
