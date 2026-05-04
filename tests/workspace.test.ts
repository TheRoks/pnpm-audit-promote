import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../src/logger.js';
import { WorkspaceState, resolveWorkspacePackageDirs } from '../src/workspace.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-workspace-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('WorkspaceState', () => {
  it('throws when pnpm-workspace.yaml is missing', () => {
    expect(() => WorkspaceState.initialize(tmp)).toThrow(/pnpm-workspace.yaml not found/);
  });

  it('initializes and detects CRLF line endings', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), "catalog:\r\n  react: '18.2.0'\r\n", 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    expect(ws.yamlEol).toBe('\r\n');
    expect(ws.desiredWorkspaceYaml).toContain("react: '18.2.0'");
  });

  it('keeps current EOL when detectEol read fails', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), "catalog:\n  react: '18.2.0'\n", 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    fs.rmSync(path.join(tmp, 'pnpm-workspace.yaml'), { force: true });
    ws.detectEol();
    expect(ws.yamlEol).toBe('\n');
  });

  it('restores workspace yaml when content drift is detected', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), "catalog:\n  react: '18.2.0'\n", 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    ws.desiredWorkspaceYaml = "catalog:\n  react: '18.3.1'\n";
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), "catalog:\n  react: '18.2.0'\n", 'utf8');

    const restored = ws.restoreWorkspaceYaml(silentLogger);
    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain("18.3.1");
  });

  it('does not restore when desired content is empty', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), "catalog:\n  react: '18.2.0'\n", 'utf8');
    const ws = WorkspaceState.initialize(tmp);
    ws.desiredWorkspaceYaml = '';
    expect(ws.restoreWorkspaceYaml(silentLogger)).toBe(false);
  });
});

describe('resolveWorkspacePackageDirs', () => {
  it('returns null when no workspace patterns exist', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'catalog:\n  react: "18.2.0"\n', 'utf8');
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
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'catalog:\n  react: "18.2.0"\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }), 'utf8');
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
});
