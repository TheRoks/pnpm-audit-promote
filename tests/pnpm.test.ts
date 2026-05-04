import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('cross-spawn', () => ({
  default: spawnMock,
}));

import { createPnpmRunner, ensurePnpmAvailable } from '../src/pnpm.js';

function makeLogger(): Logger {
  return {
    step() {},
    detail() {},
    trace() {},
    bullet() {},
    warn() {},
    info() {},
    success() {},
    raw() {},
    isVerbose() {
      return false;
    },
  };
}

function mockExit(code: number): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      child.emit('close', code);
    });
    return child;
  });
}

function mockExitAfter(code: number, delayMs: number): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    setTimeout(() => {
      child.emit('close', code);
    }, delayMs);
    return child;
  });
}

function makeChildWithStdout(
  code: number,
  stdoutText: string,
): EventEmitter & {
  stdout: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  child.stdout = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdoutText, 'utf8'));
    child.emit('close', code);
  });
  return child;
}

describe('createPnpmRunner output gating', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });
  });

  it('does not inherit pnpm output by default', async () => {
    mockExit(0);
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });

    await runner.run(['install']);

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['install'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('inherits pnpm output when inheritOutput is enabled', async () => {
    mockExit(0);
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: makeLogger(),
      inheritOutput: true,
    });

    await runner.run(['install']);

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['install'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('does not spawn pnpm in dry-run mode', async () => {
    const trace = vi.fn();
    const logger: Logger = {
      ...makeLogger(),
      trace,
    };
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger, dryRun: true });

    await runner.run(['dedupe']);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith('(dry-run) pnpm dedupe');
  });

  it('emits heartbeat progress messages when output is hidden', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: {
        ...makeLogger(),
        detail,
      },
      progressIntervalMs: 1000,
    });

    const runPromise = runner.run(['install']);

    await vi.advanceTimersByTimeAsync(2600);
    await runPromise;

    expect(detail).toHaveBeenCalledWith('Running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Still running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Completed pnpm install.');
  });

  it('suppresses heartbeat progress messages when inheriting output', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: {
        ...makeLogger(),
        detail,
      },
      inheritOutput: true,
      progressIntervalMs: 1000,
    });

    const runPromise = runner.run(['install']);

    await vi.advanceTimersByTimeAsync(2500);
    await runPromise;

    expect(detail).not.toHaveBeenCalled();
  });

  it('renders a single-line spinner in TTY mode when enabled', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 1200);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: {
        ...makeLogger(),
        detail,
      },
      progressIntervalMs: 1000,
    });

    const runPromise = runner.run(['install']);
    await vi.advanceTimersByTimeAsync(1300);
    await runPromise;

    expect(writeSpy).toHaveBeenCalled();
    expect(detail).toHaveBeenCalledWith('Completed pnpm install.');

    writeSpy.mockRestore();
  });

  it('can disable spinner and keep heartbeat details in TTY mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: {
        ...makeLogger(),
        detail,
      },
      spinner: false,
      progressIntervalMs: 1000,
    });

    const runPromise = runner.run(['install']);
    await vi.advanceTimersByTimeAsync(2600);
    await runPromise;

    expect(detail).toHaveBeenCalledWith('Running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Still running pnpm install...');
  });

  it('throws when run receives a non-zero exit code', async () => {
    mockExit(1);
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });
    await expect(runner.run(['install'])).rejects.toThrow(/failed with exit code 1/);
  });

  it('returns non-zero from runAllowFail', async () => {
    mockExit(2);
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });
    await expect(runner.runAllowFail(['audit', '--fix'])).resolves.toBe(2);
  });

  it('maps ENOENT spawn errors to a friendly message', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });

    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });
    await expect(runner.run(['install'])).rejects.toThrow(/pnpm is not installed/);
  });

  it('capture returns stdout and exit code', async () => {
    spawnMock.mockImplementation(() => makeChildWithStdout(3, '{"ok":true}'));
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });

    const out = await runner.capture(['audit', '--json']);
    expect(out).toEqual({ stdout: '{"ok":true}', exitCode: 3 });
  });

  it('capture supports dry-run mode', async () => {
    const trace = vi.fn();
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: { ...makeLogger(), trace },
      dryRun: true,
    });

    const out = await runner.capture(['audit', '--json']);
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(trace).toHaveBeenCalledWith('(dry-run) pnpm audit --json (capture)');
  });

  it('ensurePnpmAvailable resolves on zero exit', async () => {
    mockExit(0);
    await expect(ensurePnpmAvailable()).resolves.toBeUndefined();
  });

  it('ensurePnpmAvailable rejects on non-zero exit', async () => {
    mockExit(1);
    await expect(ensurePnpmAvailable()).rejects.toThrow(/pnpm is not installed/);
  });

  it('ensurePnpmAvailable rejects on ENOENT', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });

    await expect(ensurePnpmAvailable()).rejects.toThrow(/pnpm is not installed/);
  });
});
