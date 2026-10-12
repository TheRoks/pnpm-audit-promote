import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProgressLogger } from '../../src/progress';
import { runInstallAndDedupe } from '../../src/refresh/install';
import { silentLogger } from '../../src/logger';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function createWorkspace(autoDedupe: boolean, pnpmMajor: number): WorkspaceState {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-refresh-install-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager: `pnpm@${pnpmMajor}.0.0` }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmp, 'pnpm-workspace.yaml'),
    `autoDedupe: ${autoDedupe}\npackages: []\n`,
    'utf8',
  );
  const state = WorkspaceState.initialize(tmp);
  state.recordPnpmMajor(pnpmMajor);
  return state;
}

describe('runInstallAndDedupe', () => {
  it('REQ-PNPM12-004: uses install-time autoDedupe on pnpm 12', async () => {
    const state = createWorkspace(true, 12);
    const { runner, calls } = makeRecordingRunner();

    await runInstallAndDedupe(runner, state, silentLogger, createProgressLogger(silentLogger, 2), {
      skipDedupe: false,
      installLabel: 'Install dependencies',
    });

    expect(calls.map((call) => call.args)).toEqual([['install', '--no-frozen-lockfile']]);
  });

  it('REQ-CORE-006: skips explicit dedupe when requested', async () => {
    const state = createWorkspace(false, 11);
    const { runner, calls } = makeRecordingRunner();

    await runInstallAndDedupe(runner, state, silentLogger, createProgressLogger(silentLogger, 2), {
      skipDedupe: true,
      installLabel: 'Install dependencies',
    });

    expect(calls.map((call) => call.args)).toEqual([['install', '--no-frozen-lockfile']]);
  });
});
