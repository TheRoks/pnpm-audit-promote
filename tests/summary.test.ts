import { describe, it, expect } from 'vitest';
import {
  diffAdvisories,
  diffCatalog,
  diffOverrides,
  extractAdvisories,
  readAllOverrides,
  readPackageJsonOverrides,
  readWorkspaceOverrides,
  renderTerminalSummary,
  type AdvisorySummary,
  type PackageJsonDepChange,
  type RunSummaryData,
} from '../src/summary';

describe('extractAdvisories', () => {
  it('REQ-AUDIT-008: parses a typical pnpm audit JSON payload', () => {
    const stdout = JSON.stringify({
      advisories: {
        '101': {
          module_name: 'lodash',
          severity: 'high',
          title: 'Prototype Pollution',
          url: 'https://example.com/101',
          cves: ['CVE-2020-8203'],
        },
        '102': {
          module_name: 'minimist',
          severity: 'critical',
          title: 'Prototype Pollution',
          cves: [],
        },
      },
    });
    const out = extractAdvisories(stdout);
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.id === '101')?.cves).toEqual(['CVE-2020-8203']);
    expect(out.find((a) => a.id === '102')?.severity).toBe('critical');
  });

  it('REQ-AUDIT-008: returns empty list for blank or malformed input', () => {
    expect(extractAdvisories('')).toEqual([]);
    expect(extractAdvisories('not json')).toEqual([]);
    expect(extractAdvisories('null')).toEqual([]);
    expect(extractAdvisories('{}')).toEqual([]);
    expect(extractAdvisories(JSON.stringify({ advisories: null }))).toEqual([]);
  });

  it('REQ-AUDIT-008: falls back to "unknown" severity for unrecognized values', () => {
    const stdout = JSON.stringify({
      advisories: { '1': { module_name: 'x', severity: 'wat' } },
    });
    expect(extractAdvisories(stdout)[0]?.severity).toBe('unknown');
  });
});

describe('diffCatalog', () => {
  it('REQ-CORE-004: detects patch / minor / major bumps and ignores unchanged entries', () => {
    const before = new Map([
      ['react', '18.2.0'],
      ['lodash', '4.17.20'],
      ['vite', '6.3.5'],
      ['unchanged', '1.0.0'],
    ]);
    const after = new Map([
      ['react', '18.2.1'], // patch
      ['lodash', '4.18.0'], // minor
      ['vite', '7.0.0'], // major
      ['unchanged', '1.0.0'],
    ]);
    const diff = diffCatalog(before, after);
    expect(diff.find((c) => c.name === 'react')?.bump).toBe('patch');
    expect(diff.find((c) => c.name === 'lodash')?.bump).toBe('minor');
    expect(diff.find((c) => c.name === 'vite')?.bump).toBe('major');
    expect(diff.find((c) => c.name === 'unchanged')).toBeUndefined();
  });

  it('REQ-CORE-004: skips entries that are new in `after` (no original to compare)', () => {
    const before = new Map<string, string>();
    const after = new Map([['react', '18.3.1']]);
    expect(diffCatalog(before, after)).toEqual([]);
  });
});

describe('diffOverrides', () => {
  it('REQ-CORE-004: returns final entries that are absent or differ in the original', () => {
    const before = new Map([['vite@<6.0.0', { value: '>=6.0.0', source: 'workspace' as const }]]);
    const after = new Map([
      ['vite@<6.0.0', { value: '>=6.0.0', source: 'workspace' as const }], // unchanged
      ['lodash@<4.17.21', { value: '>=4.17.21', source: 'workspace' as const }], // added
      ['react@<18.3.1', { value: '>=18.3.1', source: 'package.json' as const }], // added
    ]);
    const diff = diffOverrides(before, after);
    expect(diff).toHaveLength(2);
    expect(diff.find((d) => d.selector === 'lodash@<4.17.21')?.before).toBeUndefined();
  });

  it('REQ-CORE-004: reports value changes as before+after pairs', () => {
    const before = new Map([['x', { value: '>=1.0.0', source: 'workspace' as const }]]);
    const after = new Map([['x', { value: '>=2.0.0', source: 'workspace' as const }]]);
    expect(diffOverrides(before, after)).toEqual([
      {
        selector: 'x',
        before: '>=1.0.0',
        after: '>=2.0.0',
        source: 'workspace',
        kind: 'modified',
      },
    ]);
  });

  it('REQ-CORE-004: reports selectors removed from the after-snapshot', () => {
    const before = new Map([
      ['tar@6.2.1', { value: '7.5.11', source: 'package.json' as const }],
      ['vite@<6.0.0', { value: '>=6.0.0', source: 'workspace' as const }],
    ]);
    const after = new Map([
      ['tar@<=7.5.10', { value: '>=7.5.11', source: 'package.json' as const }],
      ['vite@<6.0.0', { value: '>=6.0.0', source: 'workspace' as const }],
    ]);
    const diff = diffOverrides(before, after);
    expect(diff).toHaveLength(2);
    expect(diff.find((d) => d.selector === 'tar@6.2.1')).toEqual({
      selector: 'tar@6.2.1',
      before: '7.5.11',
      source: 'package.json',
      kind: 'removed',
    });
    expect(diff.find((d) => d.selector === 'tar@<=7.5.10')).toEqual({
      selector: 'tar@<=7.5.10',
      after: '>=7.5.11',
      source: 'package.json',
      kind: 'added',
    });
  });
});

describe('diffAdvisories', () => {
  const a: AdvisorySummary = {
    id: '1',
    module: 'lodash',
    severity: 'high',
    title: 'X',
    cves: [],
  };
  const b: AdvisorySummary = {
    id: '2',
    module: 'minimist',
    severity: 'critical',
    title: 'Y',
    cves: [],
  };

  it('REQ-CORE-004: returns initial - final as fixed, sorted by severity', () => {
    const { fixed, remaining } = diffAdvisories([a, b], [a]);
    expect(fixed.map((x) => x.id)).toEqual(['2']);
    expect(remaining.map((x) => x.id)).toEqual(['1']);
  });

  it('REQ-CORE-004: returns empty fixed when nothing changed', () => {
    expect(diffAdvisories([a], [a]).fixed).toEqual([]);
  });
});

describe('readWorkspaceOverrides / readPackageJsonOverrides / readAllOverrides', () => {
  it('REQ-OVERRIDES-001: reads quoted and unquoted entries from yaml overrides block', () => {
    const yaml = "overrides:\n  'vite@<6.4.1': '>=6.4.2'\n  lodash: 4.17.21\n";
    const out = readWorkspaceOverrides(yaml);
    expect(out.get('vite@<6.4.1')).toBe('>=6.4.2');
    expect(out.get('lodash')).toBe('4.17.21');
  });

  it('REQ-OVERRIDES-003: reads pnpm.overrides from package.json text', () => {
    const text = JSON.stringify({ pnpm: { overrides: { 'lodash@<4.17.21': '>=4.17.21' } } });
    expect(readPackageJsonOverrides(text).get('lodash@<4.17.21')).toBe('>=4.17.21');
  });

  it('REQ-AUDIT-008: returns empty map for malformed package.json', () => {
    expect(readPackageJsonOverrides('not json').size).toBe(0);
  });

  it('REQ-OVERRIDES-003: combines workspace + package.json overrides with package.json taking precedence', () => {
    const yaml = "overrides:\n  shared: '1.0.0'\n";
    const pj = JSON.stringify({ pnpm: { overrides: { shared: '2.0.0' } } });
    const all = readAllOverrides(yaml, pj);
    expect(all.get('shared')).toEqual({ value: '2.0.0', source: 'package.json' });
  });

  it('REQ-OVERRIDES-001: parses unquoted selectors that contain spaces (e.g. multi-bound semver ranges)', () => {
    const yaml = [
      'overrides:',
      "  axios@>=1.0.0 <1.15.0: '>=1.15.0'",
      "  minimatch@>=9.0.0 <9.0.6: '>=9.0.6'",
      "  brace-expansion@>=4.0.0 <5.0.5: '>=5.0.5'",
    ].join('\n');
    const out = readWorkspaceOverrides(yaml);
    expect(out.get('axios@>=1.0.0 <1.15.0')).toBe('>=1.15.0');
    expect(out.get('minimatch@>=9.0.0 <9.0.6')).toBe('>=9.0.6');
    expect(out.get('brace-expansion@>=4.0.0 <5.0.5')).toBe('>=5.0.5');
    expect(out.size).toBe(3);
  });

  it('REQ-CORE-004: diffOverrides detects removals of overrides whose selector contains spaces', () => {
    // Simulates the real-world case: original yaml had space-containing selectors;
    // after the run some were removed. The summary must report them as "removed".
    const originalYaml = [
      'overrides:',
      "  axios@>=1.0.0 <1.15.0: '>=1.15.0'",
      "  minimatch@>=9.0.0 <9.0.6: '>=9.0.6'",
      "  brace-expansion@>=4.0.0 <5.0.5: '>=5.0.5'",
    ].join('\n');
    const finalYaml = ['overrides:', "  brace-expansion@>=4.0.0 <5.0.5: '>=5.0.5'"].join('\n');

    const originalOverrides = readAllOverrides(originalYaml, null);
    const finalOverrides = readAllOverrides(finalYaml, null);
    const diff = diffOverrides(originalOverrides, finalOverrides);

    const removed = diff.filter((d) => d.kind === 'removed');
    expect(removed).toHaveLength(2);
    expect(removed.find((d) => d.selector === 'axios@>=1.0.0 <1.15.0')).toBeDefined();
    expect(removed.find((d) => d.selector === 'minimatch@>=9.0.0 <9.0.6')).toBeDefined();
  });
});

describe('renderTerminalSummary', () => {
  function fixture(overrides: Partial<RunSummaryData> = {}): RunSummaryData {
    return {
      workspaceRoot: '/repo',
      workspaceName: 'my-app',
      toolVersion: '1.2.3',
      durationMs: 65_000,
      dryRun: false,
      auditSkipped: false,
      originalCatalog: new Map([['react', '18.2.0']]),
      finalCatalog: new Map([['react', '18.3.1']]),
      originalOverrides: new Map(),
      finalOverrides: new Map([
        ['vite@<6.4.1', { value: '>=6.4.2', source: 'workspace' as const }],
      ]),
      initialAdvisories: [
        {
          id: '101',
          module: 'lodash',
          severity: 'high',
          title: 'Prototype Pollution',
          url: 'https://example.com/101',
          cves: ['CVE-2020-8203'],
        },
      ],
      finalAdvisories: [],
      pkgJsonDepChanges: [],
      ...overrides,
    };
  }

  it('REQ-SUMMARY-001: renders headline metrics, sections, and footer (plain text)', () => {
    const out = renderTerminalSummary(fixture(), { color: false });
    expect(out).toMatch(/Dependency refresh — my-app/);
    expect(out).toMatch(/1 direct package updated/);
    expect(out).toMatch(/1 override entry changed \(1 package\)/);
    expect(out).toMatch(/1 vulnerability fixed/);
    expect(out).toMatch(/\(1 CVE resolved\)/);
    expect(out).toMatch(/0 remaining/);
    expect(out).toMatch(/Direct dependencies \(catalog\)/);
    expect(out).toMatch(/react\s+18\.2\.0\s+→\s+18\.3\.1\s+MINOR/);
    expect(out).toMatch(/Direct dependencies \(package\.json files\)/);
    expect(out).toMatch(/No package\.json versions changed\./);
    expect(out).toMatch(/Transitive overrides/);
    expect(out).toMatch(/vite@<6\.4\.1/);
    expect(out).toMatch(/>=6\.4\.2/);
    expect(out).toMatch(/Vulnerabilities fixed/);
    expect(out).toMatch(/HIGH\s+lodash\s+CVE-2020-8203\s+Prototype Pollution/);
    expect(out).toMatch(/Generated by pnpm-audit-promote@1\.2\.3 in 1m 05s/);
  });

  it('REQ-SUMMARY-001: shows empty-state placeholders when nothing changed', () => {
    const out = renderTerminalSummary(
      fixture({
        originalCatalog: new Map(),
        finalCatalog: new Map(),
        finalOverrides: new Map(),
        initialAdvisories: [],
      }),
      { color: false },
    );
    expect(out).toMatch(/No catalog versions changed\./);
    expect(out).toMatch(/No package\.json versions changed\./);
    expect(out).toMatch(/No override changes\./);
    expect(out).toMatch(/No vulnerabilities were resolved during this run\./);
  });

  it('REQ-SUMMARY-001: renders package.json dep changes in the new section and updates headline count', () => {
    const change: PackageJsonDepChange = {
      pkgJsonPath: '/repo/packages/app/package.json',
      name: 'lodash',
      before: '^4.17.20',
      after: '^4.17.21',
      bump: 'patch',
    };
    const out = renderTerminalSummary(
      fixture({
        originalCatalog: new Map(),
        finalCatalog: new Map(),
        pkgJsonDepChanges: [change],
      }),
      { color: false },
    );
    // Headline: catalog (0) + pkg.json (1) = 1
    expect(out).toMatch(/1 direct package updated/);
    expect(out).toMatch(/No catalog versions changed\./);
    expect(out).toMatch(/Direct dependencies \(package\.json files\)/);
    expect(out).toMatch(/lodash\s+\^4\.17\.20\s+→\s+\^4\.17\.21\s+PATCH/);
  });

  it('REQ-SUMMARY-001: shows dry-run note when applicable', () => {
    const out = renderTerminalSummary(fixture({ dryRun: true }), { color: false });
    expect(out).toMatch(/Dry run — no files were modified\./);
  });

  it('REQ-CORE-005: shows audit-skipped note when applicable', () => {
    const out = renderTerminalSummary(fixture({ auditSkipped: true }), { color: false });
    expect(out).toMatch(/Audit phase skipped/);
  });

  it('REQ-SUMMARY-001: renders removed override selectors with a removed-marker row', () => {
    const out = renderTerminalSummary(
      fixture({
        originalOverrides: new Map([
          ['tar@6.2.1', { value: '7.5.11', source: 'package.json' as const }],
        ]),
        finalOverrides: new Map([
          ['tar@<=7.5.10', { value: '>=7.5.11', source: 'package.json' as const }],
        ]),
      }),
      { color: false },
    );
    expect(out).toMatch(/2 override entries changed \(1 package\)/);
    expect(out).toMatch(/tar@<=7\.5\.10\s+→\s+>=7\.5\.11/);
    expect(out).toMatch(/tar@6\.2\.1\s+✗\s+removed.*was 7\.5\.11/);
  });

  it('REQ-SUMMARY-001: renders a remaining-vulnerabilities section when finalAdvisories has entries', () => {
    const out = renderTerminalSummary(
      fixture({
        finalAdvisories: [{ id: '999', module: 'foo', severity: 'low', title: 'Z', cves: [] }],
      }),
      { color: false },
    );
    expect(out).toMatch(/Vulnerabilities remaining/);
    expect(out).toMatch(/LOW\s+foo\s+—\s+Z/);
    expect(out).toMatch(/1 vulnerability remaining/);
  });

  it('REQ-SUMMARY-001: emits ANSI escape codes when color is enabled (default)', () => {
    const out = renderTerminalSummary(fixture());
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\u001B\[/);
  });

  it('REQ-SUMMARY-003, REQ-LOGGING-005: strips ANSI escape codes when color is disabled', () => {
    const out = renderTerminalSummary(fixture(), { color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001B\[/);
  });

  it('REQ-SUMMARY-001: shows generic title when workspaceName is missing', () => {
    const out = renderTerminalSummary(fixture({ workspaceName: undefined }), { color: false });
    expect(out).toMatch(/Dependency refresh summary/);
  });

  it('REQ-SUMMARY-001: does not include CVE parenthetical when no CVEs were resolved', () => {
    const out = renderTerminalSummary(
      fixture({
        initialAdvisories: [{ id: '7', module: 'x', severity: 'low', title: 'T', cves: [] }],
      }),
      { color: false },
    );
    expect(out).not.toMatch(/CVE resolved/);
  });

  it('REQ-SUMMARY-001: sanitizes ANSI and control characters in advisory fields', () => {
    const out = renderTerminalSummary(
      fixture({
        initialAdvisories: [
          {
            id: '201',
            module: 'lod\u001b[31mash\u001b[0m',
            severity: 'high',
            title: 'Prototype\r\nPollution\tDetected',
            cves: ['CVE-2020-8203\u0007'],
          },
        ],
      }),
      { color: false },
    );

    expect(out).toMatch(/HIGH\s+lodash\s+CVE-2020-8203\s+Prototype Pollution Detected/);
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\u001b[');
  });

  it('REQ-SUMMARY-001: strips OSC hyperlink control sequences from advisory titles', () => {
    const out = renderTerminalSummary(
      fixture({
        initialAdvisories: [
          {
            id: '202',
            module: 'pkg',
            severity: 'low',
            title: '\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007',
            cves: [],
          },
        ],
      }),
      { color: false },
    );

    expect(out).toContain('click');
    expect(out).not.toContain('evil.test');
  });

  it('REQ-SUMMARY-001: keeps advisory rows single-line after sanitization', () => {
    const out = renderTerminalSummary(
      fixture({
        initialAdvisories: [
          {
            id: '203',
            module: 'newline-mod',
            severity: 'moderate',
            title: 'Line1\nLine2\r\nLine3',
            cves: ['CVE-1'],
          },
        ],
      }),
      { color: false },
    );

    expect(out).toMatch(/MODERATE\s+newline-mod\s+CVE-1\s+Line1 Line2 Line3/);
  });

  it('REQ-SUMMARY-008: displays workspace name as run heading when package.json has a name field', () => {
    const out = renderTerminalSummary(fixture({ workspaceName: 'my-monorepo' }), { color: false });
    expect(out).toMatch(/my-monorepo/);
  });

  it('REQ-SUMMARY-008: displays generic heading when workspaceName is absent', () => {
    const out = renderTerminalSummary(fixture({ workspaceName: undefined }), { color: false });
    expect(out).toMatch(/Dependency refresh summary|Dependency refresh/);
    expect(out).not.toMatch(/undefined/);
  });
});
