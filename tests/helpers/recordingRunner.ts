import type { PnpmRunner } from '../../src/pnpm';

export interface RecordedCall {
  args: string[];
  capture?: boolean;
}

/**
 * Build a {@link PnpmRunner} that records every call and returns
 * preconfigured stdout for `capture` invocations matched by joined args.
 */
export interface RecordingRunnerOptions {
  /** Value returned by the mock `version()` method. Defaults to `'10.33.0'`. */
  version?: string;
}

export function makeRecordingRunner(
  stdoutByCmd: Record<string, string> = {},
  options: RecordingRunnerOptions = {},
): {
  runner: PnpmRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const version = options.version ?? '10.33.0';
  const runner: PnpmRunner = {
    async run(args) {
      calls.push({ args });
    },
    async runAllowFail(args) {
      calls.push({ args });
      return 0;
    },
    async capture(args) {
      calls.push({ args, capture: true });
      const key = args.join(' ');
      return { stdout: stdoutByCmd[key] ?? '', exitCode: 0 };
    },
    async version() {
      return version;
    },
  };
  return { runner, calls };
}
