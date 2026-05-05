import { consoleLogger, type Logger } from './logger';
import { WorkspaceState } from './workspace';
import { createPnpmRunner, ensurePnpmAvailable, type PnpmRunner } from './pnpm';
import {
  removeNodeModulesFolders,
  removePackageJsonOverrides,
  removePnpmLockFile,
  removeWorkspaceOverridesBlock,
} from './cleanup';
import { getDirectDepCatalogBumps } from './audit/parseAdvisories';
import { syncAuditOverridesIntoCatalog } from './audit/promoteWorkspaceOverrides';
import { syncPackageJsonOverridesIntoCatalog } from './audit/promotePackageJsonOverrides';
import { applyCatalogUpdates } from './catalog';
import {
  extractAdvisories,
  diffAdvisories,
  diffCatalog,
  diffOverrides,
  readAllOverrides,
  readCatalogSnapshot,
  safeReadFile,
} from './summary/collect';
import { emitRunSummary } from './summary/emit';
import { formatDuration } from './summary/render';
import type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  RunSummaryData,
} from './summary/types';
import { createProgressLogger } from './progress';
import { defaultConfirmDestructive, type ConfirmFn } from './prompt';
import pkg from '../package.json' with { type: 'json' };

export interface RefreshOptions {
  /** Workspace root containing pnpm-workspace.yaml. */
  path: string;
  /** Skip the destructive-action confirmation prompt. */
  force?: boolean;
  /** Custom logger; defaults to a colored console logger at `normal` level. */
  logger?: Logger;
  /**
   * Inject a custom pnpm runner. Defaults to one that shells out to the real
   * `pnpm` binary on PATH. Useful for tests and advanced integrations.
   */
  pnpm?: PnpmRunner;
  /**
   * Inject a custom destructive-action confirmation function. Defaults to a
   * stdin-readline prompt; tests can pass a deterministic stub instead of
   * mutating `process.stdin.isTTY`.
   */
  confirm?: ConfirmFn;
  /** When true, plan and log changes without writing files or invoking pnpm. */
  dryRun?: boolean;
  /** Skip the audit + catalog promotion phase. */
  skipAudit?: boolean;
  /** Skip `pnpm dedupe` calls. */
  skipDedupe?: boolean;
  /**
   * When false, the pre-audit catalog bump skips packages whose only
   * non-vulnerable upgrade crosses a major version boundary (and logs a
   * warning). Defaults to true.
   */
  allowMajor?: boolean;
  /**
   * When true (default), prints a terminal-pretty summary at the end
   * describing direct/transitive package changes and resolved CVEs.
   * A plain-text (no ANSI) copy is also written to `summaryFile` when
   * provided.
   */
  summary?: boolean;
  /** Optional path to also write the plain-text summary to. */
  summaryFile?: string;
}

/**
 * Outcome of a {@link refreshDeps} invocation. Programmatic callers can
 * inspect this to decide what changed without parsing log output.
 */
export interface RefreshResult {
  /** True when the user (or the non-interactive guard) declined to proceed. */
  canceled: boolean;
  /** Total wall-clock time spent in `refreshDeps`. */
  durationMs: number;
  /** Direct-dependency catalog version changes. Empty when nothing changed. */
  catalogChanges: readonly CatalogChange[];
  /** Transitive overrides added or modified by `pnpm audit --fix`. */
  overrideChanges: readonly OverrideChange[];
  /** Vulnerabilities present at the start of the run. */
  initialAdvisories: readonly AdvisorySummary[];
  /** Vulnerabilities still present after the run (best-effort). */
  finalAdvisories: readonly AdvisorySummary[];
  /** Advisories cleared during the run (initial \\ final, by id). */
  fixedAdvisories: readonly AdvisorySummary[];
  /** Full computed run summary. `null` when `summary: false` was passed. */
  summary: RunSummaryData | null;
}

/**
 * Programmatic entry point.
 *
 * Performs, in order:
 *
 *   1.  Remove `pnpm-lock.yaml`
 *   2.  Remove every `node_modules` folder
 *   3.  Strip overrides from `pnpm-workspace.yaml`
 *   3b. Strip `pnpm.overrides` from every `package.json`
 *   4.  `pnpm install`
 *   5.  `pnpm dedupe` (unless `skipDedupe`)
 *   6.  Pre-audit catalog bump for direct-dep vulnerabilities
 *   7.  `pnpm audit --fix`
 *   8.  Promote any catalog-eligible audit overrides back into the catalog
 *   9.  `pnpm install`
 *   10. `pnpm dedupe` (unless `skipDedupe`)
 *
 * Steps 6—8 are skipped when `skipAudit` is true.
 */
export async function refreshDeps(options: RefreshOptions): Promise<RefreshResult> {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;
  const skipAudit = options.skipAudit ?? false;
  const startedAt = Date.now();

  const totalProgressSteps = skipAudit ? 6 : 11;
  const progressLogger = createProgressLogger(logger, totalProgressSteps);

  if (!options.pnpm && !dryRun) {
    await ensurePnpmAvailable();
  }
  const state = WorkspaceState.initialize(options.path, { dryRun });
  const pnpm =
    options.pnpm ??
    createPnpmRunner({
      cwd: state.workspaceRoot,
      logger,
      inheritOutput: logger.isVerbose(),
      dryRun,
    });

  logger.info(`Workspace root: ${state.workspaceRoot}${dryRun ? ' (dry-run)' : ''}`);

  const confirm = options.confirm ?? defaultConfirmDestructive;
  if (!(await confirm({ force: Boolean(options.force), dryRun }))) {
    logger.info('Operation canceled by user.');
    return {
      canceled: true,
      durationMs: Date.now() - startedAt,
      catalogChanges: [],
      overrideChanges: [],
      initialAdvisories: [],
      finalAdvisories: [],
      fixedAdvisories: [],
      summary: null,
    };
  }

  // Capture the original state BEFORE any cleanup mutates files. Used by
  // the run-summary at the end.
  const originalYaml = state.desiredWorkspaceYaml;
  const originalPjText = safeReadFile(state.rootPackageJson);
  const originalCatalog = readCatalogSnapshot(originalYaml);
  const originalOverrides = readAllOverrides(originalYaml, originalPjText);
  const workspaceName = readPackageJsonName(originalPjText);

  // Capture the TRUE initial vulnerability state — i.e. the audit result
  // with any existing overrides still applied. If we ran this after the
  // cleanup phase, every existing override would be stripped first and
  // its masked vulnerabilities would resurface, only to be "fixed" again
  // when audit-fix re-adds the same overrides. That would inflate the
  // "vulnerabilities fixed" count with non-changes.
  let initialAdvisories: AdvisorySummary[] = [];
  if (!skipAudit && !dryRun) {
    try {
      const { stdout } = await pnpm.capture(['audit', '--json']);
      initialAdvisories = extractAdvisories(stdout);
    } catch {
      // Best-effort: a missing lockfile or other audit failure leaves the
      // initial set empty rather than aborting the whole run.
    }
  }

  // Cleanup phase ---------------------------------------------------------
  removePnpmLockFile(state, progressLogger);
  await removeNodeModulesFolders(state, progressLogger);
  removeWorkspaceOverridesBlock(state, progressLogger);
  removePackageJsonOverrides(state, progressLogger);

  // Install phase ---------------------------------------------------------
  progressLogger.step('Install dependencies');
  await runAndRestore(pnpm, state, logger, ['install']);

  progressLogger.step('Deduplicate dependency graph');
  if (!options.skipDedupe) {
    await runAndRestore(pnpm, state, logger, ['dedupe']);
  } else {
    logger.detail('Skipped dedupe (--no-dedupe).');
  }

  // Audit phase -----------------------------------------------------------
  if (!skipAudit) {
    // Capture a post-cleanup audit JSON and share it with the pre-audit
    // catalog bump (which needs the unmasked vulnerability set to decide
    // which direct deps to bump). This is *separate* from the initial
    // audit captured above for the summary.
    const postCleanupAuditStdout = dryRun ? '' : (await pnpm.capture(['audit', '--json'])).stdout;

    await preAuditCatalogBump(
      state,
      pnpm,
      progressLogger,
      options.allowMajor ?? true,
      postCleanupAuditStdout,
    );
    await auditFix(state, pnpm, progressLogger);

    progressLogger.step('Reinstall dependencies (post-audit reconciliation)');
    await runAndRestore(pnpm, state, logger, ['install']);

    progressLogger.step('Deduplicate dependency graph');
    if (!options.skipDedupe) {
      await runAndRestore(pnpm, state, logger, ['dedupe']);
    } else {
      logger.detail('Skipped dedupe (--no-dedupe).');
    }
  } else {
    logger.detail('Skipped audit and catalog promotion (--no-audit).');
  }

  // Summary phase ---------------------------------------------------------
  const summary = await emitRunSummary({
    state,
    pnpm,
    logger,
    enabled: options.summary !== false,
    summaryFile: options.summaryFile,
    skipAudit,
    dryRun,
    durationMs: Date.now() - startedAt,
    toolVersion: pkg.version,
    workspaceName,
    originalCatalog,
    originalOverrides,
    initialAdvisories,
  });

  logger.raw('');
  const totalElapsed = formatDuration(Date.now() - startedAt);
  logger.success(
    dryRun
      ? `Dry-run complete. No files were modified. Total elapsed: ${totalElapsed}.`
      : `Execution complete. Total elapsed: ${totalElapsed}. Review the diff in pnpm-workspace.yaml and package.json files before committing.`,
  );

  // Programmatic result. When `summary` was disabled, fall back to a
  // direct re-computation so callers always get diff data.
  if (summary) {
    const { fixed } = diffAdvisories(summary.initialAdvisories, summary.finalAdvisories);
    return {
      canceled: false,
      durationMs: summary.durationMs,
      catalogChanges: diffCatalog(summary.originalCatalog, summary.finalCatalog),
      overrideChanges: diffOverrides(summary.originalOverrides, summary.finalOverrides),
      initialAdvisories: summary.initialAdvisories,
      finalAdvisories: summary.finalAdvisories,
      fixedAdvisories: fixed,
      summary,
    };
  }

  // summary: false branch — recompute the diffs without rendering.
  const finalYaml = state.desiredWorkspaceYaml || (dryRun ? '' : state.readWorkspaceYaml());
  const finalPjText = safeReadFile(state.rootPackageJson);
  const finalCatalog = readCatalogSnapshot(finalYaml);
  const finalOverrides = readAllOverrides(finalYaml, finalPjText);
  const { fixed } = diffAdvisories(initialAdvisories, []);
  return {
    canceled: false,
    durationMs: Date.now() - startedAt,
    catalogChanges: diffCatalog(originalCatalog, finalCatalog),
    overrideChanges: diffOverrides(originalOverrides, finalOverrides),
    initialAdvisories,
    finalAdvisories: [],
    fixedAdvisories: fixed,
    summary: null,
  };
}

async function runAndRestore(
  pnpm: PnpmRunner,
  state: WorkspaceState,
  logger: Logger,
  args: string[],
): Promise<void> {
  await pnpm.run(args);
  if (state.restoreWorkspaceYaml(logger)) {
    await pnpm.run(['install']);
  }
}

async function preAuditCatalogBump(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  allowMajor: boolean,
  auditJsonStdout: string,
): Promise<void> {
  logger.step('Scan direct dependencies for vulnerable catalog entries');
  const { bumps, tiers } = await getDirectDepCatalogBumps(state, pnpm, logger, {
    allowMajor,
    auditJsonStdout,
  });
  logger.step('Reinstall dependencies after catalog updates');
  if (bumps.size === 0) {
    logger.detail('No vulnerable direct dependencies detected in catalog-managed packages.');
    logger.detail('Skipped reinstall: no catalog updates were required.');
    return;
  }

  logger.detail('Applying catalog updates for vulnerable direct dependencies:');
  for (const [k, v] of bumps) {
    const annotation = tiers.get(k) === 'major' ? ' (MAJOR)' : '';
    logger.bullet(`${k} -> ${v}${annotation}`);
  }

  state.desiredWorkspaceYaml = applyCatalogUpdates(state.desiredWorkspaceYaml, bumps);
  state.saveWorkspaceYaml(state.desiredWorkspaceYaml);

  await runAndRestore(pnpm, state, logger, ['install']);
}

async function auditFix(state: WorkspaceState, pnpm: PnpmRunner, logger: Logger): Promise<void> {
  logger.step('Apply pnpm audit fixes');
  // pnpm audit returns non-zero when vulnerabilities remain; don't fail.
  const code = await pnpm.runAllowFail(['audit', '--fix']);
  logger.detail(`pnpm audit --fix completed with exit code ${code}.`);

  // Safety net: promote any catalog-eligible overrides into the catalog.
  state.desiredWorkspaceYaml = syncAuditOverridesIntoCatalog(state, logger);
  state.desiredWorkspaceYaml = syncPackageJsonOverridesIntoCatalog(
    state,
    state.desiredWorkspaceYaml,
    logger,
  );
}

function readPackageJsonName(text: string | null): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
