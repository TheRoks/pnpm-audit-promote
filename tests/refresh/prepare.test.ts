import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../../src/logger';
import { prepareRun } from '../../src/refresh/prepare';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp = '';

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('prepareRun pnpm capability resolution', () => {
  it('REQ-PNPM-CAP-005, REQ-PNPM-CFG-001: resolves a ranged pnpm pin before enabling delegated settings', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-pnpm-range-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'root',
        devEngines: {
          packageManager: { name: 'pnpm', version: '>=12.15.0 <13.0.0' },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      'include:\n  ./config/policy.yaml: [overrides]\n',
      'utf8',
    );
    fs.mkdirSync(path.join(tmp, 'config'));
    fs.writeFileSync(path.join(tmp, 'config', 'policy.yaml'), 'overrides:\n  lodash: 4.17.21\n');
    const { runner } = makeRecordingRunner({}, { version: '12.15.4' });

    const prepared = await prepareRun({
      path: tmp,
      logger: silentLogger,
      pnpm: runner,
      dryRun: true,
      skipAudit: true,
    });

    expect(prepared.state.pnpmCapabilities.version).toBe('12.15.4');
    expect(prepared.state.configuration.isEnabled).toBe(true);
    expect(prepared.state.configuration.getOwnerSnapshot('overrides')?.path).toBe(
      path.join(tmp, 'config', 'policy.yaml'),
    );
  });
});
