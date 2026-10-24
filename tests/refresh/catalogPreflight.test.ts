import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../../src/logger';
import { refreshDeps } from '../../src/refresh';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp = '';

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('delegated catalog ownership preflight', () => {
  it('REQ-PNPM-CFG-003: detects a masked catalog update before removing the lockfile and node_modules', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-catalog-preflight-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@12.15.0' }),
      'utf8',
    );
    const workspaceYaml = [
      'configDependencies:',
      "  '@test/policy': 1.0.0",
      'include:',
      "  '@test/policy': [catalog]",
      'overrides:',
      '  lodash: 4.17.21',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), workspaceYaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    const dependencyPath = path.join(tmp, 'node_modules', '@test', 'policy');
    fs.mkdirSync(dependencyPath, { recursive: true });
    fs.writeFileSync(
      path.join(dependencyPath, 'package.json'),
      JSON.stringify({
        name: '@test/policy',
        version: '1.0.0',
        pnpm: { config: './config.yaml' },
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(dependencyPath, 'config.yaml'), "catalog:\n  lodash: '4.17.20'\n");
    const { runner, calls } = makeRecordingRunner({
      'audit --json': JSON.stringify({ advisories: {} }),
    });

    await expect(
      refreshDeps({
        path: tmp,
        force: true,
        logger: silentLogger,
        pnpm: runner,
        skipDedupe: true,
        summary: false,
      }),
    ).rejects.toThrow(/catalog settings are owned by config dependency '@test\/policy'/);

    expect(fs.existsSync(path.join(tmp, 'pnpm-lock.yaml'))).toBe(true);
    expect(fs.existsSync(dependencyPath)).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'lodash: 4.17.21',
    );
    expect(calls.some((call) => call.args[0] === 'install')).toBe(false);
  });

  it('REQ-PNPM-CFG-003: allows catalog ranges that already contain the original override', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-catalog-range-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"root"}\n', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      [
        'configDependencies:',
        "  '@test/policy': 1.0.0",
        'include:',
        "  '@test/policy': [catalog]",
        '',
      ].join('\n'),
      'utf8',
    );
    const dependencyPath = path.join(tmp, 'node_modules', '@test', 'policy');
    fs.mkdirSync(dependencyPath, { recursive: true });
    fs.writeFileSync(
      path.join(dependencyPath, 'package.json'),
      JSON.stringify({
        name: '@test/policy',
        version: '1.0.0',
        pnpm: { config: './config.yaml' },
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(dependencyPath, 'config.yaml'), "catalog:\n  lodash: '^4.17.20'\n");
    const state = WorkspaceState.initialize(tmp);
    state.recordPnpm(12, '12.15.0');
    state.configuration.initialize(state.pnpmCapabilities);

    expect(() =>
      state.configuration.assertAuditSettingsWritable(
        [],
        new Map([['lodash', '^4.17.20']]),
        true,
        new Map([['lodash', { value: '4.17.21', source: 'workspace' }]]),
      ),
    ).not.toThrow();
  });
});
