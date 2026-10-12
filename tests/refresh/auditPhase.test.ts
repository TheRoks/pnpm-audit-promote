import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePnpmAuditOutput } from '../../src/audit/pnpmAudit';
import { silentLogger } from '../../src/logger';
import { createProgressLogger } from '../../src/progress';
import { runAuditPhase } from '../../src/refresh/auditPhase';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('runAuditPhase', () => {
  it('REQ-AUDIT-008: parses the captured audit once and passes its snapshot to bump planners', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-refresh-audit-phase-'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.0.0' }),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'catalog: {}\n', 'utf8');
    const state = WorkspaceState.initialize(tmp);
    state.recordPnpmMajor(10);
    state.recordPnpmVersion('10.0.0');
    const auditJson = '{"advisories":{}}';
    const { runner, calls } = makeRecordingRunner({ 'audit --json': auditJson });

    const result = await runAuditPhase(
      state,
      runner,
      silentLogger,
      createProgressLogger(silentLogger, 6),
      {
        skipDedupe: true,
        allowMajor: true,
        releaseAgeCheck: false,
        dryRun: false,
        preCleanupAudit: parsePnpmAuditOutput(auditJson),
        baselineSafeVersions: new Map(),
        originalOverrides: new Map(),
        ignoreWorkspace: false,
        auditFixMode: 'override',
      },
    );

    expect(result).toEqual({ pkgJsonDepChanges: [], releaseAgeBlockedOverrides: [] });
    expect(
      calls.filter((call) => call.capture && call.args.join(' ') === 'audit --json'),
    ).toHaveLength(1);
    expect(calls.map((call) => call.args)).toContainEqual(['audit', '--fix']);
    expect(calls.map((call) => call.args)).toContainEqual(['install', '--no-frozen-lockfile']);
  });
});
