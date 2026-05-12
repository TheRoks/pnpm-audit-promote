import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { Logger } from './logger';
import { PRUNED_DIR_NAMES } from './fsWalk';
import { EnclosingWorkspaceError, WorkspaceNotFoundError } from './errors';
import {
  forceMinimumReleaseAgeZero,
  getTopLevelScalar,
  hasTopLevelKey,
  restoreMinimumReleaseAge,
} from './workspaceYamlPnpm11';

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
   * True when the workspace is a multi-package workspace, i.e. either
   * `pnpm-workspace.yaml` exists at the root, or the root `package.json`
   * declares a non-empty `workspaces` array. When false, the project is a
   * single-package project: recursive operations
   * (`removeNodeModulesFolders`, `removePackageJsonOverrides`, audit
   * direct-dep package.json bumps) are confined to the root directory and
   * must not touch nested unrelated projects.
   */
  isMultiPackageWorkspace = false;

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

  /**
   * Major version of the pnpm binary on PATH (10, 11, ...). `null` when
   * detection failed or has not been performed yet. Set once via
   * {@link recordPnpmMajor} during `prepareRun`. pnpm 11 triggers
   * extra workspace-yaml handling (see {@link applyPnpm11WorkspaceTweaks}).
   */
  pnpmMajor: number | null = null;

  /**
   * Truly-original pnpm-workspace.yaml content as written by the user. Unlike
   * `desiredWorkspaceYaml` this is never patched with the pnpm-11 working
   * copy modifications (e.g. forced `minimumReleaseAge: 0`). Used to restore
   * the user's exact configuration at the end of the run.
   */
  originalWorkspaceYaml = '';

  /**
   * Captured original value of the top-level `minimumReleaseAge` scalar, or
   * `null` when the user had no such key. Used to undo the temporary
   * `minimumReleaseAge: 0` injection at the end of a pnpm-11 run.
   */
  originalMinimumReleaseAge: string | null = null;

  /**
   * True when {@link applyPnpm11WorkspaceTweaks} injected `minimumReleaseAge: 0`
   * for the duration of the run. Drives the matching cleanup step.
   */
  pnpm11TweaksApplied = false;

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
    // Parse the root package.json at most once, then derive every signal
    // we need from the same parsed object. `null` means absent or unreadable.
    const rootPkg = readJsonFile(ws.rootPackageJson);
    if (!yamlExists && !hasPnpmSignal(rootPkg, ws.lockFile)) {
      throw new WorkspaceNotFoundError(root);
    }
    if (!yamlExists && !options.ignoreParentWorkspace) {
      const enclosing = findEnclosingPnpmWorkspaceYaml(root);
      if (enclosing) {
        throw new EnclosingWorkspaceError(root, enclosing);
      }
    }
    ws.hasWorkspaceYaml = yamlExists;
    ws.isMultiPackageWorkspace = yamlExists || hasRootWorkspacesField(rootPkg);
    ws.dryRun = options.dryRun ?? false;
    if (yamlExists) {
      ws.detectEol();
      // Initialize the desired snapshot from the current file so that
      // `restoreWorkspaceYaml` is safe before any cleanup step has run.
      ws.desiredWorkspaceYaml = ws.readWorkspaceYaml();
      ws.originalWorkspaceYaml = ws.desiredWorkspaceYaml;
    }
    return ws;
  }

  /**
   * Record the detected pnpm major version. Caller should invoke this once,
   * after the {@link PnpmRunner} has been created but before any pnpm
   * command runs, so subsequent steps see a consistent value.
   */
  recordPnpmMajor(major: number | null): void {
    this.pnpmMajor = major;
  }

  /**
   * pnpm 11 ships several defaults that interfere with audit-driven catalog
   * promotion. Most notably, `minimumReleaseAge` defaults to 1440 (1 day),
   * which blocks `pnpm audit --fix` from picking up freshly-published patch
   * releases. This method installs a working copy of `pnpm-workspace.yaml`
   * with `minimumReleaseAge: 0` for the duration of the run; the original
   * value is restored by {@link revertPnpm11WorkspaceTweaks}.
   *
   * No-op when pnpm major is not 11+, when no `pnpm-workspace.yaml` exists,
   * or when the workspace state is in dry-run mode (writes are suppressed).
   */
  applyPnpm11WorkspaceTweaks(logger: Logger): void {
    if (this.pnpm11TweaksApplied) return;
    if (this.pnpmMajor === null || this.pnpmMajor < 11) return;
    if (!this.hasWorkspaceYaml) return;
    // Capture the user-intended value (if any) and patch the working copy.
    this.originalMinimumReleaseAge = getTopLevelScalar(
      this.originalWorkspaceYaml,
      'minimumReleaseAge',
    );
    // Only proceed when the original is a plain scalar (or absent). If the
    // key exists as a block mapping, leave it alone — pnpm rejects scalar
    // forms in that shape and we don't want to corrupt the file.
    if (
      this.originalMinimumReleaseAge === null &&
      hasTopLevelKey(this.originalWorkspaceYaml, 'minimumReleaseAge')
    ) {
      logger.detail('Detected `minimumReleaseAge` as a block — leaving pnpm 11 defaults in place.');
      return;
    }
    this.desiredWorkspaceYaml = forceMinimumReleaseAgeZero(this.desiredWorkspaceYaml);
    this.saveWorkspaceYaml(this.desiredWorkspaceYaml);
    this.pnpm11TweaksApplied = true;
    logger.detail(
      this.originalMinimumReleaseAge === null
        ? 'pnpm 11 detected: temporarily set `minimumReleaseAge: 0` for this run.'
        : `pnpm 11 detected: temporarily overrode \`minimumReleaseAge\` (was ${this.originalMinimumReleaseAge}) for this run.`,
    );
  }

  /**
   * Undo {@link applyPnpm11WorkspaceTweaks}. Restores the user's original
   * `minimumReleaseAge` value in the on-disk file (or removes the injected
   * line entirely when the user had no such key). Safe to call when no
   * tweaks were applied.
   */
  revertPnpm11WorkspaceTweaks(logger: Logger): void {
    if (!this.pnpm11TweaksApplied) return;
    if (!this.hasWorkspaceYaml) return;
    const current = this.readWorkspaceYaml();
    const restored = restoreMinimumReleaseAge(current, this.originalMinimumReleaseAge);
    if (restored !== current) {
      this.desiredWorkspaceYaml = restored;
      this.saveWorkspaceYaml(restored);
      logger.detail(
        this.originalMinimumReleaseAge === null
          ? 'Reverted temporary `minimumReleaseAge: 0` override.'
          : `Restored original \`minimumReleaseAge: ${this.originalMinimumReleaseAge}\`.`,
      );
    }
    this.pnpm11TweaksApplied = false;
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
   * Re-check whether `pnpm-workspace.yaml` exists on disk and update the
   * `hasWorkspaceYaml` flag accordingly. Useful after pnpm itself may have
   * created the file mid-run (notably `pnpm 11 audit --fix override`, which
   * writes its overrides to a new pnpm-workspace.yaml even when one did not
   * exist before).
   *
   * Returns `true` when the flag flipped from `false` to `true`. On that
   * transition, captures the freshly-written content as both the
   * `originalWorkspaceYaml` baseline (empty — there was no prior content)
   * and the `desiredWorkspaceYaml` working snapshot, and re-runs EOL
   * detection so subsequent writes preserve the file's line endings.
   */
  refreshHasWorkspaceYaml(): boolean {
    if (this.hasWorkspaceYaml) return false;
    if (!fs.existsSync(this.workspaceYaml)) return false;
    this.hasWorkspaceYaml = true;
    this.detectEol();
    // Keep the original snapshot empty: from this run's perspective, there
    // was no prior pnpm-workspace.yaml — pnpm created it mid-run.
    this.originalWorkspaceYaml = '';
    this.desiredWorkspaceYaml = fs.readFileSync(this.workspaceYaml, 'utf8');
    return true;
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
 *   - `devEngines.packageManager` naming pnpm (string form `pnpm@...` or
 *     object form `{ name: 'pnpm', ... }`); pnpm 11's `pnpm init` writes
 *     this instead of the legacy `packageManager` field.
 *   - a `pnpm` config object (e.g. `pnpm.overrides`)
 *   - a sibling `pnpm-lock.yaml`
 *
 * Receives an already-parsed root `package.json` so {@link WorkspaceState.initialize}
 * only reads the file once. `null` is the "absent or unreadable" signal.
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
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
export function detectWorkspacePnpmMajor(pkgJsonPath: string): number | null {
  let parsed: {
    packageManager?: unknown;
    devEngines?: unknown;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as typeof parsed;
  } catch {
    return null;
  }
  return (
    extractMajorFromPackageManager(parsed.packageManager) ??
    extractMajorFromDevEngines(parsed.devEngines)
  );
}

function extractMajorFromPackageManager(pm: unknown): number | null {
  if (typeof pm !== 'string') return null;
  const trimmed = pm.trim();
  // Accept `pnpm@10.33.0`, `pnpm@v11.0.0`, `pnpm@11`, and
  // `pnpm@11.0.0+sha512-...` —
  // corepack/pnpm allow an optional `+<integrity>` suffix after the version.
  const match = /^pnpm@v?(\d+)(?:[.\s+]|$)/i.exec(trimmed);
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  return Number.isFinite(major) ? major : null;
}

function extractMajorFromDevEngines(devEngines: unknown): number | null {
  if (devEngines === null || typeof devEngines !== 'object') return null;
  const pm = (devEngines as { packageManager?: unknown }).packageManager;
  return extractMajorFromDevEnginesEntry(pm);
}

function extractMajorFromDevEnginesEntry(entry: unknown): number | null {
  if (typeof entry === 'string') {
    // Same shape as the legacy `packageManager` field (e.g. `pnpm@11`,
    // `pnpm@^11.0.0`). Reuse the parser; range operators before the digits
    // are not produced by `pnpm init` for the string form, so a strict
    // `pnpm@<digits>.` match here is sufficient — but we relax it to also
    // accept a bare `pnpm@11` (no trailing dot) since users do write that.
    const trimmed = entry.trim();
    const m = /^pnpm@v?(\d+)(?:[.\s]|$)/i.exec(trimmed);
    if (!m) return null;
    const major = Number.parseInt(m[1]!, 10);
    return Number.isFinite(major) ? major : null;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const v = extractMajorFromDevEnginesEntry(item);
      if (v !== null) return v;
    }
    return null;
  }
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as { name?: unknown; version?: unknown };
    if (typeof obj.name !== 'string' || obj.name.trim().toLowerCase() !== 'pnpm') return null;
    if (typeof obj.version !== 'string') return null;
    // Strip optional range operators (`^`, `~`, `>=`, etc.) before parsing
    // the major. `>=11.0.0` and `^11` both resolve to 11.
    const match = /v?(\d+)\b/.exec(obj.version);
    if (!match) return null;
    const major = Number.parseInt(match[1]!, 10);
    return Number.isFinite(major) ? major : null;
  }
  return null;
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
