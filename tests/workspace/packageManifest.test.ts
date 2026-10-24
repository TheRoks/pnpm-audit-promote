import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findPackageManifest,
  findWorkspacePackageManifests,
  readPackageManifest,
  setManifestProperty,
} from '../../src/workspace/packageManifest';

let tmp: string;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pnpm package manifest formats', () => {
  it('REQ-MANIFEST-001: selects package.json before JSON5 and YAML manifests', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-manifest-'));
    fs.writeFileSync(path.join(tmp, 'package.yaml'), 'name: yaml\n');
    fs.writeFileSync(path.join(tmp, 'package.json5'), "{ name: 'json5' }\n");
    expect(findPackageManifest(tmp)?.format).toBe('json5');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"json"}\n');
    expect(findPackageManifest(tmp)?.format).toBe('json');
  });

  it('REQ-MANIFEST-002: updates JSON5 dependency data while keeping JSON5 syntax and unrelated fields', () => {
    const input = "{ name: 'app', dependencies: { lodash: '^4.17.20' }, private: true, }\n";
    const output = setManifestProperty(input, 'json5', '^4.17.21', 'dependencies', 'lodash');
    const parsed = readPackageManifest(output, 'json5') as Record<string, unknown>;

    expect(parsed['name']).toBe('app');
    expect(parsed['private']).toBe(true);
    expect((parsed['dependencies'] as Record<string, string>)['lodash']).toBe('^4.17.21');
  });

  it('REQ-MANIFEST-002: updates YAML manifest dependencies without changing the manifest format', () => {
    const input = 'name: app\ndependencies:\n  lodash: ^4.17.20\nprivate: true\n';
    const output = setManifestProperty(input, 'yaml', '^4.17.21', 'dependencies', 'lodash');
    const parsed = readPackageManifest(output, 'yaml') as Record<string, unknown>;

    expect(output).toContain('dependencies:');
    expect(parsed['name']).toBe('app');
    expect(parsed['private']).toBe(true);
    expect((parsed['dependencies'] as Record<string, string>)['lodash']).toBe('^4.17.21');
  });

  it('REQ-MANIFEST-001: selects one effective manifest for each in-scope workspace package', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-manifest-'));
    const app = path.join(tmp, 'apps', 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json5'), "{ name: 'json5' }\n");
    fs.writeFileSync(path.join(app, 'package.yaml'), 'name: yaml\n');
    const ignored = path.join(tmp, 'examples', 'demo');
    fs.mkdirSync(ignored, { recursive: true });
    fs.writeFileSync(path.join(ignored, 'package.yaml'), 'name: ignored\n');

    const selected = findWorkspacePackageManifests(tmp, new Set([app]));
    expect(selected).toEqual([{ path: path.join(app, 'package.json5'), format: 'json5' }]);
  });
});
