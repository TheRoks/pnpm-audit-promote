import type { Logger } from '../logger';
import type { PnpmCaptureRunner, PnpmCommandRunner } from '../pnpm';
import { getAuditFixArgs } from '../pnpmCapabilities';
import type { WorkspaceState } from '../workspace';
import {
  guardWorkspaceOverrideAvailability,
  syncAuditOverridesIntoCatalog,
} from '../audit/promoteWorkspaceOverrides';
import { syncPackageJsonOverridesIntoCatalog } from '../audit/promotePackageJsonOverrides';
import { guardWorkspaceOverrideReleaseAge, type BlockedOverride } from '../audit/releaseAge';
import type { AuditFixMode } from './types';

type AuditPhasePnpm = PnpmCommandRunner & PnpmCaptureRunner;

/** Run pnpm's fix command, validate its overrides, then promote eligible fixes. */
export async function runAuditFixPhase(
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
  const auditArgs = getAuditFixArgs(state.pnpmCapabilities, options.mode);
  const code = await pnpm.runAllowFail(auditArgs);
  logger.detail(`pnpm ${auditArgs.join(' ')} completed with exit code ${code}.`);

  // pnpm 11/12 can create the root workspace file or update an included owner.
  state.configuration.refreshRootWorkspaceYaml(logger, '`pnpm audit --fix`');
  const yamlSnapshots = state.configuration.getSnapshots();
  for (const snapshot of yamlSnapshots) {
    snapshot.preserveAuditIgnorePrune(state.pnpmCapabilities, logger);
    snapshot.resetMinimumReleaseAgeExclude(logger);
  }
  const effectiveYaml = state.configuration.readEffectiveYaml();
  const catalog = state.configuration.readCatalog();
  const overrideYaml = state.configuration.getOwnerSnapshot('overrides');

  if (overrideYaml) {
    await guardWorkspaceOverrideAvailability(
      overrideYaml,
      pnpm,
      logger,
      options.baselineSafeVersions,
      options.originalOverrides,
      catalog,
    );
  }

  // Release-age validation follows availability reconciliation because that
  // step may raise the minimum version selected by an override.
  const blockedOverrides =
    options.mode === 'override' && options.releaseAgeCheck && overrideYaml
      ? await guardWorkspaceOverrideReleaseAge(overrideYaml, pnpm, logger, {
          policyYaml: effectiveYaml,
        })
      : [];

  if (overrideYaml) {
    syncAuditOverridesIntoCatalog(overrideYaml, logger, {
      catalog,
      reportYaml: effectiveYaml,
      updateCatalogs: (updates) => state.configuration.updateCatalogs(updates),
    });
  }
  if (state.paths.rootPackageManifest) {
    syncPackageJsonOverridesIntoCatalog(
      {
        rootPackageJson: state.paths.rootPackageManifest,
        yaml: state.yaml,
        updateCatalogs: (updates) => state.configuration.updateCatalogs(updates),
      },
      state.configuration.readEffectiveYaml(),
      logger,
    );
  }
  return blockedOverrides;
}
