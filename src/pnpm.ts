import spawn from 'cross-spawn';
import { type Logger } from './logger';
import { PnpmCommandFailedError, PnpmNotInstalledError } from './errors';

export interface PnpmRunner {
  /** Run pnpm and throw on non-zero exit. */
  run(args: string[]): Promise<void>;
  /** Run pnpm and return its captured stdout. Does not throw on non-zero. */
  capture(args: string[]): Promise<{ stdout: string; exitCode: number }>;
  /** Run pnpm without throwing on non-zero exit. */
  runAllowFail(args: string[]): Promise<number>;
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
}

export function createPnpmRunner({
  cwd,
  logger,
  inheritOutput = false,
  spinner = true,
  progressIntervalMs = 20_000,
  dryRun = false,
  extraArgs = [],
}: PnpmOptions): PnpmRunner {
  const withExtras = (args: string[]): string[] =>
    extraArgs.length > 0 ? [...args, ...extraArgs] : args;
  return {
    async run(args) {
      const finalArgs = withExtras(args);
      logger.trace?.(`${dryRun ? '(dry-run) ' : ''}pnpm ${finalArgs.join(' ')}`);
      if (dryRun) return;
      const code = await runWithProgress({
        args: finalArgs,
        logger,
        enabled: !inheritOutput,
        spinner,
        progressIntervalMs,
        execute: () => spawnPnpm(finalArgs, { cwd, inheritOutput }),
      });
      if (code !== 0) {
        throw new PnpmCommandFailedError(finalArgs, code);
      }
    },
    async runAllowFail(args) {
      const finalArgs = withExtras(args);
      logger.trace?.(`${dryRun ? '(dry-run) ' : ''}pnpm ${finalArgs.join(' ')}`);
      if (dryRun) return 0;
      return runWithProgress({
        args: finalArgs,
        logger,
        enabled: !inheritOutput,
        spinner,
        progressIntervalMs,
        execute: () => spawnPnpm(finalArgs, { cwd, inheritOutput }),
      });
    },
    async capture(args) {
      const finalArgs = withExtras(args);
      if (dryRun) {
        logger.trace?.(`(dry-run) pnpm ${finalArgs.join(' ')} (capture)`);
        return { stdout: '', exitCode: 0 };
      }
      return new Promise((resolve, reject) => {
        const child = spawn(PNPM, finalArgs, {
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

async function runWithProgress(options: {
  args: string[];
  logger: Logger;
  enabled: boolean;
  spinner: boolean;
  progressIntervalMs: number;
  execute: () => Promise<number>;
}): Promise<number> {
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
    const code = await execute();
    spinnerController.stop();
    logger.detail(
      code === 0 ? `Completed ${command}.` : `${command} completed with exit code ${code}.`,
    );
    return code;
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
  if (command === 'pnpm audit --fix') return 'Applying security fixes';
  const shortCommand = command.startsWith('pnpm ') ? command.slice(5) : command;
  return `Running ${shortCommand}`;
}

function spawnPnpm(args: string[], opts: { cwd: string; inheritOutput: boolean }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(PNPM, args, {
      cwd: opts.cwd,
      stdio: opts.inheritOutput ? 'inherit' : 'ignore',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new PnpmNotInstalledError());
      } else {
        reject(err);
      }
    });
    child.on('close', (code: number | null) => resolve(code ?? 0));
  });
}

/**
 * Verify pnpm is on PATH by running `pnpm --version`. Throws if pnpm is
 * missing or fails to launch.
 */
export async function ensurePnpmAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PNPM, ['--version'], { stdio: 'ignore' });
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
