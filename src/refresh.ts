import * as path from 'node:path';
import { consoleLogger, type Logger } from './logger';
import {
  WorkspaceState,
  detectWorkspacePnpmMajor,
  readAuditIgnoreList,
  readAuditLevel,
} from './workspace';
import { createPnpmRunner, ensurePnpmAvailable, getPnpmMajor, type PnpmRunner } from './pnpm';
import { mergeMinimumReleaseAgeExclude } from './workspaceYamlPnpm11';
import {
  removeNodeModulesFolders,
  removePackageJsonOverrides,
  removePnpmLockFile,
  removeWorkspaceOverridesBlock,
} from './cleanup';
import { getDirectDepCatalogBumps, extractMinimumPatchedVersions } from './audit/parseAdvisories';
import {
  applyPackageJsonDepBumps,
  getDirectDepPackageJsonBumps,
} from './audit/bumpPackageJsonDeps';
import { syncAuditOverridesIntoCatalog } from './audit/promoteWorkspaceOverrides';
import { syncPackageJsonOverridesIntoCatalog } from './audit/promotePackageJsonOverrides';
import { migrateYamlOverridesToPackageJson } from './audit/ignoreWorkspaceMigration';
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
import { collectRunSummary, renderRunSummary } from './summary/emit';
import { formatDuration } from './summary/render';
import type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  PackageJsonDepChange,
  RunSummaryData,
} from './summary/types';
import { createProgressLogger } from './progress';
import { defaultConfirmDestructive, type ConfirmFn } from './prompt';
import pkg from '../package.json' with { type: 'json' };

/**
 * Args passed to every `pnpm install` invocation triggered by this tool.
 *
 * `--no-frozen-lockfile` is always required because:
 *   1. The tool intentionally mutates `pnpm-workspace.yaml` (catalog and
 *      overrides) between installs, so the lockfile *must* be allowed to
 *      drift to absorb those changes.
 *   2. pnpm 10/11 enable `--frozen-lockfile` by default whenever the `CI`
 *      environment variable is set. Without this flag, the install that
 *      follows a catalog bump fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`
 *      on every CI runner.
 *   3. Outside CI, `--no-frozen-lockfile` is the default behaviour, so
 *      passing it explicitly is a no-op there.
 */
const INSTALL_ARGS: readonly string[] = ['install', '--no-frozen-lockfile'];

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
  /**
   * When true, treat `path` as the workspace root even if an enclosing
   * `pnpm-workspace.yaml` exists in a parent directory, and forward
   * `--ignore-workspace` to every pnpm invocation so pnpm does not walk up
   * to that parent. Without this flag, an enclosing workspace causes
   * `EnclosingWorkspaceError` to be thrown.
   */
  ignoreWorkspace?: boolean;
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
  /**
   * Full computed run summary. Always populated on a successful run
   * (regardless of the `summary` rendering flag). `null` only when the
   * run was canceled before any work began.
   */
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
  const ctx = await prepareRun(options);
  const { logger, progressLogger, state, pnpm, dryRun, skipAudit, startedAt } = ctx;

  const confirm = options.confirm ?? defaultConfirmDestructive;
  if (!(await confirm({ force: Boolean(options.force), dryRun }))) {
    logger.info('Operation canceled by user.');
    return canceledResult(Date.now() - startedAt);
  }

  const initial = await captureInitialState(state, pnpm, logger, { skipAudit, dryRun });

  // pnpm 11 enforces a global `minimumReleaseAge` gate that, by default,
  // rejects packages published <24h ago — including the very patches
  // `pnpm audit --fix` would install. Pre-seed only the *specific*
  // advisory-fix versions into `minimumReleaseAgeExclude` so the gate
  // continues to protect every other package (REQ-PNPM11-009/010).
  if (!dryRun && (state.pnpmMajor ?? 0) >= 11 && initial.preCleanupAuditRaw) {
    const entries = extractMinimumPatchedVersions(initial.preCleanupAuditRaw);
    state.seedMinimumReleaseAgeExcludes(entries, logger);
  }

  await runCleanupPhase(state, progressLogger);

  await runInstallAndDedupe(pnpm, state, logger, progressLogger, {
    skipDedupe: Boolean(options.skipDedupe),
    installLabel: 'Install dependencies',
  });

  let pkgJsonDepChanges: PackageJsonDepChange[] = [];
  if (!skipAudit) {
    pkgJsonDepChanges = await runAuditPhase(state, pnpm, logger, progressLogger, {
      skipDedupe: Boolean(options.skipDedupe),
      allowMajor: options.allowMajor ?? true,
      dryRun,
      preCleanupAuditRaw: initial.preCleanupAuditRaw,
      ignoreWorkspace: options.ignoreWorkspace ?? false,
    });
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
  });

  if (options.summary !== false) {
    renderRunSummary(summary, { logger, summaryFile: options.summaryFile, dryRun });
  }

  const totalElapsed = formatDuration(Date.now() - startedAt);
  logger.success(
    dryRun
      ? `Dry-run complete. No files were modified. Total elapsed: ${totalElapsed}.`
      : `Execution complete. Total elapsed: ${totalElapsed}. Review the diff in pnpm-workspace.yaml and package.json files before committing.`,
  );

  return summaryToResult(summary);
}

interface PreparedRun {
  logger: Logger;
  progressLogger: ReturnType<typeof createProgressLogger>;
  state: WorkspaceState;
  pnpm: PnpmRunner;
  dryRun: boolean;
  skipAudit: boolean;
  startedAt: number;
}

async function prepareRun(options: RefreshOptions): Promise<PreparedRun> {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;
  const skipAudit = options.skipAudit ?? false;
  const startedAt = Date.now();

  const totalProgressSteps = skipAudit ? 6 : 11;
  const progressLogger = createProgressLogger(logger, totalProgressSteps);

  if (!options.pnpm && !dryRun) {
    await ensurePnpmAvailable();
  }
  const ignoreWorkspace = options.ignoreWorkspace ?? false;
  const state = WorkspaceState.initialize(options.path, {
    dryRun,
    ignoreParentWorkspace: ignoreWorkspace,
  });
  const pnpm =
    options.pnpm ??
    createPnpmRunner({
      cwd: state.workspaceRoot,
      logger,
      inheritOutput: logger.isVerbose(),
      dryRun,
      extraArgs: ignoreWorkspace ? ['--ignore-workspace'] : [],
    });

  logger.info(`Workspace root: ${state.workspaceRoot}${dryRun ? ' (dry-run)' : ''}`);
  if (ignoreWorkspace) {
    logger.info('Ignoring any enclosing pnpm workspace (--ignore-workspace).');
  }
  if (!state.hasWorkspaceYaml) {
    logger.info('No pnpm-workspace.yaml detected — catalog promotion steps will be skipped.');
  }
  if (!state.isMultiPackageWorkspace) {
    logger.info(
      'Single-package mode: cleanup and audit-driven bumps are confined to the workspace root.',
    );
  }

  // Detect the pnpm version of the *target* workspace. The CLI itself ships
  // pinned to a specific pnpm version (via its own `packageManager` field),
  // so `pnpm --version` on PATH reports the *CLI's* pnpm, not the version
  // that will actually execute commands inside `--path`. Corepack (and any
  // wrapper that respects `packageManager` / `devEngines.packageManager`)
  // selects the target's pin instead. We mirror that: read the workspace
  // package.json first and only fall back to `pnpm --version` when no pin
  // is declared. Failures degrade gracefully — `pnpmMajor` stays `null`,
  // which downstream code treats as legacy pnpm 10 behavior.
  let major: number | null = null;
  let source = 'unknown';
  try {
    major = detectWorkspacePnpmMajor(state.rootPackageJson);
    if (major !== null) source = 'workspace package.json';
  } catch {
    // ignore — fall through to PATH lookup
  }
  if (major === null) {
    try {
      const versionText = await pnpm.version();
      major = getPnpmMajor(versionText);
      source = versionText ? `pnpm --version (${versionText})` : 'pnpm --version';
    } catch {
      // leave major as null
    }
  }
  state.recordPnpmMajor(major);
  logger.detail(`Target workspace pnpm major: ${major ?? 'unknown'} (from ${source}).`);

  return { logger, progressLogger, state, pnpm, dryRun, skipAudit, startedAt };
}

interface InitialState {
  originalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  workspaceName: string | undefined;
  initialAdvisories: AdvisorySummary[];
  /**
   * Raw stdout of the pre-cleanup `pnpm audit --json`. Preserved separately
   * because the package.json ranged-dep bump needs the locked-minimum view:
   * for a dep declared as `^4.17.20` the fresh install resolves to the
   * latest-in-range (e.g. 4.17.21, safe), so the post-cleanup audit no
   * longer flags it. The pre-cleanup audit reflects the locked minimum and
   * lets us still raise the declared floor to the safe minimum.
   */
  preCleanupAuditRaw: string;
}

async function captureInitialState(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  opts: { skipAudit: boolean; dryRun: boolean },
): Promise<InitialState> {
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
  let preCleanupAuditRaw = '';
  if (!opts.skipAudit && !opts.dryRun) {
    try {
      const { stdout } = await pnpm.capture(['audit', '--json']);
      initialAdvisories = extractAdvisories(stdout);
      // Only retain the pre-cleanup snapshot when it is a valid audit response
      // (contains an `advisories` key).  pnpm returns {"error":{...}} when there
      // is no lockfile yet; that error string must not shadow the post-install
      // audit that `runAuditPhase` captures for `getDirectDepPackageJsonBumps`.
      try {
        if ((JSON.parse(stdout) as { advisories?: unknown }).advisories !== undefined) {
          preCleanupAuditRaw = stdout;
        }
      } catch {
        // stdout is not JSON — leave preCleanupAuditRaw empty
      }
    } catch (err) {
      // Best-effort: a missing lockfile or other audit failure leaves the
      // initial set empty rather than aborting the whole run (REQ-CORE-009).
      logger.warn(
        `Pre-cleanup audit failed: ${err instanceof Error ? err.message : String(err)}. Continuing with empty advisory baseline.`,
      );
    }
  }

  return {
    originalCatalog,
    originalOverrides,
    workspaceName,
    initialAdvisories,
    preCleanupAuditRaw,
  };
}

async function runCleanupPhase(
  state: WorkspaceState,
  progressLogger: ReturnType<typeof createProgressLogger>,
): Promise<void> {
  removePnpmLockFile(state, progressLogger);
  await removeNodeModulesFolders(state, progressLogger);
  removeWorkspaceOverridesBlock(state, progressLogger);
  removePackageJsonOverrides(state, progressLogger);
}

async function runInstallAndDedupe(
  pnpm: PnpmRunner,
  state: WorkspaceState,
  logger: Logger,
  progressLogger: ReturnType<typeof createProgressLogger>,
  opts: { skipDedupe: boolean; installLabel: string },
): Promise<void> {
  progressLogger.step(opts.installLabel);
  await runAndRestore(pnpm, state, logger, [...INSTALL_ARGS]);

  progressLogger.step('Deduplicate dependency graph');
  if (!opts.skipDedupe) {
    await runAndRestore(pnpm, state, logger, ['dedupe']);
  } else {
    logger.detail('Skipped dedupe (--no-dedupe).');
  }
}

async function runAuditPhase(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  progressLogger: ReturnType<typeof createProgressLogger>,
  opts: {
    skipDedupe: boolean;
    allowMajor: boolean;
    dryRun: boolean;
    preCleanupAuditRaw: string;
    ignoreWorkspace: boolean;
  },
): Promise<PackageJsonDepChange[]> {
  // Capture a post-cleanup audit JSON and share it with the pre-audit
  // catalog bump (which needs the unmasked vulnerability set to decide
  // which direct deps to bump). This is *separate* from the initial
  // audit captured before cleanup for the summary.
  const postCleanupAuditStdout = opts.dryRun
    ? ''
    : (await pnpm.capture(['audit', '--json'])).stdout;

  const pkgJsonDepChanges = await preAuditCatalogBump(
    state,
    pnpm,
    progressLogger,
    opts.allowMajor,
    postCleanupAuditStdout,
    opts.preCleanupAuditRaw,
  );
  await auditFix(state, pnpm, progressLogger);

  // Under `--ignore-workspace`, pnpm deliberately ignores pnpm-workspace.yaml,
  // including any overrides `pnpm audit --fix` just wrote into it. Migrate
  // those overrides into the root package.json's `pnpm.overrides` so the
  // subsequent install actually applies them (and the final audit sees them).
  if (opts.ignoreWorkspace) {
    migrateYamlOverridesToPackageJson(state, progressLogger);
  }

  await runInstallAndDedupe(pnpm, state, logger, progressLogger, {
    skipDedupe: opts.skipDedupe,
    installLabel: 'Reinstall dependencies (post-audit reconciliation)',
  });

  return pkgJsonDepChanges;
}

function canceledResult(durationMs: number): RefreshResult {
  return {
    canceled: true,
    durationMs,
    catalogChanges: [],
    overrideChanges: [],
    initialAdvisories: [],
    finalAdvisories: [],
    fixedAdvisories: [],
    summary: null,
  };
}

function summaryToResult(summary: RunSummaryData): RefreshResult {
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

async function runAndRestore(
  pnpm: PnpmRunner,
  state: WorkspaceState,
  logger: Logger,
  args: string[],
): Promise<void> {
  await pnpm.run(args);
  if (state.restoreWorkspaceYaml(logger)) {
    await pnpm.run([...INSTALL_ARGS]);
  }
}

async function preAuditCatalogBump(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  allowMajor: boolean,
  auditJsonStdout: string,
  preCleanupAuditRaw: string,
): Promise<PackageJsonDepChange[]> {
  logger.step('Scan direct dependencies for vulnerable catalog entries');

  const ignoredAdvisoryIds = readAuditIgnoreList(state.desiredWorkspaceYaml);
  const minSeverity = readAuditLevel(state.desiredWorkspaceYaml) ?? undefined;

  const { bumps, tiers } = await getDirectDepCatalogBumps(state, pnpm, logger, {
    allowMajor,
    auditJsonStdout,
    ignoredAdvisoryIds: ignoredAdvisoryIds.size > 0 ? ignoredAdvisoryIds : undefined,
  });
  // For package.json ranged deps (^/~), the post-cleanup install may resolve
  // to a safe-in-range version that makes the advisory disappear from the
  // post-install audit. Use the pre-cleanup audit (locked minimums) as the
  // primary source so we still raise the declared floor. Fall back to the
  // post-cleanup data when there was no pre-existing lock file.
  const pkgJsonAuditStdout = preCleanupAuditRaw || auditJsonStdout;
  const pkgJsonBumps = await getDirectDepPackageJsonBumps(state, pnpm, logger, {
    allowMajor,
    auditJsonStdout: pkgJsonAuditStdout,
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
    state.desiredWorkspaceYaml = applyCatalogUpdates(state.desiredWorkspaceYaml, bumps);
    state.saveWorkspaceYaml(state.desiredWorkspaceYaml);
  }

  if (pkgJsonBumps.length > 0) {
    logger.detail('Applying package.json updates for vulnerable direct dependencies:');
    for (const bump of pkgJsonBumps) {
      const rel = path.relative(state.workspaceRoot, bump.pkgJsonPath);
      const annotation = bump.tier === 'major' ? ' (MAJOR)' : '';
      logger.bullet(`${bump.name} (${rel}): ${bump.before} -> ${bump.after}${annotation}`);
    }
    applyPackageJsonDepBumps(pkgJsonBumps, state.dryRun);
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

async function auditFix(state: WorkspaceState, pnpm: PnpmRunner, logger: Logger): Promise<void> {
  logger.step('Apply pnpm audit fixes');
  // pnpm 11 made `--fix` require an explicit value (`override` or `update`)
  // and rejects the bare flag with ERR_PNPM_INVALID_FIX_OPTION. We always
  // want override-based fixes because the whole point of this tool is to
  // promote those overrides into the catalog (`--fix=update` would patch
  // the lockfile directly and bypass that pipeline). pnpm 10 still accepts
  // the bare `--fix`, so it stays the default for older / unknown majors.
  const auditArgs =
    (state.pnpmMajor ?? 0) >= 11 ? ['audit', '--fix', 'override'] : ['audit', '--fix'];
  // pnpm audit returns non-zero when vulnerabilities remain; don't fail.
  const code = await pnpm.runAllowFail(auditArgs);
  logger.detail(`pnpm ${auditArgs.join(' ')} completed with exit code ${code}.`);

  // pnpm 11's `audit --fix override` writes its overrides into
  // pnpm-workspace.yaml even when the workspace started without one
  // (notably under `--ignore-workspace`). Re-detect the file before the
  // sync/collapse passes so the new content is not silently ignored.
  if (state.refreshHasWorkspaceYaml()) {
    logger.detail('Detected pnpm-workspace.yaml created by `pnpm audit --fix`.');
  }

  // pnpm 11's `audit --fix` writes `minimumReleaseAgeExclude` entries into
  // pnpm-workspace.yaml so the patched versions are not blocked by the
  // global `minimumReleaseAge` gate. Merge those additions into our desired
  // snapshot before override promotion (which writes a fresh file) so we
  // don't silently discard the security-exclude list.
  if (state.hasWorkspaceYaml && (state.pnpmMajor ?? 0) >= 11) {
    const onDisk = state.readWorkspaceYaml();
    const merged = mergeMinimumReleaseAgeExclude(state.desiredWorkspaceYaml, onDisk);
    if (merged !== state.desiredWorkspaceYaml) {
      logger.detail('Merged `minimumReleaseAgeExclude` entries written by pnpm 11 audit --fix.');
      state.desiredWorkspaceYaml = merged;
    }
  }

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
