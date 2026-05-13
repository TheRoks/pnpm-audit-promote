import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceState } from '../../src/workspace';
import { silentLogger } from '../../src/logger';
import { migrateYamlOverridesToPackageJson } from '../../src/audit/ignoreWorkspaceMigration';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mig-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeWs(yaml: string | null, pkg: object): WorkspaceState {
  if (yaml !== null) fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return WorkspaceState.initialize(tmp);
}

describe('migrateYamlOverridesToPackageJson', () => {
  it('REQ-PNPM11-006: moves yaml overrides into package.json pnpm.overrides under --ignore-workspace', () => {
    const yaml =
      'overrides:\n' +
      "  tar@<=7.5.10: '>=7.5.11'\n" +
      "  serialize-javascript@<7.0.5: '>=7.0.5'\n" +
      "  postcss@<8.5.10: '>=8.5.10'\n";
    const state = writeWs(yaml, { name: 'root', packageManager: 'pnpm@10.33.0' });
    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides).toEqual({
      'tar@<=7.5.10': '>=7.5.11',
      'serialize-javascript@<7.0.5': '>=7.0.5',
      'postcss@<8.5.10': '>=8.5.10',
    });

    // Yaml's overrides block should be stripped.
    const onDiskYaml = fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))
      ? fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')
      : '';
    expect(onDiskYaml).not.toMatch(/^overrides:/m);
  });

  it('REQ-PNPM11-006: merges with existing pnpm.overrides, yaml values winning on key collision', () => {
    const yaml = "overrides:\n  'tar@<=7.5.10': '>=7.5.11'\n";
    const state = writeWs(yaml, {
      name: 'root',
      pnpm: { overrides: { 'tar@<=7.0.0': '>=7.0.1', 'other-pkg': '1.0.0' } },
    });
    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides).toEqual({
      'tar@<=7.0.0': '>=7.0.1',
      'other-pkg': '1.0.0',
      'tar@<=7.5.10': '>=7.5.11',
    });
  });

  it('REQ-PNPM11-006: returns false and is a no-op when the yaml has no overrides block', () => {
    const state = writeWs("catalog:\n  react: '18.2.0'\n", {
      name: 'root',
      packageManager: 'pnpm@10.33.0',
    });
    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(false);

    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides).toBeUndefined();
  });

  it('REQ-PNPM11-006: returns false and is a no-op when the workspace yaml does not exist', () => {
    const state = writeWs(null, { name: 'root', packageManager: 'pnpm@10.33.0' });
    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(false);
  });

  it('REQ-PNPM11-006, REQ-WORKSPACE-010: deletes the pnpm-workspace.yaml when it was created mid-run and becomes empty', () => {
    // Simulates the --ignore-workspace flow: WorkspaceState.initialize() saw
    // no yaml, then `pnpm audit --fix` wrote one with only an overrides block,
    // then `refreshHasWorkspaceYaml` flipped the flag with `originalWorkspaceYaml = ''`.
    const state = writeWs(null, { name: 'root', packageManager: 'pnpm@10.33.0' });
    expect(state.hasWorkspaceYaml).toBe(false);
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "overrides:\n  tar@<=7.5.10: '>=7.5.11'\n",
      'utf8',
    );
    expect(state.refreshHasWorkspaceYaml()).toBe(true);

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(false);
    expect(state.hasWorkspaceYaml).toBe(false);
  });

  it('REQ-PNPM11-006: preserves the pnpm-workspace.yaml when it pre-existed and still has other top-level keys', () => {
    const yaml = "packages:\n  - apps/*\n\noverrides:\n  tar@<=7.5.10: '>=7.5.11'\n";
    const state = writeWs(yaml, { name: 'root', packageManager: 'pnpm@10.33.0' });
    expect(state.hasWorkspaceYaml).toBe(true);

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(true);
    const onDiskYaml = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(onDiskYaml).toContain('packages:');
    expect(onDiskYaml).not.toMatch(/^overrides:/m);
  });

  it('REQ-PNPM11-006, REQ-CORE-002: respects dryRun: does not modify any files', () => {
    const yaml = "overrides:\n  tar@<=7.5.10: '>=7.5.11'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@10.33.0' }, null, 2),
      'utf8',
    );
    const state = WorkspaceState.initialize(tmp, { dryRun: true });

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    // package.json on disk must be untouched.
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm).toBeUndefined();

    // yaml on disk must be untouched.
    const onDiskYaml = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(onDiskYaml).toContain('overrides:');
  });

  it('REQ-PNPM11-006, REQ-PORTABILITY-003: preserves 2-space indentation when the source file uses 2 spaces', () => {
    const yaml = "overrides:\n  tar@<=7.5.10: '>=7.5.11'\n";
    // Carefully craft the source package.json with 2-space indentation,
    // matching what most real-world Node.js projects use.
    const pjText = `{\n  "name": "root",\n  "private": true,\n  "dependencies": {\n    "react": "18.2.0"\n  }\n}\n`;
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), pjText, 'utf8');
    const state = WorkspaceState.initialize(tmp);

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    const out = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    // Verify the pnpm block is indented with the same 2-space style as the
    // rest of the file (no tabs, no 4-space indentation).
    expect(out).toContain('  "pnpm": {');
    expect(out).toContain('    "overrides": {');
    expect(out).toContain('      "tar@<=7.5.10": ">=7.5.11"');
    expect(out).not.toContain('\t');
  });

  it('REQ-PNPM11-006, REQ-PORTABILITY-003: preserves 4-space indentation when the source file uses 4 spaces', () => {
    const yaml = "overrides:\n  tar@<=7.5.10: '>=7.5.11'\n";
    const pjText = `{\n    "name": "root",\n    "private": true\n}\n`;
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), pjText, 'utf8');
    const state = WorkspaceState.initialize(tmp);

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    const out = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    expect(out).toContain('    "pnpm": {');
    expect(out).toContain('        "overrides": {');
    expect(out).not.toContain('\t');
  });

  it('REQ-PNPM11-006, REQ-PORTABILITY-003: preserves tab indentation when the source file uses tabs', () => {
    const yaml = "overrides:\n  tar@<=7.5.10: '>=7.5.11'\n";
    const pjText = `{\n\t"name": "root",\n\t"private": true\n}\n`;
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), pjText, 'utf8');
    const state = WorkspaceState.initialize(tmp);

    const moved = migrateYamlOverridesToPackageJson(state, silentLogger);
    expect(moved).toBe(true);

    const out = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    expect(out).toContain('\t"pnpm": {');
    expect(out).toContain('\t\t"overrides": {');
    // No stray 2-space or 4-space indentation that would clash with tabs.
    expect(out).not.toMatch(/\n {2}"/);
    expect(out).not.toMatch(/\n {4}"/);
  });
});
