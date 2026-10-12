import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readWorkspacePnpmPin } from '../../src/workspace/pnpmConfig';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('readWorkspacePnpmPin', () => {
  it('REQ-RUNNER-010: returns the authoritative major and full version from one workspace pin', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-pnpm-pin-'));
    const manifest = path.join(tmp, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ packageManager: 'pnpm@12.4.1+sha512-demo' }));
    expect(readWorkspacePnpmPin(manifest)).toEqual({ major: 12, version: '12.4.1' });
  });
});
