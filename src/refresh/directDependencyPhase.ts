import * as path from 'node:path';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner, PnpmCommandRunner } from '../pnpm';
import {
  applyPackageJsonDepBumps,
  getDirectDepPackageJsonBumps,
} from '../audit/bumpPackageJsonDeps';
import { getDirectDepCatalogBumps } from '../audit/parseAdvisories';
import type { PnpmAuditParseResult } from '../audit/pnpmAudit';
import type { WorkspaceState } from '../workspace';
import { readAuditIgnoreList, readAuditLevel } from '../workspace/pnpmConfig';
import type { PackageJsonDepChange } from '../summary/types';
import { INSTALL_ARGS, runAndRestore } from './commands';

type AuditPhasePnpm = PnpmCommandRunner & PnpmCaptureRunner;

/** Plan direct-dependency fixes, apply them, then reinstall the changed graph. */
export async function runDirectDependencyPhase(
  state: WorkspaceState,
  pnpm: AuditPhasePnpm,
  logger: Logger,
  options: {
    allowMajor: boolean;
    postCleanupAudit: PnpmAuditParseResult;
    preCleanupAudit: PnpmAuditParseResult | null;
  },
): Promise<PackageJsonDepChange[]> {
  logger.step('Scan direct dependencies for vulnerable catalog entries');
  const workspaceConfig = state.configuration.readEffectiveYaml();

  const ignoredAdvisoryIds = readAuditIgnoreList(workspaceConfig, state.pnpmCapabilities);
  const minSeverity = readAuditLevel(workspaceConfig, state.pnpmCapabilities) ?? undefined;

  const { bumps, tiers } = await getDirectDepCatalogBumps(workspaceConfig, pnpm, logger, {
    allowMajor: options.allowMajor,
    auditSnapshot: options.postCleanupAudit,
    ignoredAdvisoryIds: ignoredAdvisoryIds.size > 0 ? ignoredAdvisoryIds : undefined,
  });
  // A fresh install may resolve a ranged package to a safe version and hide
  // the original vulnerability. Use the pre-cleanup lock snapshot for those
  // manifest floor decisions when it was available.
  const pkgJsonAudit = options.preCleanupAudit?.complete
    ? options.preCleanupAudit
    : options.postCleanupAudit;
  const pkgJsonBumps = await getDirectDepPackageJsonBumps(state, pnpm, logger, {
    allowMajor: options.allowMajor,
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
    for (const [name, version] of bumps) {
      const annotation = tiers.get(name) === 'major' ? ' (MAJOR)' : '';
      logger.bullet(`${name} -> ${version}${annotation}`);
    }
    state.configuration.updateCatalogs(bumps);
  }

  if (pkgJsonBumps.length > 0) {
    logger.detail('Applying package manifest updates for vulnerable direct dependencies:');
    for (const bump of pkgJsonBumps) {
      const relativePath = path.relative(state.paths.workspaceRoot, bump.pkgJsonPath);
      const annotation = bump.tier === 'major' ? ' (MAJOR)' : '';
      logger.bullet(`${bump.name} (${relativePath}): ${bump.before} -> ${bump.after}${annotation}`);
    }
    applyPackageJsonDepBumps(pkgJsonBumps, state.mutations);
  }

  await runAndRestore(pnpm, state, logger, [...INSTALL_ARGS]);

  return pkgJsonBumps.map((bump) => ({
    pkgJsonPath: bump.pkgJsonPath,
    name: bump.name,
    before: bump.before,
    after: bump.after,
    bump: bump.tier,
  }));
}
