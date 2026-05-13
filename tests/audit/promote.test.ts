import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceState } from '../../src/workspace';
import { silentLogger } from '../../src/logger';
import { syncAuditOverridesIntoCatalog } from '../../src/audit/promoteWorkspaceOverrides';
import { syncPackageJsonOverridesIntoCatalog } from '../../src/audit/promotePackageJsonOverrides';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeWorkspace(yaml: string, pkgJson?: string): WorkspaceState {
  fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), yaml, 'utf8');
  if (pkgJson) fs.writeFileSync(path.join(tmp, 'package.json'), pkgJson, 'utf8');
  return WorkspaceState.initialize(tmp);
}

describe('syncAuditOverridesIntoCatalog', () => {
  it('REQ-OVERRIDES-001: promotes catalog-eligible overrides into the catalog', () => {
    const yaml =
      "packages:\n  - 'apps/*'\n\ncatalog:\n  react: '18.2.0'\n  lodash: '4.17.20'\n\noverrides:\n  react: '18.3.1'\n  lodash: '4.17.21'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("react: '18.3.1'");
    expect(out).toContain("lodash: '4.17.21'");
    expect(out).not.toContain('overrides:');
  });

  it('REQ-OVERRIDES-002: keeps transitive-only overrides (qualified key or non-catalog name)', () => {
    const yaml =
      "catalog:\n  react: '18.2.0'\n\noverrides:\n  react: '18.3.1'\n  'vite@>=7.0.0 <=7.3.1': '7.3.2'\n  unrelated: '1.0.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("react: '18.3.1'"); // promoted
    expect(out).toContain("'vite@>=7.0.0 <=7.3.1'"); // kept
    expect(out).toContain('unrelated'); // kept (not in catalog)
  });

  it('REQ-OVERRIDES-001: returns current content when no catalog block', () => {
    const yaml = "overrides:\n  foo: '1.0.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toBe(yaml);
  });

  it('REQ-WORKSPACE-008: returns empty and writes nothing when pnpm-workspace.yaml is absent', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'pnpm@10.0.0' }),
      'utf8',
    );
    const state = WorkspaceState.initialize(tmp);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toBe('');
    expect(fs.existsSync(path.join(tmp, 'pnpm-workspace.yaml'))).toBe(false);
  });
});

describe('syncPackageJsonOverridesIntoCatalog', () => {
  it('REQ-OVERRIDES-002, REQ-OVERRIDES-004: does not promote plain package.json overrides for catalog packages', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        private: true,
        pnpm: {
          overrides: {
            react: '18.3.1',
            'unrelated-pkg': '1.0.0',
          },
        },
      },
      null,
      2,
    );
    const state = writeWorkspace(yaml, pkg);
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toContain("react: '18.2.0'");
    const newPkg = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    expect(newPkg).toMatch(/"react"/);
    expect(newPkg).toContain('unrelated-pkg');
  });

  it('REQ-OVERRIDES-003: promotes qualified package.json overrides that match current catalog range', () => {
    const yaml = "catalog:\n  vite: '6.3.5'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: { overrides: { 'vite@<=6.4.1': '>=6.4.2' } },
      },
      null,
      2,
    );
    const state = writeWorkspace(yaml, pkg);
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toContain("vite: '6.4.2'");

    const newPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(newPkg.pnpm?.overrides).toBeUndefined();
  });

  it('REQ-OVERRIDES-005, REQ-PNPM11-007: collapses redundant qualified package.json overrides with the same fix', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: {
          overrides: {
            'vite@>=7.0.0 <=7.3.1': '>=7.3.2',
            'vite@>=7.1.0 <=7.3.1': '>=7.3.2',
            'rollup@>=4.0.0 <=4.58.0': '>=4.59.0',
          },
        },
      },
      null,
      2,
    );

    const state = writeWorkspace(yaml, pkg);
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toBe(yaml); // no catalog promotions here

    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = parsed.pnpm?.overrides ?? {};
    expect(overrides['vite@>=7.0.0 <=7.3.1']).toBe('>=7.3.2');
    expect(overrides['vite@>=7.1.0 <=7.3.1']).toBeUndefined();
    expect(overrides['rollup@>=4.0.0 <=4.58.0']).toBe('>=4.59.0');
  });

  it('REQ-OVERRIDES-005: collapses subset selectors and keeps the stricter fix floor', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: {
          overrides: {
            'webpack@>=5.49.0 <=5.104.0': '>=5.104.1',
            'webpack@>=5.49.0 <5.104.0': '>=5.104.0',
          },
        },
      },
      null,
      2,
    );

    const state = writeWorkspace(yaml, pkg);
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toBe(yaml); // no catalog promotions here

    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = parsed.pnpm?.overrides ?? {};
    expect(overrides['webpack@>=5.49.0 <=5.104.0']).toBe('>=5.104.1');
    expect(overrides['webpack@>=5.49.0 <5.104.0']).toBeUndefined();
  });

  it('REQ-OVERRIDES-005, REQ-PNPM11-007: collapses open-ended (no lower bound) qualified package.json overrides', () => {
    // Mirrors the user's real-world `--ignore-workspace` run where pnpm 11
    // wrote 9 unrelated `tar` / `serialize-javascript` / `postcss`
    // selectors into pnpm.overrides. All tar entries are strict subsets
    // of `tar@<=7.5.10`, so collapse should leave one entry per package.
    const yaml = 'catalog: {}\n';
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: {
          overrides: {
            'tar@<7.5.7': '>=7.5.7',
            'tar@<=7.5.2': '>=7.5.3',
            'tar@<7.5.8': '>=7.5.8',
            'serialize-javascript@<=7.0.2': '>=7.0.3',
            'tar@<=7.5.9': '>=7.5.10',
            'tar@<=7.5.10': '>=7.5.11',
            'tar@<=7.5.3': '>=7.5.4',
            'serialize-javascript@<7.0.5': '>=7.0.5',
            'postcss@<8.5.10': '>=8.5.10',
          },
        },
      },
      null,
      2,
    );

    const state = writeWorkspace(yaml, pkg);
    syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);

    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = parsed.pnpm?.overrides ?? {};
    const keys = Object.keys(overrides);

    const tarKeys = keys.filter((k) => k.startsWith('tar@'));
    expect(tarKeys).toEqual(['tar@<=7.5.10']);
    expect(overrides['tar@<=7.5.10']).toBe('>=7.5.11');

    const sjKeys = keys.filter((k) => k.startsWith('serialize-javascript@'));
    expect(sjKeys).toEqual(['serialize-javascript@<7.0.5']);
    expect(overrides['serialize-javascript@<7.0.5']).toBe('>=7.0.5');

    expect(overrides['postcss@<8.5.10']).toBe('>=8.5.10');
  });

  it('REQ-OVERRIDES-003: returns desired yaml unchanged when no overrides in package.json', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const state = writeWorkspace(yaml, JSON.stringify({ name: 'root' }, null, 2));
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toBe(yaml);
  });
});

describe('syncAuditOverridesIntoCatalog qualified overrides', () => {
  it('REQ-OVERRIDES-001: promotes catalog entry when a qualified override selector matches the catalog version', () => {
    // pnpm audit --fix writes `vite@<=6.4.1: '>=6.4.2'`; catalog is at 6.3.5.
    // The fix: promote catalog to the concrete minimum (6.4.2) and discard the override.
    const yaml =
      "packages:\n  - 'apps/*'\n\ncatalog:\n  vite: '6.3.5'\n\noverrides:\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.4.2'");
    expect(out).not.toContain('vite@<=6.4.1');
    expect(out).not.toContain('overrides:');
  });

  it('REQ-OVERRIDES-006: does not downgrade when a plain override already sets a higher version', () => {
    // Plain `vite: 6.4.3` should win over the qualified minimum of 6.4.2.
    const yaml =
      "catalog:\n  vite: '6.3.5'\n\noverrides:\n  vite: '6.4.3'\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.4.3'");
    expect(out).not.toContain('overrides:');
  });

  it('REQ-OVERRIDES-006: plain override below current catalog version is discarded (no downgrade)', () => {
    // Override proposes 6.2.0 but catalog already pins 6.3.5 — must not regress.
    const yaml = "catalog:\n  vite: '6.3.5'\n\noverrides:\n  vite: '6.2.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.3.5'"); // catalog version unchanged
    expect(out).not.toContain("vite: '6.2.0'");
  });

  it('REQ-OVERRIDES-006: plain override equal to current catalog version is discarded (redundant)', () => {
    // Override matches the catalog exactly — no-op, no overrides block.
    const yaml = "catalog:\n  vite: '6.3.5'\n\noverrides:\n  vite: '6.3.5'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.3.5'"); // catalog unchanged
    // The redundant override should be removed (not promoted, not kept)
    expect(out.indexOf("vite: '6.3.5'")).toBe(out.lastIndexOf("vite: '6.3.5'")); // only one occurrence
  });

  it('REQ-OVERRIDES-002: keeps a qualified override when the catalog version does not satisfy its selector', () => {
    // Catalog already at 6.4.2, override selector <=6.4.1 does NOT match → keep.
    const yaml = "catalog:\n  vite: '6.4.2'\n\noverrides:\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain('vite@<=6.4.1');
    expect(out).toContain("vite: '6.4.2'"); // catalog unchanged
  });

  it('REQ-OVERRIDES-005: collapses subset workspace overrides into the broader selector with the strongest fix', () => {
    // axios is not in the catalog, so both qualified overrides survive promotion.
    // The narrower selector should be subsumed by the broader one and the fix
    // floor lifted to the stronger of the two.
    const yaml =
      "catalog:\n  react: '18.2.0'\n\noverrides:\n  'axios@>=1.0.0 <1.15.1': '>=1.15.1'\n  'axios@>=1.0.0 <1.15.2': '>=1.15.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain('axios@>=1.0.0 <1.15.2');
    expect(out).toContain("'>=1.15.2'");
    expect(out).not.toContain('<1.15.1');
  });

  it('REQ-OVERRIDES-005: collapses equivalent workspace override selectors keeping the first occurrence', () => {
    // Whitespace-only variants describe the same range; keep the first.
    const yaml =
      "catalog: {}\n\noverrides:\n  'foo@>=1.0.0 <2.0.0': '>=1.5.0'\n  'foo@>=1.0.0  <2.0.0': '>=1.7.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("'foo@>=1.0.0 <2.0.0': '>=1.7.0'");
    expect(out).not.toContain('foo@>=1.0.0  <2.0.0');
  });

  it('REQ-OVERRIDES-005: does not merge workspace overrides for different bare packages', () => {
    const yaml =
      "catalog: {}\n\noverrides:\n  'axios@>=1.0.0 <1.15.1': '>=1.15.1'\n  'lodash@>=4.0.0 <4.18.0': '>=4.18.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain('axios@>=1.0.0 <1.15.1');
    expect(out).toContain('lodash@>=4.0.0 <4.18.0');
  });

  it('REQ-OVERRIDES-005, REQ-OVERRIDES-001: collapses qualified workspace overrides while still promoting unrelated catalog entries', () => {
    const yaml =
      "catalog:\n  react: '18.2.0'\n\noverrides:\n  react: '18.3.1'\n  'axios@>=1.0.0 <1.15.1': '>=1.15.1'\n  'axios@>=1.0.0 <1.15.2': '>=1.15.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("react: '18.3.1'"); // promoted
    expect(out).toContain('axios@>=1.0.0 <1.15.2');
    expect(out).toContain("'>=1.15.2'");
    expect(out).not.toContain('<1.15.1');
  });

  it('REQ-OVERRIDES-005, REQ-PNPM11-007: collapses open-ended (no lower bound) qualified workspace overrides', () => {
    // Reproduces the real-world case where `pnpm audit --fix` writes many
    // open-ended `<X.Y.Z` / `<=X.Y.Z` selectors for the same package. All
    // tar selectors below are strict subsets of `tar@<=7.5.10`, so the
    // collapse pass should leave a single broadest entry per package with
    // the strongest fix floor.
    const yaml = [
      'catalog: {}',
      '',
      'overrides:',
      "  'tar@<7.5.7': '>=7.5.7'",
      "  'tar@<=7.5.2': '>=7.5.3'",
      "  'tar@<7.5.8': '>=7.5.8'",
      "  'serialize-javascript@<=7.0.2': '>=7.0.3'",
      "  'tar@<=7.5.9': '>=7.5.10'",
      "  'tar@<=7.5.10': '>=7.5.11'",
      "  'tar@<=7.5.3': '>=7.5.4'",
      "  'serialize-javascript@<7.0.5': '>=7.0.5'",
      "  'postcss@<8.5.10': '>=8.5.10'",
      '',
    ].join('\n');
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);

    // Exactly one tar entry: the broadest selector with the strongest fix.
    const tarMatches = out.match(/tar@[^'"\s]+/g) ?? [];
    expect(tarMatches).toEqual(['tar@<=7.5.10']);
    expect(out).toContain("'>=7.5.11'");

    // Exactly one serialize-javascript entry collapsed to broadest selector.
    const sjMatches = out.match(/serialize-javascript@[^'"\s]+/g) ?? [];
    expect(sjMatches).toEqual(['serialize-javascript@<7.0.5']);
    expect(out).toContain("'>=7.0.5'");

    // postcss is alone and should remain untouched.
    expect(out).toContain('postcss@<8.5.10');
    expect(out).toContain("'>=8.5.10'");
  });

  it('REQ-OVERRIDES-005: collapses qualified workspace overrides even when no catalog block exists', () => {
    // Regression: previously the function bailed out early when the
    // workspace yaml had no `catalog:` block, so collapse never ran.
    // Mirrors the real-world `--ignore-workspace` single-package case
    // where pnpm 11 writes many open-ended selectors for the same dep.
    const yaml = [
      'overrides:',
      "  tar@<7.5.7: '>=7.5.7'",
      "  tar@<=7.5.2: '>=7.5.3'",
      "  tar@<=7.5.10: '>=7.5.11'",
      '',
    ].join('\n');
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    const tarMatches = out.match(/tar@[^'":\s]+/g) ?? [];
    expect(tarMatches).toEqual(['tar@<=7.5.10']);
    expect(out).toContain("'>=7.5.11'");
  });
});

describe('cross-major warning', () => {
  it('REQ-AUDIT-003: warns when promoting an override that crosses a major boundary', () => {
    const yaml = "catalog:\n  react: '17.0.2'\n\noverrides:\n  react: '18.3.1'\n";
    const state = writeWorkspace(yaml);
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn(msg: string) {
        warnings.push(msg);
      },
    };
    const out = syncAuditOverridesIntoCatalog(state, logger);
    expect(out).toContain("react: '18.3.1'");
    expect(warnings.some((w) => /Major bump promoted for react/.test(w))).toBe(true);
  });

  it('REQ-AUDIT-003: does not warn when promoted version stays within the same major', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n\noverrides:\n  react: '18.3.1'\n";
    const state = writeWorkspace(yaml);
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn(msg: string) {
        warnings.push(msg);
      },
    };
    syncAuditOverridesIntoCatalog(state, logger);
    expect(warnings).toEqual([]);
  });

  it('REQ-OVERRIDES-007: qualified override is discarded after promotion when catalog version no longer satisfies its selector', () => {
    // vite@<=6.4.1 is promoted: catalog bumps from 6.3.5 → 6.4.2.
    // The final catalog 6.4.2 does NOT satisfy <=6.4.1, so the override is discarded.
    const yaml = "catalog:\n  vite: '6.3.5'\n\noverrides:\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.4.2'");
    expect(out).not.toContain('vite@<=6.4.1');
    expect(out).not.toContain('overrides:');
  });

  it('REQ-OVERRIDES-008: after all pnpm.overrides are removed, the empty overrides and pnpm keys are also removed', () => {
    const yaml = "catalog:\n  vite: '6.3.5'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: { overrides: { 'vite@<=6.4.1': '>=6.4.2' } },
      },
      null,
      2,
    );
    const state = writeWorkspace(yaml, pkg);
    syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    const newPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')) as {
      pnpm?: unknown;
    };
    // Both `overrides` and the parent `pnpm` key must be gone.
    expect(newPkg.pnpm).toBeUndefined();
  });
});
