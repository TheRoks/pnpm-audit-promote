import { describe, expect, it } from 'vitest';
import { readBaselineSafeVersions } from '../../src/audit/baselineSafeVersions';

describe('readBaselineSafeVersions', () => {
  it('REQ-OVERRIDES-010: keeps the highest audited-safe locked version per package', () => {
    const lock =
      'packages:\n  pdfjs-dist@4.2.67: {}\n  pdfjs-dist@4.10.38: {}\n  braces@3.0.3: {}\n';
    const audit = JSON.stringify({
      advisories: {
        '1': {
          module_name: 'braces',
          findings: [{ version: '3.0.3' }],
        },
      },
    });

    const safe = readBaselineSafeVersions(lock, audit);

    expect(safe.get('pdfjs-dist')).toBe('4.10.38');
    expect(safe.has('braces')).toBe(false);
  });

  it('REQ-OVERRIDES-010: does not trust locked versions when the initial audit is unavailable', () => {
    expect(readBaselineSafeVersions('packages:\n  pdfjs-dist@4.10.38: {}\n', '')).toEqual(
      new Map(),
    );
  });

  it('REQ-OVERRIDES-010: reads the workspace lock document in pnpm 12 multi-document locks', () => {
    const lock = [
      '---',
      'lockfileVersion: "9.0"',
      'importers:',
      '  .:',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.9.1',
      '        version: 12.9.1',
      'packages:',
      '  pnpm@12.9.1: {}',
      '---',
      'lockfileVersion: "9.0"',
      'settings:',
      '  autoInstallPeers: true',
      'importers:',
      '  .: {}',
      'packages:',
      '  pdfjs-dist@4.10.38: {}',
      '',
    ].join('\n');

    const safe = readBaselineSafeVersions(lock, JSON.stringify({ advisories: {} }));

    expect(safe.get('pdfjs-dist')).toBe('4.10.38');
    expect(safe.has('pnpm')).toBe(false);
  });

  it('REQ-OVERRIDES-010: accepts package keys from pnpm 6 lockfiles', () => {
    const safe = readBaselineSafeVersions(
      'packages:\n  /pdfjs-dist@4.10.38: {}\n',
      JSON.stringify({ advisories: {} }),
    );

    expect(safe.get('pdfjs-dist')).toBe('4.10.38');
  });
});
