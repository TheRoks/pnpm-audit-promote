import * as readline from 'node:readline';
import { consoleLogger, type Logger } from './logger.js';
import { WorkspaceState } from './workspace.js';
import { createPnpmRunner, ensurePnpmAvailable, type PnpmRunner } from './pnpm.js';
import {
  removeNodeModulesFolders,
  removePackageJsonOverrides,
  removePnpmLockFile,
  removeWorkspaceOverridesBlock,
} from './cleanup.js';
import {
  getDirectDepCatalogBumps,
  syncAuditOverridesIntoCatalog,
  syncPackageJsonOverridesIntoCatalog,
} from './auditSync.js';
import { applyCatalogUpdates } from './catalog.js';

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
 * Steps 6–8 are skipped when `skipAudit` is true.
 */
export async function refreshDeps(options: RefreshOptions): Promise<void> {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;

  if (!options.pnpm && !dryRun) {
    await ensurePnpmAvailable();
  }
  const state = WorkspaceState.initialize(options.path, { dryRun });
  const pnpm = options.pnpm ?? createPnpmRunner({ cwd: state.workspaceRoot, logger, dryRun });

  logger.info(`Workspace: ${state.workspaceRoot}${dryRun ? ' (dry-run)' : ''}`);

  if (!(await confirmDestructive(Boolean(options.force), dryRun))) {
    logger.info('Aborted.');
    return;
  }

  // Cleanup phase ---------------------------------------------------------
  removePnpmLockFile(state, logger);
  removeNodeModulesFolders(state, logger);
  removeWorkspaceOverridesBlock(state, logger);
  removePackageJsonOverrides(state, logger);

  // Install phase ---------------------------------------------------------
  logger.step('pnpm install');
  await runAndRestore(pnpm, state, logger, ['install']);

  if (!options.skipDedupe) {
    logger.step('pnpm dedupe');
    await runAndRestore(pnpm, state, logger, ['dedupe']);
  }

  // Audit phase -----------------------------------------------------------
  if (!options.skipAudit) {
    await preAuditCatalogBump(state, pnpm, logger, options.allowMajor ?? true);
    await auditFix(state, pnpm, logger);

    logger.step('pnpm install (post-audit)');
    await runAndRestore(pnpm, state, logger, ['install']);

    if (!options.skipDedupe) {
      logger.step('pnpm dedupe');
      await runAndRestore(pnpm, state, logger, ['dedupe']);
    }
  }

  logger.raw('');
  logger.success(
    dryRun
      ? 'Dry-run complete. No files were modified.'
      : 'Done. Review the diff in pnpm-workspace.yaml and package.json files before committing.',
  );
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
): Promise<void> {
  logger.step('Scanning audit for direct-dep vulnerabilities (pre-audit catalog bump)');
  const { bumps, tiers } = await getDirectDepCatalogBumps(state, pnpm, logger, { allowMajor });
  if (bumps.size === 0) {
    logger.detail('No direct-dep vulnerabilities found.');
    return;
  }

  logger.detail('Bumping catalog for direct-dep vulnerabilities:');
  for (const [k, v] of bumps) {
    const annotation = tiers.get(k) === 'major' ? ' (MAJOR)' : '';
    logger.bullet(`${k} -> ${v}${annotation}`);
  }

  state.desiredWorkspaceYaml = applyCatalogUpdates(state.desiredWorkspaceYaml, bumps);
  state.saveWorkspaceYaml(state.desiredWorkspaceYaml);

  logger.step('pnpm install (post catalog bump)');
  await runAndRestore(pnpm, state, logger, ['install']);
}

async function auditFix(state: WorkspaceState, pnpm: PnpmRunner, logger: Logger): Promise<void> {
  logger.step('pnpm audit --fix');
  // pnpm audit returns non-zero when vulnerabilities remain; don't fail.
  const code = await pnpm.runAllowFail(['audit', '--fix']);
  logger.detail(`pnpm audit exit code: ${code}`);

  // Safety net: promote any catalog-eligible overrides into the catalog.
  state.desiredWorkspaceYaml = syncAuditOverridesIntoCatalog(state, logger);
  state.desiredWorkspaceYaml = syncPackageJsonOverridesIntoCatalog(
    state,
    state.desiredWorkspaceYaml,
    logger,
  );
}

async function confirmDestructive(force: boolean, dryRun: boolean): Promise<boolean> {
  if (force || dryRun) return true;

  // Non-interactive: require explicit --force rather than blocking on stdin.
  if (!process.stdin.isTTY) {
    throw new Error(
      'Refusing to run destructive operations non-interactively. Re-run with --force.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      'This will delete pnpm-lock.yaml, every node_modules, and all overrides in pnpm-workspace.yaml. Continue? [y/N] ',
      (a) => resolve(a),
    );
  });
  rl.close();
  return /^(y|yes)$/i.test(answer.trim());
}
