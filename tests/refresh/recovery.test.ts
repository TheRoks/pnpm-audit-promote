import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PnpmCommandFailedError } from '../../src/errors';
import { silentLogger } from '../../src/logger';
import { refreshDeps } from '../../src/refresh';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let root: string;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('refresh failure recovery', () => {
  it('REQ-CORE-012: restores workspace control files after cleanup when install fails', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-recovery-'));
    const appDir = path.join(root, 'apps', 'app');
    fs.mkdirSync(appDir, { recursive: true });
    const yamlPath = path.join(root, 'pnpm-workspace.yaml');
    const rootPackagePath = path.join(root, 'package.json');
    const appPackagePath = path.join(appDir, 'package.json');
    const lockPath = path.join(root, 'pnpm-lock.yaml');
    const originalYaml = "packages:\n  - 'apps/*'\noverrides:\n  lodash: 4.17.20\n";
    const originalRootPackage = '{"name":"root","pnpm":{"overrides":{"react":"18.2.0"}}}\n';
    const originalAppPackage = '{"name":"app","pnpm":{"overrides":{"lodash":"4.17.20"}}}\n';
    const originalLock = 'lockfileVersion: 9.0\n';
    fs.writeFileSync(yamlPath, originalYaml, 'utf8');
    fs.writeFileSync(rootPackagePath, originalRootPackage, 'utf8');
    fs.writeFileSync(appPackagePath, originalAppPackage, 'utf8');
    fs.writeFileSync(lockPath, originalLock, 'utf8');

    const { runner } = makeRecordingRunner();
    runner.run = async () => {
      throw new Error('simulated install failure');
    };

    await expect(
      refreshDeps({
        path: root,
        force: true,
        logger: silentLogger,
        pnpm: runner,
        skipAudit: true,
        skipDedupe: true,
      }),
    ).rejects.toThrow('simulated install failure');

    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(originalYaml);
    expect(fs.readFileSync(rootPackagePath, 'utf8')).toBe(originalRootPackage);
    expect(fs.readFileSync(appPackagePath, 'utf8')).toBe(originalAppPackage);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(originalLock);
  });

  it('REQ-CORE-011, REQ-CORE-012: retains approved build decisions during failure recovery', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-recovery-'));
    const yamlPath = path.join(root, 'pnpm-workspace.yaml');
    const originalYaml = "packages: []\ncatalog:\n  react: '18.2.0'\n";
    fs.writeFileSync(yamlPath, originalYaml, 'utf8');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"root"}\n', 'utf8');
    const { runner } = makeRecordingRunner();
    let installCount = 0;
    runner.run = async (args) => {
      if (args[0] !== 'install') return;
      installCount += 1;
      if (installCount === 1) {
        throw new PnpmCommandFailedError(args, 1, 'ERR_PNPM_IGNORED_BUILDS');
      }
      throw new Error('failure after approval');
    };
    runner.runInteractive = async () => {
      fs.writeFileSync(
        yamlPath,
        "packages: []\ncatalog:\n  react: '18.2.0'\nallowBuilds:\n  canvas: false\n",
        'utf8',
      );
    };
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      await expect(
        refreshDeps({
          path: root,
          force: true,
          logger: silentLogger,
          pnpm: runner,
          skipAudit: true,
          skipDedupe: true,
        }),
      ).rejects.toThrow('failure after approval');
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }

    const recoveredYaml = fs.readFileSync(yamlPath, 'utf8');
    expect(recoveredYaml).toContain("react: '18.2.0'");
    expect(recoveredYaml).toContain('allowBuilds:');
    expect(recoveredYaml).toContain('canvas: false');
  });
});
