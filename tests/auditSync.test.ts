import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceState } from '../src/workspace.js';
import { silentLogger } from '../src/logger.js';
import {
  syncAuditOverridesIntoCatalog,
  syncPackageJsonOverridesIntoCatalog,
} from '../src/auditSync.js';

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
  it('promotes catalog-eligible package.json overrides into the catalog', () => {
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
    expect(out).toContain("react: '18.3.1'");
    const newPkg = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    expect(newPkg).not.toMatch(/"react"/);
    expect(newPkg).toContain('unrelated-pkg');
  });

  it('removes empty pnpm.overrides block when fully promoted', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const pkg = JSON.stringify(
      {
        name: 'root',
        pnpm: { overrides: { react: '18.3.1' } },
      },
      null,
      2,
    );
    const state = writeWorkspace(yaml, pkg);
    syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    expect(parsed.pnpm?.overrides).toBeUndefined();
  });

  it('returns desired yaml unchanged when no overrides in package.json', () => {
    const yaml = "catalog:\n  react: '18.2.0'\n";
    const state = writeWorkspace(yaml, JSON.stringify({ name: 'root' }, null, 2));
    const out = syncPackageJsonOverridesIntoCatalog(state, yaml, silentLogger);
    expect(out).toBe(yaml);
  });
});
