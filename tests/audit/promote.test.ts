import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceState } from '../../src/workspace.js';
import { silentLogger } from '../../src/logger.js';
import { syncAuditOverridesIntoCatalog } from '../../src/audit/promoteWorkspaceOverrides.js';
import { syncPackageJsonOverridesIntoCatalog } from '../../src/audit/promotePackageJsonOverrides.js';

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
  it('promotes catalog-eligible overrides into the catalog', () => {
    const yaml =
      "packages:\n  - 'apps/*'\n\ncatalog:\n  react: '18.2.0'\n  lodash: '4.17.20'\n\noverrides:\n  react: '18.3.1'\n  lodash: '4.17.21'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("react: '18.3.1'");
    expect(out).toContain("lodash: '4.17.21'");
    expect(out).not.toContain('overrides:');
  });

  it('keeps transitive-only overrides (qualified key or non-catalog name)', () => {
    const yaml =
      "catalog:\n  react: '18.2.0'\n\noverrides:\n  react: '18.3.1'\n  'vite@>=7.0.0 <=7.3.1': '7.3.2'\n  unrelated: '1.0.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("react: '18.3.1'"); // promoted
    expect(out).toContain("'vite@>=7.0.0 <=7.3.1'"); // kept
    expect(out).toContain('unrelated'); // kept (not in catalog)
  });

  it('returns current content when no catalog block', () => {
    const yaml = "overrides:\n  foo: '1.0.0'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toBe(yaml);
  });
});

describe('syncPackageJsonOverridesIntoCatalog', () => {
  it('does not promote plain package.json overrides for catalog packages', () => {
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

  it('promotes qualified package.json overrides that match current catalog range', () => {
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

  it('collapses redundant qualified package.json overrides with the same fix', () => {
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

  it('collapses subset selectors and keeps the stricter fix floor', () => {
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

  it('returns desired yaml unchanged when no overrides in package.json', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const state = writeWorkspace(yaml, JSON.stringify({ name: 'root' }, null, 2));
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toBe(yaml);
  });
});

describe('syncAuditOverridesIntoCatalog qualified overrides', () => {
  it('promotes catalog entry when a qualified override selector matches the catalog version', () => {
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

  it('does not downgrade when a plain override already sets a higher version', () => {
    // Plain `vite: 6.4.3` should win over the qualified minimum of 6.4.2.
    const yaml =
      "catalog:\n  vite: '6.3.5'\n\noverrides:\n  vite: '6.4.3'\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain("vite: '6.4.3'");
    expect(out).not.toContain('overrides:');
  });

  it('keeps a qualified override when the catalog version does not satisfy its selector', () => {
    // Catalog already at 6.4.2, override selector <=6.4.1 does NOT match → keep.
    const yaml = "catalog:\n  vite: '6.4.2'\n\noverrides:\n  vite@<=6.4.1: '>=6.4.2'\n";
    const state = writeWorkspace(yaml);
    const out = syncAuditOverridesIntoCatalog(state, silentLogger);
    expect(out).toContain('vite@<=6.4.1');
    expect(out).toContain("vite: '6.4.2'"); // catalog unchanged
  });
});

describe('cross-major warning', () => {
  it('warns when promoting an override that crosses a major boundary', () => {
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

  it('does not warn when promoted version stays within the same major', () => {
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
});
