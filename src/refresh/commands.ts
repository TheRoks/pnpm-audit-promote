import { type Logger } from '../logger';
import { PnpmCommandFailedError } from '../errors';
import type { PnpmCommandRunner } from '../pnpm';
import type { WorkspaceState } from '../workspace';

export const INSTALL_ARGS: readonly string[] = ['install', '--no-frozen-lockfile'];
export async function runAndRestore(
  pnpm: PnpmCommandRunner,
  state: WorkspaceState,
  logger: Logger,
  args: string[],
): Promise<void> {
  await runWithBuildApproval(pnpm, state, logger, args);

  if (state.yaml.refreshHasWorkspaceYaml()) {
    logger.detail(`Detected pnpm-workspace.yaml created by pnpm ${args[0]}.`);
  }
  if (state.yaml.restoreWorkspaceYaml(logger)) {
    await runWithBuildApproval(pnpm, state, logger, [...INSTALL_ARGS]);
    if (state.yaml.refreshHasWorkspaceYaml()) {
      logger.detail('Detected pnpm-workspace.yaml created by pnpm install.');
    }
    state.yaml.restoreWorkspaceYaml(logger);
  }
}

async function runWithBuildApproval(
  pnpm: PnpmCommandRunner,
  state: WorkspaceState,
  logger: Logger,
  args: string[],
): Promise<void> {
  try {
    await pnpm.run(args);
  } catch (error) {
    if (
      args[0] !== 'install' ||
      !(error instanceof PnpmCommandFailedError) ||
      !error.stderr.includes('ERR_PNPM_IGNORED_BUILDS')
    ) {
      throw error;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || !pnpm.runInteractive) {
      throw new PnpmCommandFailedError(
        error.args,
        error.exitCode,
        error.stderr,
        'Build scripts need a decision. Run pnpm approve-builds in the target workspace and rerun this tool, or run this tool in an interactive terminal. --force does not approve builds.',
      );
    }
    logger.warn('pnpm requires a build-script decision. Opening pnpm approve-builds...');
    await pnpm.runInteractive(['approve-builds']);
    state.yaml.refreshHasWorkspaceYaml();
    state.yaml.preserveApprovedBuilds(logger);
    await pnpm.run(args);
  }
}
export function reconcileAfterAuditRead(state: WorkspaceState, logger: Logger): void {
  if (state.yaml.refreshHasWorkspaceYaml()) {
    logger.detail('Detected pnpm-workspace.yaml created by pnpm audit.');
  }
  state.yaml.preserveAuditIgnorePrune(state.pnpmMajor, logger);
  state.yaml.restoreWorkspaceYaml(logger);
}
