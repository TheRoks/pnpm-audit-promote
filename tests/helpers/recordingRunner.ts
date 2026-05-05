import type { PnpmRunner } from '../../src/pnpm';

export interface RecordedCall {
  args: string[];
  capture?: boolean;
}

/**
 * Build a {@link PnpmRunner} that records every call and returns
 * preconfigured stdout for `capture` invocations matched by joined args.
 */
export function makeRecordingRunner(stdoutByCmd: Record<string, string> = {}): {
  runner: PnpmRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
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
  };
  return { runner, calls };
}
