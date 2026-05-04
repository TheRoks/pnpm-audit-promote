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
 * Walk `root` breadth-first, pruning traversal at large generated folders,
 * invoking `visit` for each entry. The visitor controls whether to descend
 * by inspecting and returning, and whether to record matches by pushing
 * onto its captured `results` array. Uses an index-based queue (O(1)
 * dequeue) so traversal is linear in the number of entries even on large
 * monorepos.
 */
function bfsWalk(root: string, visit: (entry: fs.Dirent, fullPath: string) => boolean): void {
  const queue: string[] = [root];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory() && PRUNED_DIR_NAMES.has(e.name)) {
        // Still let the visitor record/inspect (e.g. node_modules itself)
        // before we decide not to descend.
        if (visit(e, full)) queue.push(full);
        continue;
      }
      if (visit(e, full) && e.isDirectory()) {
        queue.push(full);
      }
    }
  }
}

/**
 * Find every `node_modules` folder under `root`, without descending into
 * `node_modules` or other large generated folders.
 */
export function findNodeModulesFolders(root: string): string[] {
  const results: string[] = [];
  bfsWalk(root, (e, full) => {
    if (!e.isDirectory()) return false;
    if (e.name === 'node_modules') {
      results.push(full);
      return false; // do not descend into the matched node_modules
    }
    return !PRUNED_DIR_NAMES.has(e.name);
  });
  return results;
}

/**
 * Find all files matching `fileName` under `root`, pruning traversal at the
 * same large generated folders. Returns absolute paths.
 */
export function findWorkspaceFiles(root: string, fileName: string): string[] {
  const results: string[] = [];
  bfsWalk(root, (e, full) => {
    if (e.isFile() && e.name === fileName) {
      results.push(full);
      return false;
    }
    if (e.isDirectory()) return !PRUNED_DIR_NAMES.has(e.name);
    return false;
  });
  return results;
}
