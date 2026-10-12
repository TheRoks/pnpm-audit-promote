import { describe, expect, it } from 'vitest';
import { parsePnpmAuditOutput } from '../../src/audit/pnpmAudit';

describe('parsePnpmAuditOutput', () => {
  it('REQ-AUDIT-008: normalizes advisory fields and finding versions', () => {
    const result = parsePnpmAuditOutput(
      JSON.stringify({
        advisories: {
          'GHSA-test': {
            module_name: 'example',
            severity: 'high',
            title: 'Example advisory',
            findings: [{ version: '1.0.0', paths: ['example'] }, null],
          },
        },
      }),
    );

    expect(result).toEqual({
      complete: true,
      audit: {
        advisories: {
          'GHSA-test': {
            module_name: 'example',
            patched_versions: undefined,
            vulnerable_versions: undefined,
            severity: 'high',
            title: 'Example advisory',
            github_advisory_id: undefined,
            cves: undefined,
            url: undefined,
            findings: [{ version: '1.0.0', paths: ['example'] }],
          },
        },
      },
      topLevelKeys: ['advisories'],
    });
  });

  it('REQ-AUDIT-008: distinguishes malformed and pnpm error-shaped responses', () => {
    expect(parsePnpmAuditOutput('not json')).toMatchObject({
      complete: false,
      reason: 'invalid-json',
    });
    expect(parsePnpmAuditOutput('{"error":{}}')).toEqual({
      complete: false,
      reason: 'invalid-shape',
      topLevelKeys: ['error'],
    });
    expect(parsePnpmAuditOutput('{"advisories":[]}')).toMatchObject({
      complete: false,
      reason: 'invalid-shape',
    });
  });
});
