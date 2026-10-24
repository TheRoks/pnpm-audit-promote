import * as fs from 'node:fs';
import * as path from 'node:path';
import { EnclosingWorkspaceError, WorkspaceNotFoundError } from '../errors';
import { findPackageManifest, readPackageManifest } from './packageManifest';

export interface WorkspaceIdentity {
  workspaceRoot: string;
  lockFile: string;
  workspaceYaml: string;
  rootPackageJson: string;
  rootPackageManifest: string | null;
  hasWorkspaceYaml: boolean;
  isMultiPackageWorkspace: boolean;
}

export function discoverWorkspace(
  workspacePath: string,
  options: { ignoreParentWorkspace?: boolean } = {},
): WorkspaceIdentity {
  const workspaceRoot = path.resolve(workspacePath);
  const workspaceYaml = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  const lockFile = path.join(workspaceRoot, 'pnpm-lock.yaml');
  const rootPackageJson = path.join(workspaceRoot, 'package.json');
  const rootManifest = findPackageManifest(workspaceRoot);
  const hasWorkspaceYaml = fs.existsSync(workspaceYaml);
  const rootPackage = readManifestFile(rootManifest);

  if (!hasWorkspaceYaml && !hasPnpmSignal(rootPackage, lockFile)) {
    throw new WorkspaceNotFoundError(workspaceRoot);
  }
  if (!hasWorkspaceYaml && !options.ignoreParentWorkspace) {
    const enclosing = findEnclosingPnpmWorkspaceYaml(workspaceRoot);
    if (enclosing) throw new EnclosingWorkspaceError(workspaceRoot, enclosing);
  }

  return {
    workspaceRoot,
    lockFile,
    workspaceYaml,
    rootPackageJson,
    rootPackageManifest: rootManifest?.path ?? null,
    hasWorkspaceYaml,
    isMultiPackageWorkspace: hasWorkspaceYaml || hasRootWorkspacesField(rootPackage),
  };
}

/**
 * Returns true when `pkgJsonPath` looks like a pnpm-managed project, or when
 * a `pnpm-lock.yaml` sits alongside it. We accept any of:
 *   - `packageManager` field starting with `pnpm@`
 *   - `devEngines.packageManager` naming pnpm (string form `pnpm@...` or
 *     object form `{ name: 'pnpm', ... }`); pnpm 11's `pnpm init` writes
 *     this instead of the legacy `packageManager` field.
 *   - a `pnpm` config object (e.g. `pnpm.overrides`)
 *   - a sibling `pnpm-lock.yaml`
 *
 * Receives an already-parsed root `package.json` so workspace discovery only
 * reads the file once. `null` is the "absent or unreadable" signal.
 */
function hasPnpmSignal(rootPkg: unknown, lockFilePath: string): boolean {
  if (fs.existsSync(lockFilePath)) return true;
  if (rootPkg === null || typeof rootPkg !== 'object') return false;
  const parsed = rootPkg as {
    packageManager?: unknown;
    pnpm?: unknown;
    devEngines?: unknown;
  };
  const pm = parsed.packageManager;
  if (typeof pm === 'string' && /^pnpm@/i.test(pm.trim())) return true;
  if (parsed.pnpm !== null && typeof parsed.pnpm === 'object') return true;
  if (devEnginesNamesPnpm(parsed.devEngines)) return true;
  return false;
}

/**
 * Returns true when the root `package.json` declares a non-empty `workspaces`
 * field (npm/yarn-style array, or `{ packages: [...] }` object). pnpm itself
 * ignores this field, but its presence is a clear signal of multi-package
 * intent and is used to distinguish a single-package project from a
 * workspace-without-yaml.
 */
function hasRootWorkspacesField(rootPkg: unknown): boolean {
  if (rootPkg === null || typeof rootPkg !== 'object') return false;
  const ws = (rootPkg as { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) {
    return ws.some((w) => typeof w === 'string' && w.trim().length > 0);
  }
  if (ws !== null && typeof ws === 'object') {
    const packages = (ws as { packages?: unknown }).packages;
    return (
      Array.isArray(packages) && packages.some((w) => typeof w === 'string' && w.trim().length > 0)
    );
  }
  return false;
}

/**
 * Read and parse a JSON file. Returns `null` on any read or parse failure
 * so callers can treat it as "absent or unreadable" without try/catch noise.
 */
function readManifestFile(manifest: ReturnType<typeof findPackageManifest>): unknown {
  if (!manifest) return null;
  try {
    return readPackageManifest(fs.readFileSync(manifest.path, 'utf8'), manifest.format);
  } catch {
    return null;
  }
}

/**
 * Inspect a `devEngines.packageManager` field (pnpm 11+ format) and return
 * true when it names pnpm. Supports both the string form (`"pnpm@11.0.0"`)
 * and the object form (`{ name: "pnpm", version: "11" }`), as well as an
 * array of such entries.
 */
function devEnginesNamesPnpm(devEngines: unknown): boolean {
  if (devEngines === null || typeof devEngines !== 'object') return false;
  const pm = (devEngines as { packageManager?: unknown }).packageManager;
  return packageManagerEntryNamesPnpm(pm);
}

function packageManagerEntryNamesPnpm(entry: unknown): boolean {
  if (typeof entry === 'string') {
    return /^pnpm(@|$)/i.test(entry.trim());
  }
  if (Array.isArray(entry)) {
    return entry.some(packageManagerEntryNamesPnpm);
  }
  if (entry !== null && typeof entry === 'object') {
    const name = (entry as { name?: unknown }).name;
    return typeof name === 'string' && name.trim().toLowerCase() === 'pnpm';
  }
  return false;
}

/**
 * Detect the pnpm major version that the *target* workspace is pinned to,
 * by inspecting its root `package.json`. This is the version that corepack
 * (or the workspace's own toolchain) will actually invoke when we shell out
 * to `pnpm`, which may differ from `pnpm --version` on PATH — most notably
 * when the CLI itself is published with a different pnpm pin than the
 * workspace it operates on.
 *
 * Search order (first non-null wins):
 *   1. `packageManager: "pnpm@<version>"` (legacy field; still authoritative)
 *   2. `devEngines.packageManager` — string form `"pnpm@<version>"` or
 *      object form `{ name: "pnpm", version: "<version>" }`.
 *
 * Returns `null` when the workspace declares no pnpm version pin or when the
 * pin cannot be parsed. Callers should treat `null` as "fall back to other
 * detection" — never as "definitely pnpm 10".
 */
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

/**
 * Parse the target pnpm version's effective audit ignore list from
 * `pnpm-workspace.yaml`. Canonical `audit.ignore` wins when supported;
 * otherwise the recognized legacy `auditConfig` lists are read.
 */
