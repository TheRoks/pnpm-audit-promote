import * as fs from 'node:fs';
import * as path from 'node:path';

export const PRUNED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.nx',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
]);

/**
 * Find every `node_modules` folder under `root`, without descending into
 * `node_modules` or other large generated folders.
 */
export function findNodeModulesFolders(root: string): string[] {
  const results: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(current, e.name);
      if (e.name === 'node_modules') {
        results.push(full);
        continue;
      }
      if (PRUNED_DIR_NAMES.has(e.name)) continue;
      queue.push(full);
    }
  }
  return results;
}

/**
 * Find all files matching `fileName` under `root`, pruning traversal at the
 * same large generated folders. Returns absolute paths.
 */
export function findWorkspaceFiles(root: string, fileName: string): string[] {
  const results: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && e.name === fileName) {
        results.push(full);
      } else if (e.isDirectory()) {
        if (PRUNED_DIR_NAMES.has(e.name)) continue;
        queue.push(full);
      }
    }
  }
  return results;
}
