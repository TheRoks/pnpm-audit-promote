import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logger';
import { PRUNED_DIR_NAMES } from './fsWalk';
import { EnclosingWorkspaceError, WorkspaceNotFoundError } from './errors';

/**
 * Mutable per-run workspace state, populated once and read by helper modules.
 */
export class WorkspaceState {
  readonly workspaceRoot: string;
  readonly lockFile: string;
  readonly workspaceYaml: string;
  readonly rootPackageJson: string;
  /**
   * True when `pnpm-workspace.yaml` exists at the workspace root. When false,
   * the workspace was identified solely via `package.json` `packageManager`,
   * and all catalog/workspace-yaml manipulation steps degrade to no-ops
   * (catalogs are a workspace-yaml-only feature in pnpm 10+).
   */
  hasWorkspaceYaml = false;

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

  static initialize(
    workspacePath: string,
    options: { dryRun?: boolean; ignoreParentWorkspace?: boolean } = {},
  ): WorkspaceState {
    const root = path.resolve(workspacePath);
    const ws = new WorkspaceState(root);
    const yamlExists = fs.existsSync(ws.workspaceYaml);
    if (!yamlExists && !hasPnpmSignal(ws.rootPackageJson, ws.lockFile)) {
      throw new WorkspaceNotFoundError(root);
    }
    if (!yamlExists && !options.ignoreParentWorkspace) {
      const enclosing = findEnclosingPnpmWorkspaceYaml(root);
      if (enclosing) {
        throw new EnclosingWorkspaceError(root, enclosing);
      }
    }
    ws.hasWorkspaceYaml = yamlExists;
    ws.dryRun = options.dryRun ?? false;
    if (yamlExists) {
      ws.detectEol();
      // Initialize the desired snapshot from the current file so that
      // `restoreWorkspaceYaml` is safe before any cleanup step has run.
      ws.desiredWorkspaceYaml = ws.readWorkspaceYaml();
    }
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
    if (!this.hasWorkspaceYaml) return '';
    return fs.readFileSync(this.workspaceYaml, 'utf8');
  }

  saveWorkspaceYaml(content: string): void {
    if (this.dryRun) return;
    if (!this.hasWorkspaceYaml) return;
    fs.writeFileSync(this.workspaceYaml, content, 'utf8');
  }

  /**
   * If pnpm has rewritten pnpm-workspace.yaml since our last snapshot,
   * restore the desired content. Returns true when a restore happened.
   */
  restoreWorkspaceYaml(logger: Logger): boolean {
    if (!this.hasWorkspaceYaml) return false;
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

/**
 * Returns true when `pkgJsonPath` looks like a pnpm-managed project, or when
 * a `pnpm-lock.yaml` sits alongside it. We accept any of:
 *   - `packageManager` field starting with `pnpm@`
 *   - a `pnpm` config object (e.g. `pnpm.overrides`)
 *   - a sibling `pnpm-lock.yaml`
 *
 * Returns false on any read/parse failure so callers can treat it as a soft check.
 */
function hasPnpmSignal(pkgJsonPath: string, lockFilePath: string): boolean {
  if (fs.existsSync(lockFilePath)) return true;
  try {
    const text = fs.readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(text) as { packageManager?: unknown; pnpm?: unknown };
    const pm = parsed.packageManager;
    if (typeof pm === 'string' && /^pnpm@/i.test(pm.trim())) return true;
    if (parsed.pnpm !== null && typeof parsed.pnpm === 'object') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Walks parent directories looking for a `pnpm-workspace.yaml`. Returns the
 * absolute directory path that contains it, or `null` when no such ancestor
 * exists. Mirrors pnpm's own upward workspace lookup so we can detect when
 * `pnpm install` would escape the directory the caller asked us to operate
 * on. The starting directory itself is intentionally excluded.
 */
export function findEnclosingPnpmWorkspaceYaml(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return null; // reached filesystem root
    if (fs.existsSync(path.join(parent, 'pnpm-workspace.yaml'))) {
      return parent;
    }
    current = parent;
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

  // Pre-compile matchers once so the loop body only invokes pre-built testers
  // (avoids re-compiling/cache-looking-up the glob pattern per directory).
  const posMatchers = positiveGlobs.map((g) => picomatch(g, { dot: true }));
  const negMatchers = negativeGlobs.map((g) => picomatch(g, { dot: true }));

  const result = new Set<string>();
  result.add(state.workspaceRoot); // root package.json is always in scope

  // Index-based loop (O(1) per iteration) avoids the O(n) cost of Array.shift().
  const queue = [state.workspaceRoot];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
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
      const matched = posMatchers.some((m) => m(rel)) && !negMatchers.some((m) => m(rel));
      if (matched) {
        result.add(full);
      }
      queue.push(full);
    }
  }

  return result;
}
