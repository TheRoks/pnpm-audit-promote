import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDetailLoggingEnabled, type Logger } from './logger.js';
import type { WorkspaceState } from './workspace.js';
import { resolveWorkspacePackageDirs } from './workspace.js';
import { findNodeModulesFolders, findWorkspaceFiles } from './fsWalk.js';
import { findMatchingBrace, removeJsonProperty } from './jsonEdit.js';
import { collapseBlankLines } from './catalog.js';

export function removePnpmLockFile(state: WorkspaceState, logger: Logger): void {
  logger.step('Remove pnpm lockfile');
  if (fs.existsSync(state.lockFile)) {
    if (state.dryRun) {
      logger.detail(`Dry-run: would remove ${state.lockFile}`);
    } else {
      fs.rmSync(state.lockFile, { force: true });
      logger.detail(`Removed ${state.lockFile}.`);
    }
  } else {
    logger.detail('No pnpm-lock.yaml found.');
  }
}

export function removeNodeModulesFolders(state: WorkspaceState, logger: Logger): void {
  logger.step('Remove node_modules directories');
  const dirs = findNodeModulesFolders(state.workspaceRoot);
  if (dirs.length === 0) {
    logger.detail('No node_modules directories found.');
    return;
  }

  const spinner = createCleanupSpinner({
    enabled: !state.dryRun && Boolean(process.stdout.isTTY) && isDetailLoggingEnabled(logger),
    total: dirs.length,
  });
  spinner.start();

  let removedCount = 0;
  let processedCount = 0;
  for (const dir of dirs) {
    if (state.dryRun) {
      logger.detail(`Dry-run: would remove ${dir}`);
      continue;
    }
    processedCount += 1;
    spinner.update(processedCount);
    // On Windows, `rd /s /q` is dramatically faster than recursive rm for
    // deep node_modules trees; on macOS/Linux fall through to fs.rmSync.
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', dir], { stdio: 'ignore' });
    }
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // fall through to warning
      }
    }
    if (fs.existsSync(dir)) {
      logger.warn(`Could not fully remove ${dir} (possibly locked by another process).`);
    } else {
      removedCount += 1;
      spinner.update(removedCount);
    }
  }

  spinner.stop();
  if (!state.dryRun) {
    logger.detail(`Removed ${removedCount}/${dirs.length} node_modules directories.`);
  }
}

/**
 * Strip the `overrides:` block from pnpm-workspace.yaml and store the desired
 * content in `state.desiredWorkspaceYaml`.
 */
export function removeWorkspaceOverridesBlock(state: WorkspaceState, logger: Logger): void {
  logger.step("Remove workspace 'overrides:' block");

  const original = state.readWorkspaceYaml();
  // Match the overrides block and any blank line that immediately follows it,
  // so removal does not leave a stray blank line behind.
  const pattern = /^overrides:[ \t]*\r?\n(?:[ \t]+\S.*\r?\n?)*(?:\r?\n)?/m;

  let desired: string;
  if (pattern.test(original)) {
    desired = original.replace(pattern, '');
    desired = collapseBlankLines(desired);
    desired = desired.replace(/[\r\n]+$/, '') + state.yamlEol;
    logger.detail("Removed 'overrides:' block from pnpm-workspace.yaml.");
  } else {
    desired = original;
    logger.detail("No 'overrides:' block found in pnpm-workspace.yaml.");
  }

  state.desiredWorkspaceYaml = desired;
  state.saveWorkspaceYaml(desired);
}

/**
 * Strip `pnpm.overrides` from every package.json in the workspace.
 * Direct-dep vulnerabilities are solved in the catalog, not via overrides;
 * transitive-only overrides will be re-added by `pnpm audit --fix` later, and
 * any catalog-eligible ones are then promoted into the catalog.
 */
export function removePackageJsonOverrides(state: WorkspaceState, logger: Logger): void {
  logger.step("Remove 'pnpm.overrides' from package.json files");

  const packageDirs = resolveWorkspacePackageDirs(state);
  const packageJsons = findWorkspaceFiles(state.workspaceRoot, 'package.json').filter(
    (pjPath) => packageDirs === null || packageDirs.has(path.dirname(pjPath)),
  );

  for (const pjPath of packageJsons) {
    let text: string;
    try {
      text = fs.readFileSync(pjPath, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('"overrides"')) continue;

    const original = text;
    const pnpmStart = /"pnpm"\s*:\s*\{/.exec(text);
    if (!pnpmStart) continue;

    const pnpmOpen = pnpmStart.index + pnpmStart[0].length - 1;
    const pnpmClose = findMatchingBrace(text, pnpmOpen);
    if (pnpmClose <= 0) continue;

    const pnpmBody = text.slice(pnpmOpen + 1, pnpmClose);
    const cleanedBody = removeJsonProperty(pnpmBody, 'overrides');
    if (cleanedBody === pnpmBody) continue;

    text = text.slice(0, pnpmOpen + 1) + cleanedBody + text.slice(pnpmClose);
    if (/^\s*$/.test(cleanedBody)) {
      text = removeJsonProperty(text, 'pnpm');
    }

    if (text === original) continue;

    try {
      JSON.parse(text);
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: post-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }

    // Normalize trailing whitespace to exactly one newline.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.replace(/[\s]+$/, '') + eol;
    if (!state.dryRun) {
      fs.writeFileSync(pjPath, text, { encoding: 'utf8' });
    }
    const rel = path.relative(state.workspaceRoot, pjPath);
    logger.detail(
      `${state.dryRun ? 'Dry-run: would remove' : 'Removed'} pnpm.overrides from ${rel}.`,
    );
  }
}

function createCleanupSpinner(options: {
  enabled: boolean;
  total: number;
}): { start: () => void; update: (processed: number) => void; stop: () => void } {
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
