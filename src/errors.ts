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
 *   - `package.json` whose `packageManager` field starts with `pnpm@`.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(public readonly workspaceRoot: string) {
    super(
      `No pnpm workspace found at '${workspaceRoot}'. Expected pnpm-workspace.yaml or package.json with "packageManager": "pnpm@...". Pass --path <workspace root>.`,
    );
    this.name = 'WorkspaceNotFoundError';
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
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number,
  ) {
    super(`pnpm ${args.join(' ')} failed with exit code ${exitCode}`);
    this.name = 'PnpmCommandFailedError';
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
