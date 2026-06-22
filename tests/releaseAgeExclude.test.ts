import { describe, it, expect } from 'vitest';
import { restoreMinimumReleaseAgeExclude } from '../src/releaseAgeExclude';

describe('restoreMinimumReleaseAgeExclude', () => {
  it('REQ-PNPM11-011: removes a block pnpm added when the user had none (sequence form)', () => {
    const original = "catalog:\n  lodash: '4.17.20'\n";
    const current =
      "minimumReleaseAgeExclude:\n  - 'axios@1.7.4'\n  - 'lodash@4.17.21'\ncatalog:\n  lodash: '4.17.20'\n";
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(original);
  });

  it('REQ-PNPM11-011: removes a block pnpm added when the user had none (map form)', () => {
    const original = "catalog:\n  lodash: '4.17.20'\n";
    const current =
      "minimumReleaseAgeExclude:\n  axios: 1.7.4\n  lodash: 4.17.21\ncatalog:\n  lodash: '4.17.20'\n";
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(original);
  });

  it("REQ-PNPM11-011: restores the user's original entries, discarding pnpm's additions", () => {
    const original =
      "minimumReleaseAge: 720\nminimumReleaseAgeExclude:\n  - '@achmea/*'\ncatalog:\n  lodash: '4.17.20'\n";
    const current =
      "minimumReleaseAge: 720\nminimumReleaseAgeExclude:\n  - '@achmea/*'\n  - 'axios@1.7.4'\n  - 'lodash@4.17.21'\ncatalog:\n  lodash: '4.17.20'\n";
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(original);
  });

  it('REQ-PNPM11-011: returns current unchanged when no block is present', () => {
    const original = "minimumReleaseAgeExclude:\n  - '@achmea/*'\n";
    const current = "catalog:\n  lodash: '4.17.20'\n";
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(current);
  });

  it('REQ-PNPM11-011: returns current unchanged when the block already matches', () => {
    const original = "minimumReleaseAgeExclude:\n  - '@achmea/*'\ncatalog:\n  lodash: '4.17.20'\n";
    const current = original;
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(current);
  });

  it('REQ-PNPM11-011: removes a block located at end of file', () => {
    const original = 'catalog:\n  lodash: 4.17.20';
    const current = 'catalog:\n  lodash: 4.17.20\nminimumReleaseAgeExclude:\n  - x@1.0.0\n';
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(
      'catalog:\n  lodash: 4.17.20\n',
    );
  });

  it('REQ-PNPM11-011: preserves CRLF line endings when restoring (REQ-PORTABILITY-003)', () => {
    const original = "minimumReleaseAgeExclude:\n  - '@achmea/*'\n";
    const current =
      "minimumReleaseAgeExclude:\r\n  - '@achmea/*'\r\n  - 'axios@1.7.4'\r\ncatalog:\r\n  lodash: '4.17.20'\r\n";
    const result = restoreMinimumReleaseAgeExclude(current, original);
    expect(result).toBe(
      "minimumReleaseAgeExclude:\r\n  - '@achmea/*'\r\ncatalog:\r\n  lodash: '4.17.20'\r\n",
    );
  });

  it('REQ-PNPM11-011: stops at the next top-level key and leaves it intact', () => {
    const original = 'catalog:\n  lodash: 4.17.20\n';
    const current =
      'minimumReleaseAgeExclude:\n  - x@1.0.0\ncatalog:\n  lodash: 4.17.20\npackages:\n  - pkgs/*\n';
    expect(restoreMinimumReleaseAgeExclude(current, original)).toBe(
      'catalog:\n  lodash: 4.17.20\npackages:\n  - pkgs/*\n',
    );
  });
});
