import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceYamlSnapshot } from '../../src/workspace/yamlSnapshot';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('WorkspaceYamlSnapshot desired writes', () => {
  it('REQ-CORE-003: updates the in-memory desired snapshot and disk together', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-yaml-snapshot-'));
    const yamlPath = path.join(tmp, 'pnpm-workspace.yaml');
    fs.writeFileSync(yamlPath, 'catalog: {}\n', 'utf8');
    const snapshot = new WorkspaceYamlSnapshot(yamlPath);
    snapshot.initialize(true, false);

    snapshot.writeDesiredWorkspaceYaml('catalog:\n  react: 19.0.0\n');

    expect(snapshot.desiredWorkspaceYaml).toBe('catalog:\n  react: 19.0.0\n');
    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(snapshot.desiredWorkspaceYaml);
  });

  it('REQ-CORE-002: updates the desired snapshot without writing during dry-run', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-yaml-snapshot-'));
    const yamlPath = path.join(tmp, 'pnpm-workspace.yaml');
    const original = 'catalog: {}\n';
    fs.writeFileSync(yamlPath, original, 'utf8');
    const snapshot = new WorkspaceYamlSnapshot(yamlPath);
    snapshot.initialize(true, true);

    snapshot.writeDesiredWorkspaceYaml('catalog:\n  react: 19.0.0\n');

    expect(snapshot.desiredWorkspaceYaml).toContain('react: 19.0.0');
    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(original);
  });
});
