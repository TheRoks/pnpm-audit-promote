import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('cross-spawn', () => ({
  default: spawnMock,
}));

import { createPnpmRunner, ensurePnpmAvailable, getPnpmMajor } from '../src/pnpm';

const EXPLICIT_PNPM_PATH =
  process.platform === 'win32' ? 'C:\\pnpm\\pnpm.cmd' : '/usr/local/bin/pnpm';
const TEST_CWD = path.resolve('/tmp/workspace');

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
    showsDetails() {
      return true;
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

  it('REQ-RUNNER-001: does not inherit pnpm output by default', async () => {
    mockExit(0);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await runner.run(['install']);

    expect(spawnMock).toHaveBeenCalledWith(
      EXPLICIT_PNPM_PATH,
      ['install'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('REQ-RUNNER-001: uses global pnpm command when explicit pnpmPath is not provided', async () => {
    mockExit(0);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
    });

    await runner.run(['install']);

    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['install'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('REQ-LOGGING-004: inherits pnpm output when inheritOutput is enabled', async () => {
    mockExit(0);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      inheritOutput: true,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await runner.run(['install']);

    expect(spawnMock).toHaveBeenCalledWith(
      EXPLICIT_PNPM_PATH,
      ['install'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('REQ-CORE-002: does not spawn pnpm in dry-run mode', async () => {
    const trace = vi.fn();
    const logger: Logger = {
      ...makeLogger(),
      trace,
    };
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger,
      dryRun: true,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await runner.run(['dedupe']);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith('(dry-run) pnpm dedupe');
  });

  it('REQ-PNPM11-008: appends extraArgs to every spawned pnpm invocation', async () => {
    mockExit(0);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      extraArgs: ['--ignore-workspace'],
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await runner.run(['install']);
    await runner.runAllowFail(['dedupe']);
    spawnMock.mockImplementationOnce(() => makeChildWithStdout(0, ''));
    await runner.capture(['audit', '--json']);

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      EXPLICIT_PNPM_PATH,
      ['install', '--ignore-workspace'],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      EXPLICIT_PNPM_PATH,
      ['dedupe', '--ignore-workspace'],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      EXPLICIT_PNPM_PATH,
      ['audit', '--json', '--ignore-workspace'],
      expect.any(Object),
    );
  });

  it('REQ-LOGGING-006: emits heartbeat progress messages when output is hidden', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: {
        ...makeLogger(),
        detail,
      },
      progressIntervalMs: 1000,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const runPromise = runner.run(['install']);

    await vi.advanceTimersByTimeAsync(2600);
    await runPromise;

    expect(detail).toHaveBeenCalledWith('Running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Still running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Completed pnpm install.');
  });

  it('REQ-LOGGING-006: suppresses heartbeat progress messages when inheriting output', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: {
        ...makeLogger(),
        detail,
      },
      inheritOutput: true,
      progressIntervalMs: 1000,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const runPromise = runner.run(['install']);

    await vi.advanceTimersByTimeAsync(2500);
    await runPromise;

    expect(detail).not.toHaveBeenCalled();
  });

  it('REQ-LOGGING-006: renders a single-line spinner in TTY mode when enabled', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 1200);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: {
        ...makeLogger(),
        detail,
      },
      progressIntervalMs: 1000,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const runPromise = runner.run(['install']);
    await vi.advanceTimersByTimeAsync(1300);
    await runPromise;

    expect(writeSpy).toHaveBeenCalled();
    expect(detail).toHaveBeenCalledWith('Completed pnpm install.');

    writeSpy.mockRestore();
  });

  it('REQ-LOGGING-006: can disable spinner and keep heartbeat details in TTY mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    vi.useFakeTimers();
    mockExitAfter(0, 2500);

    const detail = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: {
        ...makeLogger(),
        detail,
      },
      spinner: false,
      progressIntervalMs: 1000,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const runPromise = runner.run(['install']);
    await vi.advanceTimersByTimeAsync(2600);
    await runPromise;

    expect(detail).toHaveBeenCalledWith('Running pnpm install...');
    expect(detail).toHaveBeenCalledWith('Still running pnpm install...');
  });

  it('REQ-RUNNER-002: throws when run receives a non-zero exit code', async () => {
    mockExit(1);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });
    await expect(runner.run(['install'])).rejects.toThrow(/failed with exit code 1/);
  });

  it('REQ-RUNNER-008, REQ-ERRORS-004: includes captured pnpm stderr in the failure message', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('ERR_PNPM_SOMETHING something broke', 'utf8'));
        child.emit('close', 1);
      });
      return child;
    });

    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await expect(runner.run(['install'])).rejects.toThrow(/ERR_PNPM_SOMETHING something broke/);
  });

  it('REQ-RUNNER-009: retries pnpm install once before failing', async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          child.emit('close', 1);
        });
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          child.emit('close', 0);
        });
        return child;
      });

    const warn = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: { ...makeLogger(), warn },
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    await expect(runner.run(['install'])).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/pnpm install failed with exit code 1; retrying/),
    );
  });

  it('REQ-RUNNER-003: returns non-zero from runAllowFail', async () => {
    mockExit(2);
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });
    await expect(runner.runAllowFail(['audit', '--fix'])).resolves.toBe(2);
  });

  it('REQ-RUNNER-005: maps ENOENT spawn errors to a friendly message', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });

    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });
    await expect(runner.run(['install'])).rejects.toThrow(/pnpm is not installed/);
  });

  it('REQ-RUNNER-004: capture returns stdout and exit code', async () => {
    spawnMock.mockImplementation(() => makeChildWithStdout(3, '{"ok":true}'));
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: makeLogger(),
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const out = await runner.capture(['audit', '--json']);
    expect(out).toEqual({ stdout: '{"ok":true}', exitCode: 3 });
  });

  it('REQ-CORE-002: capture supports dry-run mode', async () => {
    const trace = vi.fn();
    const runner = createPnpmRunner({
      cwd: TEST_CWD,
      logger: { ...makeLogger(), trace },
      dryRun: true,
      pnpmPath: EXPLICIT_PNPM_PATH,
    });

    const out = await runner.capture(['audit', '--json']);
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(trace).toHaveBeenCalledWith('(dry-run) pnpm audit --json (capture)');
  });

  it('REQ-RUNNER-005: ensurePnpmAvailable resolves on zero exit', async () => {
    mockExit(0);
    await expect(ensurePnpmAvailable(EXPLICIT_PNPM_PATH)).resolves.toBeUndefined();
  });

  it('REQ-RUNNER-005: ensurePnpmAvailable rejects on non-zero exit', async () => {
    mockExit(1);
    await expect(ensurePnpmAvailable(EXPLICIT_PNPM_PATH)).rejects.toThrow(/pnpm is not installed/);
  });

  it('REQ-RUNNER-005: ensurePnpmAvailable rejects on ENOENT', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });

    await expect(ensurePnpmAvailable(EXPLICIT_PNPM_PATH)).rejects.toThrow(/pnpm is not installed/);
  });

  it('REQ-RUNNER-001: rejects non-absolute explicit pnpm paths', async () => {
    expect(() =>
      createPnpmRunner({ cwd: TEST_CWD, logger: makeLogger(), pnpmPath: 'pnpm' }),
    ).toThrow(/absolute executable path/);
  });
});

describe('getPnpmMajor', () => {
  it('REQ-RUNNER-006: parses major numbers from common pnpm version strings', () => {
    expect(getPnpmMajor('10.33.0')).toBe(10);
    expect(getPnpmMajor('11.0.0')).toBe(11);
    expect(getPnpmMajor('11.0.0-rc.1')).toBe(11);
    expect(getPnpmMajor('v11.2.3')).toBe(11);
    expect(getPnpmMajor('  10.33.0\n')).toBe(10);
  });

  it('REQ-RUNNER-006: returns null for unparseable input', () => {
    expect(getPnpmMajor('')).toBeNull();
    expect(getPnpmMajor('not a version')).toBeNull();
    expect(getPnpmMajor('latest')).toBeNull();
  });
});

describe('PnpmRunner version()', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('REQ-RUNNER-006: caches the result of `pnpm --version`', async () => {
    spawnMock.mockImplementationOnce(() => makeChildWithStdout(0, '11.0.0\n'));
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });
    expect(await runner.version()).toBe('11.0.0');
    expect(await runner.version()).toBe('11.0.0');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['--version'],
      expect.objectContaining({ cwd: '/tmp/workspace', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('REQ-CORE-002: returns an empty string in dry-run mode', async () => {
    const runner = createPnpmRunner({
      cwd: '/tmp/workspace',
      logger: makeLogger(),
      dryRun: true,
    });
    expect(await runner.version()).toBe('');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('REQ-RUNNER-005: returns an empty string when pnpm fails to launch', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });
    const runner = createPnpmRunner({ cwd: '/tmp/workspace', logger: makeLogger() });
    expect(await runner.version()).toBe('');
  });
});
