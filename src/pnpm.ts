import spawn from 'cross-spawn';
import * as path from 'node:path';
import { type Logger } from './logger';
import { PnpmCommandFailedError, PnpmNotInstalledError } from './errors';

export interface PnpmRunner {
  /** Run pnpm and throw on non-zero exit. */
  run(args: string[]): Promise<void>;
  /** Run pnpm and return its captured stdout. Does not throw on non-zero. */
  capture(args: string[]): Promise<{ stdout: string; exitCode: number }>;
  /** Run pnpm without throwing on non-zero exit. */
  runAllowFail(args: string[]): Promise<number>;
  /**
   * Return the pnpm version string reported by `pnpm --version` (e.g. `10.33.0`
   * or `11.0.0`). Cached after the first call. Returns an empty string when
   * pnpm is unavailable or its output cannot be read.
   */
  version(): Promise<string>;
}

/**
 * Parse a pnpm version string (`10.33.0`, `11.0.0-rc.1`, ...) into its major
 * component. Returns `null` when the input cannot be interpreted, which the
 * caller should treat as "pnpm 10 (legacy) behavior".
 */
export function getPnpmMajor(version: string): number | null {
  const trimmed = version.trim();
  if (!trimmed) return null;
  const match = /^v?(\d+)\./.exec(trimmed);
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  return Number.isFinite(major) ? major : null;
}

const PNPM = 'pnpm';

// `cross-spawn` resolves Windows `.cmd`/`.bat` shims and escapes arguments
// safely without using `shell: true` (avoiding Node's DEP0190 deprecation).

export interface PnpmOptions {
  cwd: string;
  logger: Logger;
  /** When true, stream raw pnpm stdout/stderr to the terminal. */
  inheritOutput?: boolean;
  /** When true, render a single-line spinner in TTY while commands run. */
  spinner?: boolean;
  /** Milliseconds between progress heartbeats when output is hidden. */
  progressIntervalMs?: number;
  /** When true, log commands but do not execute pnpm. Captures return empty stdout. */
  dryRun?: boolean;
  /**
   * Additional arguments appended to every pnpm invocation. Used to forward
   * flags like `--ignore-workspace` so pnpm doesn't walk up to a parent
   * workspace.
   */
  extraArgs?: readonly string[];
  /** Optional explicit absolute path to the pnpm executable. */
  pnpmPath?: string;
  /**
   * Number of automatic retries for `pnpm install` on non-zero exit.
   * Defaults to 1 to absorb transient registry/network flakiness in CI.
   */
  installRetries?: number;
}

export function createPnpmRunner({
  cwd,
  logger,
  inheritOutput = false,
  spinner = true,
  progressIntervalMs = 20_000,
  dryRun = false,
  extraArgs = [],
  pnpmPath,
  installRetries = 1,
}: PnpmOptions): PnpmRunner {
  const executable = resolvePnpmPathOrThrow(pnpmPath);
  const withExtras = (args: string[]): string[] =>
    extraArgs.length > 0 ? [...args, ...extraArgs] : args;
  let cachedVersion: string | undefined;
  return {
    async version() {
      if (cachedVersion !== undefined) return cachedVersion;
      if (dryRun) {
        cachedVersion = '';
        return cachedVersion;
      }
      cachedVersion = await new Promise<string>((resolve) => {
        const child = spawn(PNPM, ['--version'], {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(stdout.trim()));
      });
      return cachedVersion;
    },
    async run(args) {
      const finalArgs = withExtras(args);
      logger.trace?.(`${dryRun ? '(dry-run) ' : ''}pnpm ${finalArgs.join(' ')}`);
      if (dryRun) return;
      const maxAttempts = isInstallCommand(finalArgs) ? Math.max(0, installRetries) + 1 : 1;
      let lastCode = 0;
      let lastStderr = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await runWithProgress({
          args: finalArgs,
          logger,
          enabled: !inheritOutput,
          spinner,
          progressIntervalMs,
          execute: () => spawnPnpm(executable, finalArgs, { cwd, inheritOutput }),
        });
        lastCode = result.code;
        lastStderr = result.stderr;
        if (result.code === 0) {
          return;
        }
        if (attempt < maxAttempts) {
          logger.warn(
            `pnpm ${finalArgs.join(' ')} failed with exit code ${result.code}; retrying (${attempt}/${maxAttempts - 1}).`,
          );
        }
      }
      throw new PnpmCommandFailedError(finalArgs, lastCode, lastStderr);
    },
    async runAllowFail(args) {
      const finalArgs = withExtras(args);
      logger.trace?.(`${dryRun ? '(dry-run) ' : ''}pnpm ${finalArgs.join(' ')}`);
      if (dryRun) return 0;
      const result = await runWithProgress({
        args: finalArgs,
        logger,
        enabled: !inheritOutput,
        spinner,
        progressIntervalMs,
        execute: () => spawnPnpm(executable, finalArgs, { cwd, inheritOutput }),
      });
      return result.code;
    },
    async capture(args) {
      const finalArgs = withExtras(args);
      if (dryRun) {
        logger.trace?.(`(dry-run) pnpm ${finalArgs.join(' ')} (capture)`);
        return { stdout: '', exitCode: 0 };
      }
      return new Promise((resolve, reject) => {
        const child = spawn(executable, finalArgs, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ stdout, exitCode: code ?? 0 });
        });
      });
    },
  };
}

interface SpawnResult {
  code: number;
  stderr: string;
}

async function runWithProgress(options: {
  args: string[];
  logger: Logger;
  enabled: boolean;
  spinner: boolean;
  progressIntervalMs: number;
  execute: () => Promise<SpawnResult>;
}): Promise<SpawnResult> {
  const { args, logger, enabled, spinner, progressIntervalMs, execute } = options;
  if (!enabled) {
    return execute();
  }

  if (!logger.showsDetails()) {
    return execute();
  }

  const command = `pnpm ${args.join(' ')}`;
  const spinnerController = createSpinner({
    command,
    enabled: spinner && Boolean(process.stdout.isTTY),
  });
  if (spinnerController.enabled) {
    spinnerController.start();
  } else {
    logger.detail(`Running ${command}...`);
  }

  const heartbeat = setInterval(() => {
    if (spinnerController.enabled) {
      spinnerController.update();
    } else {
      logger.detail(`Still running ${command}...`);
    }
  }, progressIntervalMs);
  heartbeat.unref?.();

  try {
    const result = await execute();
    spinnerController.stop();
    logger.detail(
      result.code === 0
        ? `Completed ${command}.`
        : `${command} completed with exit code ${result.code}.`,
    );
    return result;
  } catch (error) {
    spinnerController.stop();
    logger.detail(`${command} failed.`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function createSpinner(options: { command: string; enabled: boolean }): {
  enabled: boolean;
  start: () => void;
  update: () => void;
  stop: () => void;
} {
  const { command, enabled } = options;
  if (!enabled) {
    return {
      enabled: false,
      start() {},
      update() {},
      stop() {},
    };
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const label = toSpinnerLabel(command);
  let frameIndex = 0;
  let spinnerTimer: NodeJS.Timeout | undefined;

  const render = (): void => {
    const frame = frames[frameIndex % frames.length] ?? '•';
    frameIndex += 1;
    process.stdout.write(`\r\x1b[2K${frame} ${label}`);
  };

  return {
    enabled: true,
    start(): void {
      render();
      spinnerTimer = setInterval(() => {
        render();
      }, 120);
      spinnerTimer.unref?.();
    },
    update(): void {
      render();
    },
    stop(): void {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = undefined;
      }
      process.stdout.write('\r\x1b[2K');
    },
  };
}

function toSpinnerLabel(command: string): string {
  if (command === 'pnpm install') return 'Installing dependencies';
  if (command === 'pnpm dedupe') return 'Optimizing dependency graph';
  if (command === 'pnpm audit --fix' || command.startsWith('pnpm audit --fix ')) {
    return 'Applying security fixes';
  }
  const shortCommand = command.startsWith('pnpm ') ? command.slice(5) : command;
  return `Running ${shortCommand}`;
}

function isInstallCommand(args: readonly string[]): boolean {
  return args[0] === 'install';
}

function spawnPnpm(
  executable: string,
  args: string[],
  opts: { cwd: string; inheritOutput: boolean },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // When inheriting, output goes straight to the parent terminal and we
    // cannot capture it. Otherwise, pipe both stdout and stderr so failures
    // can be reported with the actual pnpm error text instead of an opaque
    // exit code (pnpm frequently emits ERR_PNPM_* messages on stdout).
    const child = spawn(executable, args, {
      cwd: opts.cwd,
      stdio: opts.inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let captured = '';
    const append = (chunk: Buffer): void => {
      if (captured.length < 64_000) {
        captured += chunk.toString('utf8');
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new PnpmNotInstalledError());
      } else {
        reject(err);
      }
    });
    child.on('close', (code: number | null) => resolve({ code: code ?? 0, stderr: captured }));
  });
}

/**
 * Verify pnpm is on PATH by running `pnpm --version`. Throws if pnpm is
 * missing or fails to launch.
 */
export async function ensurePnpmAvailable(pnpmPath?: string): Promise<void> {
  const executable = resolvePnpmPathOrThrow(pnpmPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: 'ignore' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new PnpmNotInstalledError());
      } else {
        reject(err);
      }
    });
    child.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new PnpmNotInstalledError());
    });
  });
}

function resolvePnpmPathOrThrow(pnpmPath: string | undefined): string {
  const explicit = pnpmPath?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('Invalid pnpm path: expected an absolute executable path.');
    }
    return explicit;
  }

  return PNPM;
}
