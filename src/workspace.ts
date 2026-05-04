import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logger.js';
import { PRUNED_DIR_NAMES } from './fsWalk.js';

/**
 * Mutable per-run workspace state, populated once and read by helper modules.
 */
export class WorkspaceState {
  readonly workspaceRoot: string;
  readonly lockFile: string;
  readonly workspaceYaml: string;
  readonly rootPackageJson: string;

  /**
   * Snapshot of the *desired* pnpm-workspace.yaml content. Re-applied after
   * every pnpm command, because pnpm 10 normalizes the file on install/up
   * and silently drops settings (e.g. `savePrefix: ''`) and bumps catalog
   * versions.
   */
  desiredWorkspaceYaml = '';

  /** Dominant EOL used by pnpm-workspace.yaml — preserved across rewrites. */
  yamlEol: '\r\n' | '\n' = '\n';

  /** When true, `saveWorkspaceYaml` and writes are no-ops. */
  dryRun = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.lockFile = path.join(workspaceRoot, 'pnpm-lock.yaml');
    this.workspaceYaml = path.join(workspaceRoot, 'pnpm-workspace.yaml');
    this.rootPackageJson = path.join(workspaceRoot, 'package.json');
  }

  static initialize(workspacePath: string, options: { dryRun?: boolean } = {}): WorkspaceState {
    const root = path.resolve(workspacePath);
    const ws = new WorkspaceState(root);
    if (!fs.existsSync(ws.workspaceYaml)) {
      throw new Error(
        `pnpm-workspace.yaml not found at '${ws.workspaceYaml}'. Pass --path <workspace root>.`,
      );
    }
    ws.dryRun = options.dryRun ?? false;
    ws.detectEol();
    // Initialize the desired snapshot from the current file so that
    // `restoreWorkspaceYaml` is safe before any cleanup step has run.
    ws.desiredWorkspaceYaml = ws.readWorkspaceYaml();
    return ws;
  }

  detectEol(): void {
    try {
      const content = fs.readFileSync(this.workspaceYaml, 'utf8');
      this.yamlEol = content.includes('\r\n') ? '\r\n' : '\n';
    } catch {
      // keep default
    }
  }

  readWorkspaceYaml(): string {
    return fs.readFileSync(this.workspaceYaml, 'utf8');
  }

  saveWorkspaceYaml(content: string): void {
    if (this.dryRun) return;
    fs.writeFileSync(this.workspaceYaml, content, 'utf8');
  }

  /**
   * If pnpm has rewritten pnpm-workspace.yaml since our last snapshot,
   * restore the desired content. Returns true when a restore happened.
   */
  restoreWorkspaceYaml(logger: Logger): boolean {
    if (!this.desiredWorkspaceYaml) return false;
    const current = this.readWorkspaceYaml();
    if (current !== this.desiredWorkspaceYaml) {
      logger.detail('Restored pnpm-workspace.yaml after pnpm rewrote it.');
      this.saveWorkspaceYaml(this.desiredWorkspaceYaml);
      return true;
    }
    return false;
  }
}

/** Extract the `packages:` list from pnpm-workspace.yaml text. */
function extractYamlPackagesGlobs(yaml: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const pkgs = (parsed as { packages?: unknown }).packages;
  if (!Array.isArray(pkgs)) return null;
  const globs = pkgs.filter((g): g is string => typeof g === 'string').map((g) => g.trim());
  return globs.length > 0 ? globs : null;
}

/** Returns true when the normalized relative path matches the workspace glob. */
function matchesWorkspaceGlob(relPath: string, pattern: string): boolean {
  // `picomatch` understands the full pnpm/npm-workspaces glob dialect:
  // `**`, `*`, `?`, `{a,b}`, character classes, and escaped specials. The
  // previous hand-rolled regex translator did not support brace expansion
  // and could mismatch nested directories.
  return picomatch.isMatch(relPath, pattern, { dot: true });
}

/**
 * Resolves the set of absolute directory paths for all workspace packages
 * (matched by the `packages:` globs in `pnpm-workspace.yaml` or the
 * `workspaces` field in the root `package.json`).
 *
 * The workspace root itself is always included.
 *
 * Returns `null` when no workspace-package globs are configured, meaning
 * callers should treat every `package.json` in the tree as in-scope.
 */
export function resolveWorkspacePackageDirs(state: WorkspaceState): Set<string> | null {
  let patterns: string[] | null = null;

  // 1. pnpm-workspace.yaml packages:
  try {
    patterns = extractYamlPackagesGlobs(state.readWorkspaceYaml());
  } catch {
    // ignore
  }

  // 2. Root package.json "workspaces" (fallback)
  if (!patterns) {
    try {
      const pkg = JSON.parse(fs.readFileSync(state.rootPackageJson, 'utf8')) as {
        workspaces?: unknown;
      };
      if (Array.isArray(pkg.workspaces)) {
        const ws = (pkg.workspaces as unknown[]).filter((x): x is string => typeof x === 'string');
        if (ws.length > 0) patterns = ws;
      }
    } catch {
      // ignore
    }
  }

  if (!patterns || patterns.length === 0) return null;

  const positiveGlobs = patterns.filter((p) => !p.startsWith('!'));
  const negativeGlobs = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  if (positiveGlobs.length === 0) return null;

  const result = new Set<string>();
  result.add(state.workspaceRoot); // root package.json is always in scope

  const queue = [state.workspaceRoot];
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
      if (PRUNED_DIR_NAMES.has(e.name)) continue;
      const full = path.join(current, e.name);
      const rel = path.relative(state.workspaceRoot, full).split(path.sep).join('/');
      const matched =
        positiveGlobs.some((g) => matchesWorkspaceGlob(rel, g)) &&
        !negativeGlobs.some((g) => matchesWorkspaceGlob(rel, g));
      if (matched) {
        result.add(full);
      }
      queue.push(full);
    }
  }

  return result;
}
