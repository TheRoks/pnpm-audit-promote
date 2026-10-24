import type { Logger } from '../logger';
import type { PnpmCaptureRunner, PnpmCommandRunner } from '../pnpm';
import type { createProgressLogger } from '../progress';
import type { PackageJsonDepChange, ReleaseAgeBlockedOverride } from '../summary/types';
import type { WorkspaceState } from '../workspace';
import { parsePnpmAuditOutput, type PnpmAuditParseResult } from '../audit/pnpmAudit';
import { migrateYamlOverridesToPackageJson } from '../audit/ignoreWorkspaceMigration';
import type { AuditFixMode } from './types';
import { reconcileAfterAuditRead } from './commands';
import { runDirectDependencyPhase } from './directDependencyPhase';
import { runAuditFixPhase } from './auditFixPhase';
import { runInstallAndDedupe } from './install';

type AuditPhasePnpm = PnpmCommandRunner & PnpmCaptureRunner;

export interface AuditPhaseOptions {
  skipDedupe: boolean;
  allowMajor: boolean;
  releaseAgeCheck: boolean;
  dryRun: boolean;
  preCleanupAudit: PnpmAuditParseResult | null;
  baselineSafeVersions: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  ignoreWorkspace: boolean;
  auditFixMode: AuditFixMode;
}

export interface AuditPhaseResult {
  pkgJsonDepChanges: PackageJsonDepChange[];
  releaseAgeBlockedOverrides: ReleaseAgeBlockedOverride[];
}

/** Keep audit-phase order here; policy, writes, and validation live in named steps. */
export async function runAuditPhase(
  state: WorkspaceState,
  pnpm: AuditPhasePnpm,
  logger: Logger,
  progressLogger: ReturnType<typeof createProgressLogger>,
  options: AuditPhaseOptions,
): Promise<AuditPhaseResult> {
  let postCleanupAudit = parsePnpmAuditOutput('');
  if (!options.dryRun) {
    const { stdout } = await pnpm.capture(['audit', '--json']);
    postCleanupAudit = parsePnpmAuditOutput(stdout);
    reconcileAfterAuditRead(state, logger);
  }

  const pkgJsonDepChanges = await runDirectDependencyPhase(state, pnpm, logger, {
    allowMajor: options.allowMajor,
    postCleanupAudit,
    preCleanupAudit: options.preCleanupAudit,
  });
  const blockedOverrides = await runAuditFixPhase(state, pnpm, logger, {
    releaseAgeCheck: options.releaseAgeCheck,
    mode: options.auditFixMode,
    baselineSafeVersions: options.baselineSafeVersions,
    originalOverrides: options.originalOverrides,
  });

  // pnpm ignores workspace YAML under --ignore-workspace, so migrate its
  // generated fixes into the root package manifest before reinstalling.
  if (options.ignoreWorkspace) {
    migrateYamlOverridesToPackageJson(
      {
        rootPackageJson: state.paths.rootPackageManifest ?? state.paths.rootPackageJson,
        yaml: state.yaml,
      },
      progressLogger,
    );
  }

  await runInstallAndDedupe(pnpm, state, logger, progressLogger, {
    skipDedupe: options.skipDedupe,
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
