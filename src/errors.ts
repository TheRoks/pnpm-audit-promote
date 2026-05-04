/**
 * Typed error classes thrown by `refreshDeps` and supporting modules.
 * Library consumers can branch on `instanceof` rather than regex-matching
 * `error.message`. Each class preserves the original message text so
 * existing log output is unchanged.
 */

/** Thrown when no `pnpm-workspace.yaml` is found at the configured path. */
export class WorkspaceNotFoundError extends Error {
  constructor(public readonly workspaceYamlPath: string) {
    super(`pnpm-workspace.yaml not found at '${workspaceYamlPath}'. Pass --path <workspace root>.`);
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
