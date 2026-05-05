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
  type RunSummaryData,
} from '../src/summary';

describe('extractAdvisories', () => {
  it('parses a typical pnpm audit JSON payload', () => {
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

  it('returns empty list for blank or malformed input', () => {
    expect(extractAdvisories('')).toEqual([]);
    expect(extractAdvisories('not json')).toEqual([]);
    expect(extractAdvisories('null')).toEqual([]);
    expect(extractAdvisories('{}')).toEqual([]);
    expect(extractAdvisories(JSON.stringify({ advisories: null }))).toEqual([]);
  });

  it('falls back to "unknown" severity for unrecognized values', () => {
    const stdout = JSON.stringify({
      advisories: { '1': { module_name: 'x', severity: 'wat' } },
    });
    expect(extractAdvisories(stdout)[0]?.severity).toBe('unknown');
  });
});

describe('diffCatalog', () => {
  it('detects patch / minor / major bumps and ignores unchanged entries', () => {
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

  it('skips entries that are new in `after` (no original to compare)', () => {
    const before = new Map<string, string>();
    const after = new Map([['react', '18.3.1']]);
    expect(diffCatalog(before, after)).toEqual([]);
  });
});

describe('diffOverrides', () => {
  it('returns final entries that are absent or differ in the original', () => {
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

  it('reports value changes as before+after pairs', () => {
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

  it('reports selectors removed from the after-snapshot', () => {
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

  it('returns initial - final as fixed, sorted by severity', () => {
    const { fixed, remaining } = diffAdvisories([a, b], [a]);
    expect(fixed.map((x) => x.id)).toEqual(['2']);
    expect(remaining.map((x) => x.id)).toEqual(['1']);
  });

  it('returns empty fixed when nothing changed', () => {
    expect(diffAdvisories([a], [a]).fixed).toEqual([]);
  });
});

describe('readWorkspaceOverrides / readPackageJsonOverrides / readAllOverrides', () => {
  it('reads quoted and unquoted entries from yaml overrides block', () => {
    const yaml = "overrides:\n  'vite@<6.4.1': '>=6.4.2'\n  lodash: 4.17.21\n";
    const out = readWorkspaceOverrides(yaml);
    expect(out.get('vite@<6.4.1')).toBe('>=6.4.2');
    expect(out.get('lodash')).toBe('4.17.21');
  });

  it('reads pnpm.overrides from package.json text', () => {
    const text = JSON.stringify({ pnpm: { overrides: { 'lodash@<4.17.21': '>=4.17.21' } } });
    expect(readPackageJsonOverrides(text).get('lodash@<4.17.21')).toBe('>=4.17.21');
  });

  it('returns empty map for malformed package.json', () => {
    expect(readPackageJsonOverrides('not json').size).toBe(0);
  });

  it('combines workspace + package.json overrides with package.json taking precedence', () => {
    const yaml = "overrides:\n  shared: '1.0.0'\n";
    const pj = JSON.stringify({ pnpm: { overrides: { shared: '2.0.0' } } });
    const all = readAllOverrides(yaml, pj);
    expect(all.get('shared')).toEqual({ value: '2.0.0', source: 'package.json' });
  });

  it('parses unquoted selectors that contain spaces (e.g. multi-bound semver ranges)', () => {
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

  it('diffOverrides detects removals of overrides whose selector contains spaces', () => {
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
      ...overrides,
    };
  }

  it('renders headline metrics, sections, and footer (plain text)', () => {
    const out = renderTerminalSummary(fixture(), { color: false });
    expect(out).toMatch(/Dependency refresh — my-app/);
    expect(out).toMatch(/1 direct package updated/);
    expect(out).toMatch(/1 override entry changed \(1 package\)/);
    expect(out).toMatch(/1 vulnerability fixed/);
    expect(out).toMatch(/\(1 CVE resolved\)/);
    expect(out).toMatch(/0 remaining/);
    expect(out).toMatch(/Direct dependencies \(catalog\)/);
    expect(out).toMatch(/react\s+18\.2\.0\s+→\s+18\.3\.1\s+MINOR/);
    expect(out).toMatch(/Transitive overrides/);
    expect(out).toMatch(/vite@<6\.4\.1/);
    expect(out).toMatch(/>=6\.4\.2/);
    expect(out).toMatch(/Vulnerabilities fixed/);
    expect(out).toMatch(/HIGH\s+lodash\s+CVE-2020-8203\s+Prototype Pollution/);
    expect(out).toMatch(/Generated by pnpm-audit-promote@1\.2\.3 in 1m 05s/);
  });

  it('shows empty-state placeholders when nothing changed', () => {
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
    expect(out).toMatch(/No override changes\./);
    expect(out).toMatch(/No vulnerabilities were resolved during this run\./);
  });

  it('shows dry-run note when applicable', () => {
    const out = renderTerminalSummary(fixture({ dryRun: true }), { color: false });
    expect(out).toMatch(/Dry run — no files were modified\./);
  });

  it('shows audit-skipped note when applicable', () => {
    const out = renderTerminalSummary(fixture({ auditSkipped: true }), { color: false });
    expect(out).toMatch(/Audit phase skipped/);
  });

  it('renders removed override selectors with a removed-marker row', () => {
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

  it('renders a remaining-vulnerabilities section when finalAdvisories has entries', () => {
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

  it('emits ANSI escape codes when color is enabled (default)', () => {
    const out = renderTerminalSummary(fixture());
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\u001B\[/);
  });

  it('strips ANSI escape codes when color is disabled', () => {
    const out = renderTerminalSummary(fixture(), { color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001B\[/);
  });

  it('shows generic title when workspaceName is missing', () => {
    const out = renderTerminalSummary(fixture({ workspaceName: undefined }), { color: false });
    expect(out).toMatch(/Dependency refresh summary/);
  });

  it('does not include CVE parenthetical when no CVEs were resolved', () => {
    const out = renderTerminalSummary(
      fixture({
        initialAdvisories: [{ id: '7', module: 'x', severity: 'low', title: 'T', cves: [] }],
      }),
      { color: false },
    );
    expect(out).not.toMatch(/CVE resolved/);
  });
});
