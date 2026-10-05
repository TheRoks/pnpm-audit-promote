import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  advisoryMatchesIgnoreList,
  getDirectDepCatalogBumps,
} from '../../src/audit/parseAdvisories';
import { silentLogger } from '../../src/logger';
import { WorkspaceState } from '../../src/workspace';
import { makeRecordingRunner } from '../helpers/recordingRunner';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('getDirectDepCatalogBumps', () => {
  it('REQ-AUDIT-014: skips a catalog bump when published versions do not satisfy the patched range', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-advisory-'));
    fs.writeFileSync(
      path.join(tmp, 'pnpm-workspace.yaml'),
      "catalog:\n  '@nx/azure-cache': 5.0.7\n",
      'utf8',
    );
    const state = WorkspaceState.initialize(tmp);
    const auditJson = JSON.stringify({
      advisories: {
        '1': {
          module_name: '@nx/azure-cache',
          vulnerable_versions: '<=5.0.7',
          patched_versions: '>=21.0.0',
        },
      },
    });
    const { runner } = makeRecordingRunner({
      'audit --json': auditJson,
      'view @nx/azure-cache versions --json': JSON.stringify(['5.0.7', '21.0.0-beta.0']),
    });

    const result = await getDirectDepCatalogBumps(state, runner, silentLogger);

    expect(result.bumps).toEqual(new Map());
    expect(result.tiers).toEqual(new Map());
  });
});

describe('advisoryMatchesIgnoreList', () => {
  it('REQ-AUDIT-011: returns false when ignoredIds is empty', () => {
    expect(advisoryMatchesIgnoreList({}, new Set())).toBe(false);
  });

  it('REQ-AUDIT-011: returns false when advisory has no identifiers', () => {
    expect(advisoryMatchesIgnoreList({}, new Set(['GHSA-aaaa-bbbb-cccc']))).toBe(false);
  });

  it('REQ-AUDIT-011: matches by github_advisory_id', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match a different github_advisory_id', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-1111-2222-3333']),
      ),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: matches GHSA ID extracted from advisory url', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match when url GHSA differs from ignore list', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
        new Set(['GHSA-1111-2222-3333']),
      ),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: matches by CVE in cves array', () => {
    expect(
      advisoryMatchesIgnoreList({ cves: ['CVE-2021-12345'] }, new Set(['CVE-2021-12345'])),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: does not match when no CVE in ignore list', () => {
    expect(
      advisoryMatchesIgnoreList({ cves: ['CVE-2021-12345'] }, new Set(['CVE-2099-99999'])),
    ).toBe(false);
  });

  it('REQ-AUDIT-011: case-insensitively matches GHSA from url', () => {
    expect(
      advisoryMatchesIgnoreList(
        { url: 'https://github.com/advisories/ghsa-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: case-insensitively matches github_advisory_id when ignore list uses lowercase', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
        new Set(['ghsa-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: case-insensitively matches github_advisory_id when advisory id is lowercase', () => {
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'ghsa-aaaa-bbbb-cccc' },
        new Set(['GHSA-aaaa-bbbb-cccc']),
      ),
    ).toBe(true);
  });

  it('REQ-AUDIT-011: matches github_advisory_id when no url is present and only direct id check applies', () => {
    // Ensures the case-insensitive direct-id check works even when adv.url is absent,
    // covering the gap where a user writes lowercase IDs in ignoreGhsas config.
    expect(
      advisoryMatchesIgnoreList(
        { github_advisory_id: 'GHSA-xxxx-yyyy-zzzz' },
        new Set(['ghsa-xxxx-yyyy-zzzz']),
      ),
    ).toBe(true);
  });
});
