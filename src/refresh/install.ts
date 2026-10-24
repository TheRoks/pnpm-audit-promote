import { type Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { readAutoDedupe } from '../workspace/pnpmConfig';
import type { PnpmCommandRunner } from '../pnpm';
import type { createProgressLogger } from '../progress';
import { INSTALL_ARGS, runAndRestore } from './commands';

export async function runInstallAndDedupe(
  pnpm: PnpmCommandRunner,
  state: WorkspaceState,
  logger: Logger,
  progressLogger: ReturnType<typeof createProgressLogger>,
  opts: { skipDedupe: boolean; installLabel: string },
): Promise<void> {
  progressLogger.step(opts.installLabel);
  await runAndRestore(pnpm, state, logger, [...INSTALL_ARGS]);

  progressLogger.step('Deduplicate dependency graph');
  const autoDedupeEnabled =
    state.pnpmCapabilities.supportsAutoDedupe &&
    readAutoDedupe(state.configuration.readEffectiveYaml());
  if (!opts.skipDedupe && !autoDedupeEnabled) {
    await runAndRestore(pnpm, state, logger, ['dedupe']);
  } else if (autoDedupeEnabled && !opts.skipDedupe) {
    logger.detail('Skipped explicit dedupe; pnpm autoDedupe is enabled during install.');
  } else {
    logger.detail('Skipped dedupe (--no-dedupe).');
  }
}
