import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { findNodeModulesFolders } from '../fsWalk';

/**
 * Defense-in-depth: refuse to delete any path that does not resolve under the
 * workspace root. Guards against accidental misuse of the cleanup helpers
 * with externally-supplied paths.
 */
function assertWithinWorkspace(state: WorkspaceState, target: string): void {
  const resolved = path.resolve(target);
  const root = path.resolve(state.workspaceRoot);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to delete '${resolved}': path is not contained within workspace root '${root}'.`,
    );
  }
}

export function removePnpmLockFile(state: WorkspaceState, logger: Logger): void {
  logger.step('Remove pnpm lockfile');
  if (fs.existsSync(state.lockFile)) {
    assertWithinWorkspace(state, state.lockFile);
    if (state.yaml.dryRun) {
      logger.detail(`Dry-run: would remove ${state.lockFile}`);
    } else {
      fs.rmSync(state.lockFile, { force: true });
      logger.detail(`Removed ${state.lockFile}.`);
    }
  } else {
    logger.detail('No pnpm-lock.yaml found.');
  }
}

export async function removeNodeModulesFolders(
  state: WorkspaceState,
  logger: Logger,
): Promise<void> {
  logger.step('Remove node_modules directories');
  let dirs: string[];
  if (state.isMultiPackageWorkspace) {
    dirs = findNodeModulesFolders(state.workspaceRoot);
  } else {
    // Single-package mode: only the workspace root's own node_modules is
    // eligible. The mode banner is emitted once in `prepareRun`.
    const rootNodeModules = path.join(state.workspaceRoot, 'node_modules');
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
    assertWithinWorkspace(state, dir);
    processedCount += 1;
    spinner.update(processedCount);
    // On Windows, `rd /s /q` is dramatically faster than recursive rm for
    // deep node_modules trees; on macOS/Linux fall through to fs.promises.rm.
    if (process.platform === 'win32') {
      await spawnAsync('cmd', ['/c', 'rd', '/s', '/q', dir]);
    }
    if (await pathExists(dir)) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // fall through to warning
      }
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
