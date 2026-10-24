import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceMutations } from '../../src/workspace/mutations';

let root: string;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceMutations', () => {
  it('REQ-FS-001: atomically writes workspace files and leaves no temporary file', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mutations-'));
    const filePath = path.join(root, 'package.json');
    fs.writeFileSync(filePath, '{"before":true}\n', 'utf8');
    const mutations = new WorkspaceMutations(root);

    expect(mutations.writeTextFile(filePath, '{"after":true}\n')).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"after":true}\n');
    expect(fs.readdirSync(root)).toEqual(['package.json']);
  });

  it('REQ-FS-001: dry-run suppresses writes and removals', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mutations-'));
    const filePath = path.join(root, 'package.json');
    const directory = path.join(root, 'node_modules');
    fs.writeFileSync(filePath, '{"before":true}\n', 'utf8');
    fs.mkdirSync(directory);
    const mutations = new WorkspaceMutations(root, true);

    expect(mutations.writeTextFile(filePath, '{"after":true}\n')).toBe(false);
    expect(mutations.removeFileSync(filePath)).toBe(false);
    expect(await mutations.removeDirectory(directory)).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"before":true}\n');
    expect(fs.existsSync(directory)).toBe(true);
  });

  it('REQ-FS-002: rejects workspace mutations outside the root', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mutations-'));
    const outside = path.join(path.dirname(root), `pap-outside-${path.basename(root)}.txt`);
    const mutations = new WorkspaceMutations(root);

    expect(() => mutations.writeTextFile(outside, 'no')).toThrow(
      /not contained within workspace root/,
    );
    expect(() => mutations.removeFileSync(root)).toThrow(/not contained within workspace root/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('REQ-FS-002: rejects a symlinked parent that resolves outside the root', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mutations-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-mutations-outside-'));
    const link = path.join(root, 'outside');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const mutations = new WorkspaceMutations(root);

      expect(() => mutations.writeTextFile(path.join(link, 'package.json'), '{}')).toThrow(
        /parent resolves outside workspace root/,
      );
      expect(fs.existsSync(path.join(outside, 'package.json'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
