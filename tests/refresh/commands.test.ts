import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PnpmCommandFailedError } from '../../src/errors';
import { silentLogger } from '../../src/logger';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';
import { reconcileAfterAuditRead, runAndRestore } from '../../src/refresh/commands';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function createWorkspace(withYaml: boolean): WorkspaceState {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-refresh-commands-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.0.0' }),
    'utf8',
  );
  if (withYaml) {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n\ncatalog:\n  react: 18.0.0\n",
      'utf8',
    );
  }
  return WorkspaceState.initialize(tmp);
}

describe('refresh command reconciliation', () => {
  it('REQ-CORE-003: restores the desired YAML after an install rewrites it', async () => {
    const state = createWorkspace(true);
    const desired = state.yaml.desiredWorkspaceYaml;
    const yamlPath = state.workspaceYaml;
    const { runner, calls } = makeRecordingRunner();
    runner.run = async (args) => {
      calls.push({ args });
      fs.writeFileSync(yamlPath, 'packages: []\n', 'utf8');
    };

    await runAndRestore(runner, state, silentLogger, ['install', '--no-frozen-lockfile']);

    expect(calls.map((call) => call.args)).toEqual([
      ['install', '--no-frozen-lockfile'],
      ['install', '--no-frozen-lockfile'],
    ]);
    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(desired);
    expect(state.yaml.desiredWorkspaceYaml).toBe(desired);
  });

  it('REQ-CORE-011: approves ignored builds on the workspace restoration install', async () => {
    const state = createWorkspace(true);
    const yamlPath = state.workspaceYaml;
    const { runner } = makeRecordingRunner();
    const calls: string[] = [];
    let installAttempts = 0;
    runner.run = async (args) => {
      calls.push(args.join(' '));
      installAttempts++;
      if (installAttempts === 1) {
        fs.writeFileSync(yamlPath, 'packages: []\n', 'utf8');
      } else if (installAttempts === 2) {
        throw new PnpmCommandFailedError(args, 1, 'ERR_PNPM_IGNORED_BUILDS');
      }
    };
    runner.runInteractive = async (args) => {
      calls.push(args.join(' '));
      fs.writeFileSync(yamlPath, 'packages: []\nallowBuilds:\n  canvas: false\n', 'utf8');
    };

    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      await runAndRestore(runner, state, silentLogger, ['install', '--no-frozen-lockfile']);
    } finally {
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }

    expect(calls).toEqual([
      'install --no-frozen-lockfile',
      'install --no-frozen-lockfile',
      'approve-builds',
      'install --no-frozen-lockfile',
    ]);
    const finalYaml = fs.readFileSync(yamlPath, 'utf8');
    expect(finalYaml).toContain('react: 18.0.0');
    expect(finalYaml).toContain('canvas: false');
  });

  it('REQ-CORE-010: adopts a workspace YAML created by pnpm during the run', () => {
    const state = createWorkspace(false);
    const yamlPath = state.workspaceYaml;
    fs.writeFileSync(yamlPath, 'catalog:\n  react: 19.0.0\n', 'utf8');

    reconcileAfterAuditRead(state, silentLogger);

    expect(state.yaml.hasWorkspaceYaml).toBe(true);
    expect(state.yaml.originalWorkspaceYaml).toBe('');
    expect(state.yaml.desiredWorkspaceYaml).toContain('react: 19.0.0');
  });
});
