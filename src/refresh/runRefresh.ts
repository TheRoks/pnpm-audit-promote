import { collectRunSummary, renderRunSummary } from '../summary/emit';
import { formatDuration } from '../summary/render';
import { diffAdvisories, diffCatalog, diffOverrides } from '../summary/collect';
import type {
  PackageJsonDepChange,
  ReleaseAgeBlockedOverride,
  RunSummaryData,
} from '../summary/types';
import { defaultConfirmDestructive } from '../prompt';
import pkg from '../../package.json' with { type: 'json' };
import { prepareRun } from './prepare';
import { captureInitialState } from './initialState';
import { runCleanupPhase } from './cleanupPhase';
import { runInstallAndDedupe } from './install';
import { runAuditPhase } from './auditPhase';
import { restoreWorkspaceControlFiles } from './recovery';
import type { RefreshOptions, RefreshResult } from './types';

export async function runRefresh(options: RefreshOptions): Promise<RefreshResult> {
  const ctx = await prepareRun(options);
  const { logger, progressLogger, state, pnpm, dryRun, skipAudit, startedAt } = ctx;

  const confirm = options.confirm ?? defaultConfirmDestructive;
  if (!(await confirm({ force: Boolean(options.force), dryRun }))) {
    logger.info('Operation canceled by user.');
    return canceledResult(Date.now() - startedAt);
  }

  const initial = await captureInitialState(state, pnpm, logger, { skipAudit, dryRun });
  if (!skipAudit) {
    state.configuration.assertAuditSettingsWritable(
      initial.preCleanupAudit?.complete
        ? Object.values(initial.preCleanupAudit.audit.advisories)
        : [],
      initial.originalCatalog,
      initial.preCleanupAudit?.complete ?? false,
    );
  }

  try {
    // The tool never adds or modifies `minimumReleaseAgeExclude` in
    // `pnpm-workspace.yaml` (REQ-PNPM11-011). The user's release-age gate —
    // including their exclude list — is preserved verbatim across the run.

    await runCleanupPhase(state, progressLogger);

    await runInstallAndDedupe(pnpm, state, logger, progressLogger, {
      skipDedupe: Boolean(options.skipDedupe),
      installLabel: 'Install dependencies',
    });

    let pkgJsonDepChanges: PackageJsonDepChange[] = [];
    let releaseAgeBlockedOverrides: ReleaseAgeBlockedOverride[] = [];
    if (!skipAudit) {
      const auditResult = await runAuditPhase(state, pnpm, logger, progressLogger, {
        skipDedupe: Boolean(options.skipDedupe),
        allowMajor: options.allowMajor ?? true,
        releaseAgeCheck: options.releaseAgeCheck ?? true,
        dryRun,
        preCleanupAudit: initial.preCleanupAudit,
        baselineSafeVersions: initial.baselineSafeVersions,
        originalOverrides: initial.originalOverrides,
        ignoreWorkspace: options.ignoreWorkspace ?? false,
        auditFixMode: options.auditFixMode ?? 'override',
      });
      pkgJsonDepChanges = auditResult.pkgJsonDepChanges;
      releaseAgeBlockedOverrides = auditResult.releaseAgeBlockedOverrides;
    } else {
      logger.detail('Skipped audit and catalog promotion (--no-audit).');
    }

    // Always assemble the canonical summary; rendering is conditional.
    const summary = await collectRunSummary({
      state,
      pnpm,
      skipAudit,
      dryRun,
      durationMs: Date.now() - startedAt,
      toolVersion: pkg.version,
      workspaceName: initial.workspaceName,
      originalCatalog: initial.originalCatalog,
      originalOverrides: initial.originalOverrides,
      initialAdvisories: initial.initialAdvisories,
      pkgJsonDepChanges,
      releaseAgeBlockedOverrides,
    });

    if (summary.auditStatus === 'failed') {
      logger.warn(
        'Final audit verification failed; fixed and remaining vulnerability counts are unknown.',
      );
    }

    if (options.summary !== false) {
      renderRunSummary(summary, { logger, summaryFile: options.summaryFile, dryRun });
    }

    const totalElapsed = formatDuration(Date.now() - startedAt);
    logger.success(
      dryRun
        ? `Dry-run complete. No files were modified. Total elapsed: ${totalElapsed}.`
        : `Execution complete. Total elapsed: ${totalElapsed}. Review the diff in workspace configuration and package manifest files before committing.`,
    );

    return summaryToResult(summary);
  } catch (error) {
    if (!dryRun) restoreWorkspaceControlFiles(state, initial.controlFiles, logger);
    throw error;
  }
}

function canceledResult(durationMs: number): RefreshResult {
  return {
    canceled: true,
    durationMs,
    auditStatus: 'skipped',
    catalogChanges: [],
    overrideChanges: [],
    initialAdvisories: [],
    finalAdvisories: [],
    fixedAdvisories: [],
    summary: null,
  };
}

function summaryToResult(summary: RunSummaryData): RefreshResult {
  const auditStatus =
    summary.auditStatus ?? (summary.auditSkipped || summary.dryRun ? 'skipped' : 'complete');
  const fixed =
    auditStatus === 'complete'
      ? diffAdvisories(summary.initialAdvisories, summary.finalAdvisories).fixed
      : [];
  return {
    canceled: false,
    durationMs: summary.durationMs,
    auditStatus,
    catalogChanges: diffCatalog(summary.originalCatalog, summary.finalCatalog),
    overrideChanges: diffOverrides(summary.originalOverrides, summary.finalOverrides),
    initialAdvisories: summary.initialAdvisories,
    finalAdvisories: summary.finalAdvisories,
    fixedAdvisories: fixed,
    summary,
  };
}
