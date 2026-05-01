import spawn from 'cross-spawn';
import type { Logger } from './logger.js';

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
  /** When true, log commands but do not execute pnpm. Captures return empty stdout. */
  dryRun?: boolean;
}

export function createPnpmRunner({ cwd, logger, dryRun = false }: PnpmOptions): PnpmRunner {
  return {
    async run(args) {
      logger.detail(`${dryRun ? '(dry-run) ' : ''}pnpm ${args.join(' ')}`);
      if (dryRun) return;
      const code = await spawnPnpm(args, { cwd, inherit: true });
      if (code !== 0) {
        throw new Error(`pnpm ${args.join(' ')} failed with exit code ${code}`);
      }
    },
    async runAllowFail(args) {
      logger.detail(`${dryRun ? '(dry-run) ' : ''}pnpm ${args.join(' ')}`);
      if (dryRun) return 0;
      return spawnPnpm(args, { cwd, inherit: true });
    },
    async capture(args) {
      if (dryRun) {
        logger.detail(`(dry-run) pnpm ${args.join(' ')} (capture)`);
        return { stdout: '', exitCode: 0 };
      }
      return new Promise((resolve, reject) => {
        const child = spawn(PNPM, args, {
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

function spawnPnpm(args: string[], opts: { cwd: string; inherit: boolean }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(PNPM, args, {
      cwd: opts.cwd,
      stdio: opts.inherit ? 'inherit' : 'pipe',
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('pnpm is not installed or not on PATH.'));
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
        reject(new Error('pnpm is not installed or not on PATH.'));
      } else {
        reject(err);
      }
    });
    child.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error('pnpm is not installed or not on PATH.'));
    });
  });
}
