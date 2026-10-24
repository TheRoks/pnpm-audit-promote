import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';

export interface WorkspaceRecoveryResult {
  restoredPaths: string[];
  failedPaths: Array<{ path: string; error: unknown }>;
}

/** Restore tool-controlled files after a failed refresh, retaining build approvals. */
export function restoreWorkspaceControlFiles(
  state: WorkspaceState,
  snapshot: ReadonlyMap<string, string | null>,
  logger: Logger,
): WorkspaceRecoveryResult {
  const result: WorkspaceRecoveryResult = { restoredPaths: [], failedPaths: [] };
  const yamlPaths = new Set(state.configuration.getSnapshots().map((item) => item.path));
  const yamlRecovery = state.configuration.restoreInitialFiles(snapshot, logger);
  result.restoredPaths.push(...yamlRecovery.restored);
  result.failedPaths.push(...yamlRecovery.failed);

  for (const [filePath, content] of snapshot) {
    if (yamlPaths.has(filePath)) continue;
    try {
      if (content === null) state.mutations.removeFileSync(filePath);
      else state.mutations.writeTextFile(filePath, content);
      result.restoredPaths.push(filePath);
    } catch (error) {
      result.failedPaths.push({ path: filePath, error });
    }
  }

  if (result.failedPaths.length === 0) {
    logger.warn(
      'Refresh failed. Restored the lockfile, workspace configuration, and package manifests to their pre-run contents. pnpm may have removed or partially rebuilt node_modules; run pnpm install before resuming work.',
    );
  } else {
    const failed = result.failedPaths.map(({ path }) => path).join(', ');
    logger.warn(
      `Refresh failed and recovery could not restore these workspace files: ${failed}. Check them before continuing.`,
    );
  }
  return result;
}
