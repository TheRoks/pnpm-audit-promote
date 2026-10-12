import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../../src/logger';
import { parsePnpmAuditOutput } from '../../src/audit/pnpmAudit';
import { captureInitialState } from '../../src/refresh/initialState';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function createWorkspace(): WorkspaceState {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-refresh-initial-'));
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.0.0' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmp, 'pnpm-workspace.yaml'),
    "catalog:\n  lodash: '^1.0.0'\n\noverrides:\n  lodash: '^1.0.0'\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmp, 'pnpm-lock.yaml'),
    'packages:\n  lodash@1.0.0: {}\n  lodash@1.2.0: {}\n',
    'utf8',
  );
  return WorkspaceState.initialize(tmp);
}

describe('captureInitialState', () => {
  it('REQ-CORE-008, REQ-OVERRIDES-010: shares one parsed baseline audit with summary and safe-version capture', async () => {
    const state = createWorkspace();
    const auditJson = JSON.stringify({
      advisories: {
        'GHSA-example': {
          module_name: 'lodash',
          severity: 'high',
          title: 'Example issue',
          findings: [{ version: '1.0.0' }],
        },
      },
    });
    const { runner, calls } = makeRecordingRunner({ 'audit --json': auditJson });

    const initial = await captureInitialState(state, runner, silentLogger, {
      skipAudit: false,
      dryRun: false,
    });

    expect(calls).toHaveLength(1);
    expect(initial.preCleanupAudit).toEqual(parsePnpmAuditOutput(auditJson));
    expect(initial.initialAdvisories).toEqual([
      {
        id: 'GHSA-example',
        module: 'lodash',
        severity: 'high',
        title: 'Example issue',
        url: undefined,
        cves: [],
      },
    ]);
    expect(initial.baselineSafeVersions.get('lodash')).toBe('1.2.0');
  });

  it('REQ-AUDIT-008: leaves the pre-cleanup snapshot empty for pnpm error-shaped JSON', async () => {
    const state = createWorkspace();
    const { runner } = makeRecordingRunner({
      'audit --json': '{"error":{"message":"no lockfile"}}',
    });

    const initial = await captureInitialState(state, runner, silentLogger, {
      skipAudit: false,
      dryRun: false,
    });

    expect(initial.preCleanupAudit).toBeNull();
    expect(initial.initialAdvisories).toEqual([]);
    expect(initial.baselineSafeVersions).toEqual(new Map());
  });
});
