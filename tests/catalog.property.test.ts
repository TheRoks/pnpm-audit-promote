import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCatalogUpdates, getCatalogVersions, collapseBlankLines } from '../src/catalog';

/**
 * Property-based round-trip tests for `applyCatalogUpdates`. Verifies
 * algebraic invariants that example-based tests in `catalog.test.ts`
 * cannot exhaustively cover.
 */

const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const versionArb = fc
  .tuple(
    fc.integer({ min: 0, max: 50 }),
    fc.integer({ min: 0, max: 50 }),
    fc.integer({ min: 0, max: 50 }),
  )
  .map(([a, b, c]) => `${a}.${b}.${c}`);

/**
 * Build a minimal but well-formed pnpm-workspace.yaml with N unique
 * `name -> version` pairs in the catalog.
 */
const catalogYamlArb = fc
  .uniqueArray(fc.tuple(packageNameArb, versionArb), {
    minLength: 1,
    maxLength: 8,
    selector: ([name]) => name,
  })
  .map((entries) => {
    const lines = ['packages:', "  - 'apps/*'", '', 'catalog:'];
    for (const [name, version] of entries) {
      lines.push(`  ${name}: '${version}'`);
    }
    lines.push('');
    return { yaml: lines.join('\n'), entries };
  });

describe('catalog property tests', () => {
  it('REQ-CATALOG-001: applyCatalogUpdates round-trips updated versions through getCatalogVersions', () => {
    fc.assert(
      fc.property(catalogYamlArb, versionArb, (input, newVersion) => {
        const targetName = input.entries[0]?.[0] ?? '';
        const updated = applyCatalogUpdates(input.yaml, new Map([[targetName, newVersion]]));
        const versions = getCatalogVersions(updated);
        expect(versions.get(targetName)).toBe(newVersion);
        // Other entries must remain unchanged.
        for (const [name, ver] of input.entries.slice(1)) {
          expect(versions.get(name)).toBe(ver);
        }
      }),
    );
  });

  it('REQ-CATALOG-001: a no-op update (empty map) returns the source byte-for-byte', () => {
    fc.assert(
      fc.property(catalogYamlArb, (input) => {
        expect(applyCatalogUpdates(input.yaml, new Map())).toBe(input.yaml);
      }),
    );
  });

  it('REQ-CATALOG-001: an update to the same version is idempotent (output equals input)', () => {
    fc.assert(
      fc.property(catalogYamlArb, (input) => {
        const sameMap = new Map(input.entries);
        const out = applyCatalogUpdates(input.yaml, sameMap);
        expect(getCatalogVersions(out)).toEqual(getCatalogVersions(input.yaml));
      }),
    );
  });

  it('REQ-CATALOG-001: applyCatalogUpdates is idempotent — apply twice == apply once', () => {
    fc.assert(
      fc.property(catalogYamlArb, versionArb, (input, newVersion) => {
        const targetName = input.entries[0]?.[0] ?? '';
        const updates = new Map([[targetName, newVersion]]);
        const once = applyCatalogUpdates(input.yaml, updates);
        const twice = applyCatalogUpdates(once, updates);
        expect(twice).toBe(once);
      }),
    );
  });

  it('REQ-CATALOG-001: updates preserve every non-catalog (header) line of the source', () => {
    fc.assert(
      fc.property(catalogYamlArb, versionArb, (input, newVersion) => {
        const targetName = input.entries[0]?.[0] ?? '';
        const updated = applyCatalogUpdates(input.yaml, new Map([[targetName, newVersion]]));
        // Lines before the `catalog:` header must round-trip exactly.
        const headerLen = input.yaml.split('\n').findIndex((l) => l.trim() === 'catalog:');
        const inputHead = input.yaml
          .split('\n')
          .slice(0, headerLen + 1)
          .join('\n');
        const updatedHead = updated
          .split('\n')
          .slice(0, headerLen + 1)
          .join('\n');
        expect(updatedHead).toBe(inputHead);
      }),
    );
  });

  describe('collapseBlankLines', () => {
    it('REQ-CATALOG-005: never increases the number of consecutive blank lines', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('a', 'b', 'c', '', '', ''), { minLength: 1, maxLength: 30 }),
          (lines) => {
            const text = lines.join('\n');
            const out = collapseBlankLines(text);
            const maxRun = (s: string) => {
              let max = 0;
              let cur = 0;
              for (const line of s.split('\n')) {
                if (line === '') {
                  cur++;
                  if (cur > max) max = cur;
                } else {
                  cur = 0;
                }
              }
              return max;
            };
            expect(maxRun(out)).toBeLessThanOrEqual(maxRun(text));
          },
        ),
      );
    });

    it('REQ-CATALOG-005: is idempotent — collapseBlankLines(collapseBlankLines(x)) === collapseBlankLines(x)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('a', 'b', '', '', ''), { minLength: 1, maxLength: 20 }),
          (lines) => {
            const once = collapseBlankLines(lines.join('\n'));
            expect(collapseBlankLines(once)).toBe(once);
          },
        ),
      );
    });
  });
});
