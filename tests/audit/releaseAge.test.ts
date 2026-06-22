import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '../../src/logger';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';
import {
  guardWorkspaceOverrideReleaseAge,
  isExcludedByReleaseAge,
  isOldEnough,
  parseMinimumReleaseAgeExclude,
  readMinimumReleaseAge,
} from '../../src/audit/releaseAge';

const NOW = new Date('2025-01-01T00:00:00Z');
const FRESH = '2024-12-31T23:50:00Z'; // 10 minutes before NOW
const OLD = '2024-12-01T00:00:00Z'; // ~44640 minutes before NOW
const MINUTES = 720; // 12 hours

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-releaseage-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function initWorkspace(yaml: string): WorkspaceState {
  fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
  return WorkspaceState.initialize(tmp);
}

describe('readMinimumReleaseAge', () => {
  it('REQ-PNPM11-012: returns the positive numeric value', () => {
    expect(readMinimumReleaseAge('minimumReleaseAge: 720\n')).toBe(720);
  });

  it('REQ-PNPM11-012: parses a string value', () => {
    expect(readMinimumReleaseAge("minimumReleaseAge: '1440'\n")).toBe(1440);
  });

  it('REQ-PNPM11-012: returns null for zero, negative, or absent', () => {
    expect(readMinimumReleaseAge('minimumReleaseAge: 0\n')).toBeNull();
    expect(readMinimumReleaseAge('minimumReleaseAge: -5\n')).toBeNull();
    expect(readMinimumReleaseAge('catalog:\n  react: 18.2.0\n')).toBeNull();
    expect(readMinimumReleaseAge('')).toBeNull();
  });
});

describe('parseMinimumReleaseAgeExclude', () => {
  it('REQ-PNPM11-012: parses sequence entries with and without version qualifiers', () => {
    const entries = parseMinimumReleaseAgeExclude(
      "minimumReleaseAgeExclude:\n  - '@achmea/*'\n  - 'nx@21.6.5'\n  - lodash\n",
    );
    expect(entries).toEqual([
      { name: '@achmea/*' },
      { name: 'nx', range: '21.6.5' },
      { name: 'lodash' },
    ]);
  });

  it('REQ-PNPM11-012: parses a mapping form block', () => {
    const entries = parseMinimumReleaseAgeExclude(
      "minimumReleaseAgeExclude:\n  axios: '>=1.7.0'\n",
    );
    expect(entries).toEqual([{ name: 'axios', range: '>=1.7.0' }]);
  });

  it('REQ-PNPM11-012: returns [] when absent or unparseable', () => {
    expect(parseMinimumReleaseAgeExclude('catalog:\n  react: 18.2.0\n')).toEqual([]);
    expect(parseMinimumReleaseAgeExclude('')).toEqual([]);
  });
});

describe('isExcludedByReleaseAge', () => {
  it('REQ-PNPM11-012: matches a bare-name entry', () => {
    expect(isExcludedByReleaseAge('lodash', '4.17.21', [{ name: 'lodash' }])).toBe(true);
  });

  it('REQ-PNPM11-012: matches a scoped glob entry', () => {
    expect(isExcludedByReleaseAge('@achmea/ui', '1.0.0', [{ name: '@achmea/*' }])).toBe(true);
  });

  it('REQ-PNPM11-012: honours a version-range qualifier', () => {
    const entries = [{ name: 'axios', range: '>=1.7.0' }];
    expect(isExcludedByReleaseAge('axios', '1.7.4', entries)).toBe(true);
    expect(isExcludedByReleaseAge('axios', '1.6.0', entries)).toBe(false);
  });

  it('REQ-PNPM11-012: does not match an unrelated package', () => {
    expect(isExcludedByReleaseAge('react', '18.2.0', [{ name: 'lodash' }])).toBe(false);
  });
});

describe('isOldEnough', () => {
  it('REQ-PNPM11-012: treats a missing publish time as old enough', () => {
    expect(isOldEnough(undefined, MINUTES, NOW)).toBe(true);
    expect(isOldEnough('not-a-date', MINUTES, NOW)).toBe(true);
  });

  it('REQ-PNPM11-012: rejects a too-fresh version and accepts a mature one', () => {
    expect(isOldEnough(FRESH, MINUTES, NOW)).toBe(false);
    expect(isOldEnough(OLD, MINUTES, NOW)).toBe(true);
  });
});

describe('guardWorkspaceOverrideReleaseAge', () => {
  it('REQ-PNPM11-012: drops a too-fresh exact-version override and rewrites the file', async () => {
    const ws = initWorkspace(
      `minimumReleaseAge: ${MINUTES}\noverrides:\n  axios: 1.7.4\ncatalog:\n  axios: '1.6.0'\n`,
    );
    const { runner } = makeRecordingRunner(
      { 'view axios time --json': JSON.stringify({ '1.7.4': FRESH }) },
      { version: '11.1.2' },
    );

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([{ key: 'axios', name: 'axios', value: '1.7.4' }]);
    const after = fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8');
    expect(after).not.toContain('overrides');
    expect(after).not.toContain('1.7.4');
  });

  it('REQ-PNPM11-012: keeps an override whose pinned version is old enough', async () => {
    const ws = initWorkspace(`minimumReleaseAge: ${MINUTES}\noverrides:\n  axios: 1.7.4\n`);
    const { runner } = makeRecordingRunner(
      { 'view axios time --json': JSON.stringify({ '1.7.4': OLD }) },
      { version: '11.1.2' },
    );

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([]);
    expect(fs.readFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'axios: 1.7.4',
    );
  });

  it('REQ-PNPM11-012: keeps an override the user already excluded', async () => {
    const ws = initWorkspace(
      `minimumReleaseAge: ${MINUTES}\nminimumReleaseAgeExclude:\n  - axios\noverrides:\n  axios: 1.7.4\n`,
    );
    const { runner, calls } = makeRecordingRunner(
      { 'view axios time --json': JSON.stringify({ '1.7.4': FRESH }) },
      { version: '11.1.2' },
    );

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([]);
    // Excluded packages must not even incur a registry lookup.
    expect(calls.some((c) => c.args.join(' ') === 'view axios time --json')).toBe(false);
  });

  it('REQ-PNPM11-012: drops a range override when no satisfying version is old enough', async () => {
    const ws = initWorkspace(`minimumReleaseAge: ${MINUTES}\noverrides:\n  vite: '>=7.0.0'\n`);
    const { runner } = makeRecordingRunner(
      {
        'view vite versions --json': JSON.stringify(['6.0.0', '7.0.0', '7.1.0']),
        'view vite time --json': JSON.stringify({ '7.0.0': FRESH, '7.1.0': FRESH }),
      },
      { version: '11.1.2' },
    );

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([{ key: 'vite', name: 'vite', value: '>=7.0.0' }]);
  });

  it('REQ-PNPM11-012: keeps a range override when at least one satisfying version is old enough', async () => {
    const ws = initWorkspace(`minimumReleaseAge: ${MINUTES}\noverrides:\n  vite: '>=7.0.0'\n`);
    const { runner } = makeRecordingRunner(
      {
        'view vite versions --json': JSON.stringify(['7.0.0', '7.1.0']),
        'view vite time --json': JSON.stringify({ '7.0.0': OLD, '7.1.0': FRESH }),
      },
      { version: '11.1.2' },
    );

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([]);
  });

  it('REQ-PNPM11-012: keeps an override when registry publish time is unavailable', async () => {
    const ws = initWorkspace(`minimumReleaseAge: ${MINUTES}\noverrides:\n  axios: 1.7.4\n`);
    const { runner } = makeRecordingRunner({}, { version: '11.1.2' });

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([]);
  });

  it('REQ-PNPM11-012: is a no-op when no minimumReleaseAge is configured', async () => {
    const ws = initWorkspace('overrides:\n  axios: 1.7.4\n');
    const { runner, calls } = makeRecordingRunner({}, { version: '11.1.2' });

    const dropped = await guardWorkspaceOverrideReleaseAge(ws, runner, silentLogger, { now: NOW });

    expect(dropped).toEqual([]);
    expect(calls).toEqual([]);
  });
});
