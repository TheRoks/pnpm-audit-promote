import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../../src/logger';
import { WorkspaceState } from '../../src/workspace';
import { resolveWorkspacePackageDirs } from '../../src/workspace/packageScope';

let tmp = '';

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

function createWorkspace(yaml: string): WorkspaceState {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-config-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"root"}\n');
  fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml);
  const state = WorkspaceState.initialize(tmp);
  state.recordPnpm(12, '12.15.0');
  return state;
}

describe('WorkspaceConfiguration delegated settings', () => {
  it('REQ-PNPM-CFG-001, REQ-PNPM-CFG-002: reads effective local settings and routes catalog edits to their owner', () => {
    const state = createWorkspace(
      [
        'include:',
        '  ./config/packages.yaml: [packages]',
        '  ./config/catalog.yaml: [catalog]',
        '  ./config/policy.yaml: [audit, overrides]',
        '',
      ].join('\n'),
    );
    const configDir = path.join(tmp, 'config');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'packages.yaml'), 'packages:\n  - ../apps/*\n');
    fs.writeFileSync(path.join(configDir, 'catalog.yaml'), "catalog:\n  lodash: '4.17.20'\n");
    fs.writeFileSync(
      path.join(configDir, 'policy.yaml'),
      'audit:\n  level: high\noverrides:\n  tar: 7.5.11\n',
    );
    const appDir = path.join(tmp, 'apps', 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"app"}\n');

    // Reload after writing the included files; pnpm requires them to exist at load time.
    state.configuration.initialize(state.pnpmCapabilities);
    const rootBefore = fs.readFileSync(state.paths.workspaceYaml, 'utf8');
    expect(state.configuration.readEffectiveSetting('audit')).toEqual({ level: 'high' });
    expect(state.configuration.readEffectiveSetting('packages')).toEqual(['apps/*']);
    expect(
      resolveWorkspacePackageDirs({ paths: state.paths, yaml: state.configuration }),
    ).toContain(appDir);
    expect(state.configuration.getOwnerSnapshot('overrides')?.path).toBe(
      path.join(configDir, 'policy.yaml'),
    );

    state.configuration.updateCatalogs(new Map([['lodash', '4.17.21']]));

    expect(fs.readFileSync(path.join(configDir, 'catalog.yaml'), 'utf8')).toContain('4.17.21');
    expect(fs.readFileSync(state.paths.workspaceYaml, 'utf8')).toBe(rootBefore);
    expect(fs.readFileSync(path.join(configDir, 'policy.yaml'), 'utf8')).toContain('tar: 7.5.11');
  });

  it('REQ-PNPM-CFG-005: authorizes a literal included YAML file outside the workspace root', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-config-'));
    const root = path.join(tmp, 'workspace');
    const shared = path.join(tmp, 'shared-catalog.yaml');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"root"}\n');
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'include:\n  ../shared-catalog.yaml: [catalog]\n',
    );
    fs.writeFileSync(shared, "catalog:\n  lodash: '4.17.20'\n");
    const state = WorkspaceState.initialize(root);
    state.recordPnpm(12, '12.15.0');
    state.configuration.initialize(state.pnpmCapabilities);

    state.configuration.updateCatalogs(new Map([['lodash', '4.17.21']]));

    expect(fs.readFileSync(shared, 'utf8')).toContain('4.17.21');
  });

  it('REQ-PNPM-CFG-003: rejects an audit change owned by a config dependency before cleanup', () => {
    const state = createWorkspace(
      [
        'configDependencies:',
        "  '@test/policy': 1.0.0",
        'include:',
        "  '@test/policy': [overrides]",
        '',
      ].join('\n'),
    );
    const dependency = path.join(tmp, 'node_modules', '@test', 'policy');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: '@test/policy', version: '1.0.0', pnpm: { config: './config.yaml' } }),
    );
    fs.writeFileSync(path.join(dependency, 'config.yaml'), 'overrides:\n  lodash: 4.17.21\n');
    state.configuration.initialize(state.pnpmCapabilities);

    expect(state.configuration.getOwnerKind('overrides')).toBe('configDependency');
    expect(() =>
      state.configuration.assertAuditSettingsWritable([{ module_name: 'lodash' }], new Map(), true),
    ).toThrow(/owned by config dependency '@test\/policy'/);
  });

  it('REQ-PNPM-CFG-004, REQ-CORE-013, REQ-INT-PNPM12-005: preserves delegated permissions through recovery', () => {
    const state = createWorkspace(
      ['include:', '  ./config/permissions.yaml: [permissions]', ''].join('\n'),
    );
    const permissionsPath = path.join(tmp, 'config', 'permissions.yaml');
    fs.mkdirSync(path.dirname(permissionsPath));
    fs.writeFileSync(permissionsPath, 'permissions:\n  buildScripts: {}\n  agentSkills: {}\n');
    state.configuration.initialize(state.pnpmCapabilities);
    const original = fs.readFileSync(permissionsPath, 'utf8');
    const controlFiles = new Map<string, string | null>([
      [state.paths.workspaceYaml, fs.readFileSync(state.paths.workspaceYaml, 'utf8')],
      [permissionsPath, original],
    ]);

    fs.writeFileSync(
      permissionsPath,
      'permissions:\n  buildScripts:\n    esbuild: true\n  agentSkills:\n    formatter: true\n',
    );
    state.configuration.preserveApprovedBuilds(silentLogger);
    const recovered = state.configuration.restoreInitialFiles(controlFiles, silentLogger);

    expect(recovered.failed).toEqual([]);
    const finalText = fs.readFileSync(permissionsPath, 'utf8');
    expect(finalText).toContain('esbuild: true');
    expect(finalText).toContain('formatter: true');
  });
});
