import type { WorkspaceState } from '../workspace';
import type { createProgressLogger } from '../progress';
import {
  removeNodeModulesFolders,
  removePackageJsonOverrides,
  removePnpmLockFile,
  removeWorkspaceOverridesBlock,
} from '../cleanup';

export async function runCleanupPhase(
  state: WorkspaceState,
  progressLogger: ReturnType<typeof createProgressLogger>,
): Promise<void> {
  removePnpmLockFile(state, progressLogger);
  await removeNodeModulesFolders(state, progressLogger);
  removeWorkspaceOverridesBlock(state, progressLogger);
  removePackageJsonOverrides(state, progressLogger);
}
