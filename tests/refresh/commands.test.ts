import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
