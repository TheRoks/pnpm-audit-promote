import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { PRUNED_DIR_NAMES } from '../fsWalk';
import type { WorkspacePaths } from '../workspace';
import { readPackageManifestFile } from './packageManifest';

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
export interface WorkspacePackageScopeSource {
  paths: WorkspacePaths;
  yaml: { readWorkspaceYaml(): string };
}

export function resolveWorkspacePackageDirs(
  state: WorkspacePackageScopeSource,
): Set<string> | null {
  let patterns: string[] | null = null;

  // 1. pnpm-workspace.yaml packages:
  try {
    patterns = extractYamlPackagesGlobs(state.yaml.readWorkspaceYaml());
  } catch {
    // ignore
  }

  // 2. Root package.json "workspaces" (fallback)
  if (!patterns) {
    try {
      const pkg = state.paths.rootPackageManifest
        ? readPackageManifestFile(state.paths.rootPackageManifest)
        : null;
      const workspaces = pkg?.['workspaces'];
      const workspaceGlobs = Array.isArray(workspaces)
        ? workspaces
        : workspaces !== null && typeof workspaces === 'object'
          ? (workspaces as { packages?: unknown }).packages
          : null;
      if (Array.isArray(workspaceGlobs)) {
        const ws = workspaceGlobs.filter((x): x is string => typeof x === 'string');
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
  result.add(state.paths.workspaceRoot); // root package.json is always in scope

  // Index-based loop (O(1) per iteration) avoids the O(n) cost of Array.shift().
  const queue = [state.paths.workspaceRoot];
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
      const rel = path.relative(state.paths.workspaceRoot, full).split(path.sep).join('/');
      const matched = posMatchers.some((m) => m(rel)) && !negMatchers.some((m) => m(rel));
      if (matched) {
        result.add(full);
      }
      queue.push(full);
    }
  }

  return result;
}
