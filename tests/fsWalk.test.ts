import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findNodeModulesFolders, findWorkspaceFiles } from '../src/fsWalk';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-fswalk-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findNodeModulesFolders', () => {
  it('REQ-WORKSPACE-009: finds node_modules while pruning generated directories', () => {
    fs.mkdirSync(path.join(tmp, 'app', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages', 'a', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist', 'node_modules'), { recursive: true }); // pruned parent

    const found = findNodeModulesFolders(tmp)
      .map((p) => path.relative(tmp, p).replace(/\\/g, '/'))
      .sort();

    expect(found).toEqual(['app/node_modules', 'packages/a/node_modules']);
  });

  it('REQ-WORKSPACE-009: returns empty list when root cannot be read', () => {
    const missing = path.join(tmp, 'does-not-exist');
    const found = findNodeModulesFolders(missing);
    expect(found).toEqual([]);
  });
});

describe('findWorkspaceFiles', () => {
  it('REQ-WORKSPACE-009: finds matching files while pruning generated directories', () => {
    fs.mkdirSync(path.join(tmp, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'coverage', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(tmp, 'apps', 'web', 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(tmp, 'coverage', 'x', 'package.json'), '{}', 'utf8');

    const found = findWorkspaceFiles(tmp, 'package.json')
      .map((p) => path.relative(tmp, p).replace(/\\/g, '/'))
      .sort();

    expect(found).toEqual(['apps/web/package.json', 'package.json']);
  });

  it('REQ-WORKSPACE-009: returns empty list when root cannot be read', () => {
    const missing = path.join(tmp, 'missing-root');
    const found = findWorkspaceFiles(missing, 'package.json');
    expect(found).toEqual([]);
  });
});
