/**
 * Typed error classes thrown by `refreshDeps` and supporting modules.
 * Library consumers can branch on `instanceof` rather than regex-matching
 * `error.message`. Each class preserves the original message text so
 * existing log output is unchanged.
 */

/**
 * Thrown when the configured path is not a recognizable pnpm workspace root.
 *
 * A directory qualifies as a workspace root when it contains either:
 *   - `pnpm-workspace.yaml`, or
 *   - `pnpm-lock.yaml`, or
 *   - `package.json` whose `packageManager` field starts with `pnpm@`, or
 *   - `package.json` with a `pnpm` config object (e.g. `pnpm.overrides`).
 */
export class WorkspaceNotFoundError extends Error {
  constructor(public readonly workspaceRoot: string) {
    super(
      `No pnpm workspace found at '${workspaceRoot}'. Expected pnpm-workspace.yaml, pnpm-lock.yaml, or package.json with "packageManager": "pnpm@..." or a "pnpm" config field. Pass --path <workspace root>.`,
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Thrown when the requested path sits inside another pnpm workspace
 * (i.e. an enclosing directory contains `pnpm-workspace.yaml`). Without
 * this guard, `pnpm install` walks upward and mutates the parent
 * workspace's lockfile and `pnpm-workspace.yaml` instead of the directory
 * the user asked us to operate on.
 *
 * Resolve by either:
 *   - re-running with `--path <enclosingWorkspaceRoot>` to operate on the
 *     parent workspace explicitly, or
 *   - re-running with `--ignore-workspace` to keep operations local
 *     (forwarded to every pnpm invocation).
 */
export class EnclosingWorkspaceError extends Error {
  constructor(
    public readonly requestedPath: string,
    public readonly enclosingWorkspaceRoot: string,
  ) {
    super(
      `Refusing to operate on '${requestedPath}': an enclosing pnpm workspace was found at '${enclosingWorkspaceRoot}'. ` +
        `pnpm install would mutate that parent workspace's pnpm-workspace.yaml and pnpm-lock.yaml. ` +
        `Re-run with --path '${enclosingWorkspaceRoot}' to operate on the parent, or pass --ignore-workspace to keep all operations local to '${requestedPath}'.`,
    );
    this.name = 'EnclosingWorkspaceError';
  }
}

/** Thrown when `pnpm` is not on PATH or fails to launch. */
export class PnpmNotInstalledError extends Error {
  constructor() {
    super('pnpm is not installed or not on PATH.');
    this.name = 'PnpmNotInstalledError';
  }
}

/** Thrown when a `pnpm <args>` invocation exits with a non-zero status. */
export class PnpmCommandFailedError extends Error {
  public readonly stderr: string;
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number,
    stderr = '',
  ) {
    const trimmed = stderr.trim();
    const suffix = trimmed ? `\n--- pnpm stderr ---\n${trimmed}\n--- end pnpm stderr ---` : '';
    super(`pnpm ${args.join(' ')} failed with exit code ${exitCode}${suffix}`);
    this.name = 'PnpmCommandFailedError';
    this.stderr = trimmed;
  }
}

/**
 * Thrown when destructive operations are requested in a non-interactive
 * environment without `--force`.
 */
export class NonInteractiveConfirmationError extends Error {
  constructor() {
    super('Refusing to run destructive operations non-interactively. Re-run with --force.');
    this.name = 'NonInteractiveConfirmationError';
  }
}

/** Thrown when `pnpm-workspace.yaml` exists but cannot be read (e.g. permission
 * error). Identifies the file path so the caller can surface it to the user. */
export class WorkspaceReadError extends Error {
  constructor(
    public readonly filePath: string,
    cause?: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot read workspace file '${filePath}': ${detail}`);
    this.name = 'WorkspaceReadError';
  }
}
