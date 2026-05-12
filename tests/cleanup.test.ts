import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../src/logger';
import {
  removeNodeModulesFolders,
  removePackageJsonOverrides,
  removePnpmLockFile,
  removeWorkspaceOverridesBlock,
} from '../src/cleanup';
import { WorkspaceState } from '../src/workspace';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-cleanup-'));
  fs.writeFileSync(
    path.join(tmp, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n\noverrides:\n  react: '18.3.1'\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'root', pnpm: { overrides: { react: '18.3.1' } } }, null, 2),
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeState(): WorkspaceState {
  return WorkspaceState.initialize(tmp);
}

describe('cleanup helpers', () => {
  it('removes lockfile and handles missing lockfile', () => {
    const state = makeState();
    fs.writeFileSync(state.lockFile, 'x', 'utf8');
    const logs: string[] = [];
    const logger = createLogger({
      out: (l) => logs.push(l),
      err: (l) => logs.push(l),
      color: false,
    });

    removePnpmLockFile(state, logger);
    expect(fs.existsSync(state.lockFile)).toBe(false);

    removePnpmLockFile(state, logger);
    expect(logs.some((l) => /No pnpm-lock.yaml found/.test(l))).toBe(true);
  });

  it('supports dry-run lockfile removal messaging', () => {
    const state = makeState();
    state.dryRun = true;
    fs.writeFileSync(state.lockFile, 'x', 'utf8');
    const logs: string[] = [];
    const logger = createLogger({ out: (l) => logs.push(l), color: false });

    removePnpmLockFile(state, logger);

    expect(fs.existsSync(state.lockFile)).toBe(true);
    expect(logs.some((l) => /Dry-run: would remove/.test(l))).toBe(true);
  });

  it('removes node_modules directories and logs a summary', async () => {
    const state = makeState();
    fs.mkdirSync(path.join(tmp, 'apps', 'web', 'node_modules'), { recursive: true });

    const details: string[] = [];
    const logger = {
      ...createLogger({ color: false }),
      detail(message: string) {
        details.push(message);
      },
    };

    await removeNodeModulesFolders(state, logger);
    expect(fs.existsSync(path.join(tmp, 'apps', 'web', 'node_modules'))).toBe(false);
    expect(details.some((d) => /Removed 1\/1 node_modules directories/.test(d))).toBe(true);
  });

  it('renders spinner output in TTY detail mode', async () => {
    const state = makeState();
    fs.mkdirSync(path.join(tmp, 'apps', 'web', 'node_modules'), { recursive: true });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const logger = createLogger({ level: 'normal', color: false });
    try {
      await removeNodeModulesFolders(state, logger);
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      }
    }

    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((w) => /Removing node_modules/.test(w))).toBe(true);
    expect(writes.some((w) => w.endsWith('\u001b[2K'))).toBe(true);
  });

  it('handles no node_modules directories', async () => {
    const state = makeState();
    const lines: string[] = [];
    const logger = createLogger({ out: (l) => lines.push(l), color: false });

    await removeNodeModulesFolders(state, logger);

    expect(lines.some((l) => /No node_modules directories found/.test(l))).toBe(true);
  });

  it('strips workspace overrides block when present and keeps file when missing', () => {
    const state = makeState();
    const logger = createLogger({ color: false });

    removeWorkspaceOverridesBlock(state, logger);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(
      'overrides:',
    );

    removeWorkspaceOverridesBlock(state, logger);
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('skips workspace overrides cleanup when no pnpm-workspace.yaml is present', () => {
    fs.rmSync(path.join(tmp, 'pnpm-workspace.yaml'), { force: true });
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', packageManager: 'pnpm@10.0.0' }),
      'utf8',
    );
    const state = WorkspaceState.initialize(tmp);
    const lines: string[] = [];
    const logger = createLogger({ out: (l) => lines.push(l), color: false });

    removeWorkspaceOverridesBlock(state, logger);

    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(false);
    expect(lines.some((l) => /skipping workspace overrides cleanup/.test(l))).toBe(true);
  });

  it('removes pnpm.overrides from package.json and skips invalid post-edit JSON', () => {
    const state = makeState();
    fs.mkdirSync(path.join(tmp, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'apps', 'web', 'package.json'),
      '{\n  "name": "web",\n  "pnpm": { "overrides": { "react": "18.3.1" } }\n}\n',
      'utf8',
    );

    const warn = vi.fn();
    const logger = {
      ...createLogger({ color: false }),
      warn,
    };

    removePackageJsonOverrides(state, logger);

    const rootPkg = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    expect(rootPkg).not.toContain('"overrides"');
    const childPkg = fs.readFileSync(path.join(tmp, 'apps', 'web', 'package.json'), 'utf8');
    expect(childPkg).not.toContain('"overrides"');

    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new Error('parse fail');
    });
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', pnpm: { overrides: { react: '18.3.1' } } }, null, 2),
      'utf8',
    );
    removePackageJsonOverrides(state, logger);
    expect(parseSpy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('cleanup helpers — single-package mode', () => {
  let single: string;

  beforeEach(() => {
    single = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-cleanup-single-'));
    fs.writeFileSync(
      path.join(single, 'package.json'),
      JSON.stringify(
        {
          name: 'app',
          packageManager: 'pnpm@10.8.0',
          pnpm: { overrides: { react: '18.3.1' } },
        },
        null,
        2,
      ),
      'utf8',
    );
    // Nested unrelated project that must NOT be touched.
    fs.mkdirSync(path.join(single, 'sub', 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(single, 'sub', 'package.json'),
      JSON.stringify({ name: 'sub', pnpm: { overrides: { react: '18.0.0' } } }, null, 2),
      'utf8',
    );
    // Root-level node_modules that SHOULD be removed.
    fs.mkdirSync(path.join(single, 'node_modules'));
  });

  afterEach(() => {
    fs.rmSync(single, { recursive: true, force: true });
  });

  it('detects single-package mode when no workspace.yaml and no workspaces field exist', () => {
    const state = WorkspaceState.initialize(single);
    expect(state.hasWorkspaceYaml).toBe(false);
    expect(state.isMultiPackageWorkspace).toBe(false);
  });

  it('removes only the root node_modules in single-package mode', async () => {
    const state = WorkspaceState.initialize(single);
    const logger = createLogger({ color: false });

    await removeNodeModulesFolders(state, logger);

    expect(fs.existsSync(path.join(single, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(single, 'sub', 'node_modules'))).toBe(true);
  });

  it('strips pnpm.overrides only from the root package.json in single-package mode', () => {
    const state = WorkspaceState.initialize(single);
    const logger = createLogger({ color: false });

    removePackageJsonOverrides(state, logger);

    const rootPkg = fs.readFileSync(path.join(single, 'package.json'), 'utf8');
    expect(rootPkg).not.toContain('"overrides"');
    const subPkg = fs.readFileSync(path.join(single, 'sub', 'package.json'), 'utf8');
    expect(subPkg).toContain('"overrides"');
  });

  it('treats a non-empty root workspaces array as multi-package', () => {
    fs.writeFileSync(
      path.join(single, 'package.json'),
      JSON.stringify(
        {
          name: 'app',
          packageManager: 'pnpm@10.8.0',
          workspaces: ['sub'],
          pnpm: { overrides: { react: '18.3.1' } },
        },
        null,
        2,
      ),
      'utf8',
    );

    const state = WorkspaceState.initialize(single);
    expect(state.isMultiPackageWorkspace).toBe(true);
  });
});
