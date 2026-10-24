import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '../logger';
import type { WorkspacePaths } from '../workspace';
import type { WorkspaceMutations } from '../workspace/mutations';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { findNodeModulesFolders } from '../fsWalk';

interface FileCleanupWorkspace {
  paths: WorkspacePaths;
  isMultiPackageWorkspace: boolean;
  mutations: WorkspaceMutations;
  yaml: Pick<WorkspaceYamlSnapshot, 'dryRun'>;
}

export function removePnpmLockFile(state: FileCleanupWorkspace, logger: Logger): void {
  logger.step('Remove pnpm lockfile');
  if (fs.existsSync(state.paths.lockFile)) {
    if (state.yaml.dryRun) {
      logger.detail(`Dry-run: would remove ${state.paths.lockFile}`);
    } else {
      if (state.mutations.removeFileSync(state.paths.lockFile)) {
        logger.detail(`Removed ${state.paths.lockFile}.`);
      }
    }
  } else {
    logger.detail('No pnpm-lock.yaml found.');
  }
}

export async function removeNodeModulesFolders(
  state: FileCleanupWorkspace,
  logger: Logger,
): Promise<void> {
  logger.step('Remove node_modules directories');
  let dirs: string[];
  if (state.isMultiPackageWorkspace) {
    dirs = findNodeModulesFolders(state.paths.workspaceRoot);
  } else {
    // Single-package mode: only the workspace root's own node_modules is
    // eligible. The mode banner is emitted once in `prepareRun`.
    const rootNodeModules = path.join(state.paths.workspaceRoot, 'node_modules');
    dirs = fs.existsSync(rootNodeModules) ? [rootNodeModules] : [];
  }
  if (dirs.length === 0) {
    logger.detail('No node_modules directories found.');
    return;
  }

  const spinner = createCleanupSpinner({
    enabled: !state.yaml.dryRun && Boolean(process.stdout.isTTY) && logger.showsDetails(),
    total: dirs.length,
  });
  spinner.start();

  let removedCount = 0;
  let processedCount = 0;
  for (const dir of dirs) {
    if (state.yaml.dryRun) {
      logger.detail(`Dry-run: would remove ${dir}`);
      continue;
    }
    processedCount += 1;
    spinner.update(processedCount);
    try {
      // On Windows, `rd /s /q` is dramatically faster than recursive rm for
      // deep node_modules trees; WorkspaceMutations validates the path first
      // and falls back to fs.promises.rm if the command leaves files behind.
      await state.mutations.removeDirectory(dir, async (resolved) => {
        if (process.platform === 'win32') {
          await spawnAsync('cmd', ['/c', 'rd', '/s', '/q', resolved]);
        }
      });
    } catch {
      // Fall through to the existing warning when removal cannot complete.
    }
    if (await pathExists(dir)) {
      logger.warn(`Could not fully remove ${dir} (possibly locked by another process).`);
    } else {
      removedCount += 1;
      spinner.update(removedCount);
    }
  }

  spinner.stop();
  if (!state.yaml.dryRun) {
    logger.detail(`Removed ${removedCount}/${dirs.length} node_modules directories.`);
  }
}
function spawnAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

function pathExists(p: string): Promise<boolean> {
  return fs.promises.access(p).then(
    () => true,
    () => false,
  );
}

function createCleanupSpinner(options: { enabled: boolean; total: number }): {
  start: () => void;
  update: (processed: number) => void;
  stop: () => void;
} {
  const { enabled, total } = options;
  if (!enabled) {
    return {
      start() {},
      update() {},
      stop() {},
    };
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let processed = 0;
  let timer: NodeJS.Timeout | undefined;

  const render = (): void => {
    const marker = frames[frame % frames.length] ?? '•';
    frame += 1;
    const progress = processed > 0 ? ` · ${processed}/${total}` : '';
    process.stdout.write(`\r\x1b[2K${marker} Removing node_modules${progress}`);
  };

  return {
    start(): void {
      render();
      timer = setInterval(() => {
        render();
      }, 120);
      timer.unref?.();
    },
    update(nextProcessed: number): void {
      processed = nextProcessed;
      render();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      process.stdout.write('\r\x1b[2K');
    },
  };
}
