import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../src/logger';
import {
  WorkspaceState,
  detectWorkspacePnpmMajor,
  resolveWorkspacePackageDirs,
} from '../src/workspace';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-workspace-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('WorkspaceState', () => {
  it('throws when neither pnpm-workspace.yaml nor a pnpm packageManager is present', () => {
    expect(() => WorkspaceState.initialize(tmp)).toThrow(/No pnpm workspace found/);
  });

  it('throws when package.json exists but does not declare pnpm', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'yarn@4.0.0' }),
      'utf8',
    );
    expect(() => WorkspaceState.initialize(tmp)).toThrow(/No pnpm workspace found/);
  });

  it('initializes from package.json with pnpm packageManager when yaml is missing', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'pnpm@10.0.0' }),
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.hasWorkspaceYaml).toBe(false);
    expect(ws.desiredWorkspaceYaml).toBe('');
    expect(ws.readWorkspaceYaml()).toBe('');
    ws.saveWorkspaceYaml('catalog:\n  react: "1.0.0"\n');
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(false);
    expect(ws.restoreWorkspaceYaml(silentLogger)).toBe(false);
  });

  it('initializes from package.json with a pnpm config object when yaml is missing', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', pnpm: { overrides: {} } }),
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.hasWorkspaceYaml).toBe(false);
  });

  it('initializes when a sibling pnpm-lock.yaml is present', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.hasWorkspaceYaml).toBe(false);
  });

  it('throws EnclosingWorkspaceError when a parent has pnpm-workspace.yaml', () => {
    const sub = path.join(tmp, 'examples', 'angular');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'examples/*'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(sub, 'package.json'),
      JSON.stringify({ name: 'x', pnpm: { overrides: {} } }),
      'utf8',
    );
    expect(() => WorkspaceState.initialize(sub)).toThrow(/enclosing pnpm workspace/i);
  });

  it('honors ignoreParentWorkspace and proceeds despite an enclosing yaml', () => {
    const sub = path.join(tmp, 'examples', 'angular');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "packages:\n  - 'examples/*'\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(sub, 'package.json'),
      JSON.stringify({ name: 'x', pnpm: { overrides: {} } }),
      'utf8',
    );
    const ws = WorkspaceState.initialize(sub, { ignoreParentWorkspace: true });
    expect(ws.workspaceRoot).toBe(path.resolve(sub));
    expect(ws.hasWorkspaceYaml).toBe(false);
  });

  it('tolerates malformed package.json when checking packageManager', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not json', 'utf8');
    expect(() => WorkspaceState.initialize(tmp)).toThrow(/No pnpm workspace found/);
  });

  it('initializes and detects CRLF line endings', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\r\n  react: '18.2.0'\r\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.yamlEol).toBe('\r\n');
    expect(ws.desiredWorkspaceYaml).toContain("react: '18.2.0'");
  });

  it('keeps current EOL when detectEol read fails', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    fs.rmSync(path.join(tmp, 'pnpm-workspace.yaml'), { force: true });
    ws.detectEol();
    expect(ws.yamlEol).toBe('\n');
  });

  it('restores workspace yaml when content drift is detected', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    ws.desiredWorkspaceYaml = "catalog:\n  react: '18.3.1'\n";
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );

    const restored = ws.restoreWorkspaceYaml(silentLogger);
    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain('18.3.1');
  });

  it('does not restore when desired content is empty', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    ws.desiredWorkspaceYaml = '';
    expect(ws.restoreWorkspaceYaml(silentLogger)).toBe(false);
  });

  it('initializes from package.json with devEngines.packageManager (string form)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', devEngines: { packageManager: 'pnpm@11.0.0' } }),
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.hasWorkspaceYaml).toBe(false);
  });

  it('initializes from package.json with devEngines.packageManager (object form)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'x',
        devEngines: { packageManager: { name: 'pnpm', version: '11' } },
      }),
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.hasWorkspaceYaml).toBe(false);
  });

  it('rejects devEngines.packageManager that names a non-pnpm manager', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', devEngines: { packageManager: 'yarn@4.0.0' } }),
      'utf8',
    );
    expect(() => WorkspaceState.initialize(tmp)).toThrow(/No pnpm workspace found/);
  });

  it('applies and reverts pnpm 11 minimumReleaseAge tweaks when major >= 11', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    ws.recordPnpmMajor(11);
    ws.applyPnpm11WorkspaceTweaks(silentLogger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'minimumReleaseAge: 0',
    );
    expect(ws.pnpm11TweaksApplied).toBe(true);
    ws.revertPnpm11WorkspaceTweaks(silentLogger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(
      'minimumReleaseAge',
    );
    expect(ws.pnpm11TweaksApplied).toBe(false);
  });

  it('restores the original minimumReleaseAge scalar after the run', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "minimumReleaseAge: 720\ncatalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    ws.recordPnpmMajor(11);
    ws.applyPnpm11WorkspaceTweaks(silentLogger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'minimumReleaseAge: 0',
    );
    ws.revertPnpm11WorkspaceTweaks(silentLogger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'minimumReleaseAge: 720',
    );
  });

  it('does not touch the yaml when pnpm major is < 11', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  react: '18.2.0'\n",
      'utf8',
    );
    const ws = WorkspaceState.initialize(tmp);
    ws.recordPnpmMajor(10);
    ws.applyPnpm11WorkspaceTweaks(silentLogger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(
      'minimumReleaseAge',
    );
    expect(ws.pnpm11TweaksApplied).toBe(false);
  });
});

describe('resolveWorkspacePackageDirs', () => {
  it('returns null when no workspace patterns exist', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      'catalog:\n  react: "18.2.0"\n',
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    expect(resolveWorkspacePackageDirs(ws)).toBeNull();
  });

  it('resolves package dirs from packages globs and exclusions', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      ['packages:', '  - "apps/*"', '  - "!apps/excluded"', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    fs.mkdirSync(path.join(tmp, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apps', 'excluded'), { recursive: true });

    const ws = WorkspaceState.initialize(tmp);
    const dirs = resolveWorkspacePackageDirs(ws);

    expect(dirs?.has(tmp)).toBe(true);
    expect(dirs?.has(path.join(tmp, 'apps', 'web'))).toBe(true);
    expect(dirs?.has(path.join(tmp, 'apps', 'excluded'))).toBe(false);
  });

  it('falls back to root package.json workspaces when yaml packages missing', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      'catalog:\n  react: "18.2.0"\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'utf8',
    );
    fs.mkdirSync(path.join(tmp, 'packages', 'a'), { recursive: true });

    const ws = WorkspaceState.initialize(tmp);
    const dirs = resolveWorkspacePackageDirs(ws);
    expect(dirs?.has(path.join(tmp, 'packages', 'a'))).toBe(true);
  });

  it('returns null when only negative patterns are present', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      ['packages:', '  - "!apps/*"', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');

    const ws = WorkspaceState.initialize(tmp);
    expect(resolveWorkspacePackageDirs(ws)).toBeNull();
  });

  it('matches brace-expansion globs (picomatch dialect)', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      ['packages:', '  - "{apps,libs}/*"', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    fs.mkdirSync(path.join(tmp, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'libs', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'tools', 'ignore-me'), { recursive: true });

    const ws = WorkspaceState.initialize(tmp);
    const dirs = resolveWorkspacePackageDirs(ws);
    expect(dirs?.has(path.join(tmp, 'apps', 'web'))).toBe(true);
    expect(dirs?.has(path.join(tmp, 'libs', 'core'))).toBe(true);
    expect(dirs?.has(path.join(tmp, 'tools', 'ignore-me'))).toBe(false);
  });

  it('matches deep ** globs (picomatch dialect)', () => {
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      ['packages:', '  - "packages/**"', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    fs.mkdirSync(path.join(tmp, 'packages', 'a', 'sub'), { recursive: true });

    const ws = WorkspaceState.initialize(tmp);
    const dirs = resolveWorkspacePackageDirs(ws);
    expect(dirs?.has(path.join(tmp, 'packages', 'a'))).toBe(true);
    expect(dirs?.has(path.join(tmp, 'packages', 'a', 'sub'))).toBe(true);
  });
});

describe('detectWorkspacePnpmMajor', () => {
  function write(json: unknown): string {
    const p = path.join(tmp, 'package.json');
    fs.writeFileSync(p, JSON.stringify(json), 'utf8');
    return p;
  }

  it('returns the major from `packageManager: pnpm@<major>.<minor>.<patch>`', () => {
    const p = write({ name: 'x', packageManager: 'pnpm@11.0.0' });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('returns the major from `packageManager: pnpm@10.33.0`', () => {
    const p = write({ name: 'x', packageManager: 'pnpm@10.33.0' });
    expect(detectWorkspacePnpmMajor(p)).toBe(10);
  });

  it('returns the major from bare-major `packageManager: pnpm@11`', () => {
    const p = write({ name: 'x', packageManager: 'pnpm@11' });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('accepts a corepack integrity suffix on packageManager', () => {
    const p = write({ name: 'x', packageManager: 'pnpm@11.0.0+sha512.deadbeef' });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('returns null when packageManager pins a different tool', () => {
    const p = write({ name: 'x', packageManager: 'yarn@4.0.0' });
    expect(detectWorkspacePnpmMajor(p)).toBeNull();
  });

  it('returns the major from devEngines.packageManager string form', () => {
    const p = write({ name: 'x', devEngines: { packageManager: 'pnpm@11.0.0' } });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('returns the major from devEngines.packageManager bare-major string', () => {
    const p = write({ name: 'x', devEngines: { packageManager: 'pnpm@11' } });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('returns the major from devEngines.packageManager object form', () => {
    const p = write({
      name: 'x',
      devEngines: { packageManager: { name: 'pnpm', version: '11.0.0' } },
    });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('strips semver range operators from devEngines version', () => {
    const p = write({
      name: 'x',
      devEngines: { packageManager: { name: 'pnpm', version: '^11.0.0' } },
    });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('handles devEngines version `>=11`', () => {
    const p = write({
      name: 'x',
      devEngines: { packageManager: { name: 'pnpm', version: '>=11' } },
    });
    expect(detectWorkspacePnpmMajor(p)).toBe(11);
  });

  it('ignores devEngines entries for other package managers', () => {
    const p = write({
      name: 'x',
      devEngines: { packageManager: { name: 'yarn', version: '4.0.0' } },
    });
    expect(detectWorkspacePnpmMajor(p)).toBeNull();
  });

  it('prefers packageManager over devEngines when both are present', () => {
    const p = write({
      name: 'x',
      packageManager: 'pnpm@10.33.0',
      devEngines: { packageManager: { name: 'pnpm', version: '11.0.0' } },
    });
    expect(detectWorkspacePnpmMajor(p)).toBe(10);
  });

  it('returns null when package.json is missing', () => {
    expect(detectWorkspacePnpmMajor(path.join(tmp, 'does-not-exist.json'))).toBeNull();
  });

  it('returns null when package.json is malformed', () => {
    const p = path.join(tmp, 'package.json');
    fs.writeFileSync(p, '{ not json', 'utf8');
    expect(detectWorkspacePnpmMajor(p)).toBeNull();
  });

  it('returns null when neither field is declared', () => {
    const p = write({ name: 'x' });
    expect(detectWorkspacePnpmMajor(p)).toBeNull();
  });
});
