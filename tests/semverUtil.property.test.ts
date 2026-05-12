import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareSemVer, getBarePackageName, isPlainPackageName } from '../src/semverUtil';

/**
 * Property-based coverage for `semverUtil`. These tests complement the
 * example-based suite in `semverUtil.test.ts` by exercising algebraic
 * laws (total order, idempotency, ...) over a broad input space.
 */

const versionArb = fc
  .tuple(
    fc.integer({ min: 0, max: 50 }),
    fc.integer({ min: 0, max: 50 }),
    fc.integer({ min: 0, max: 50 }),
  )
  .map(([a, b, c]) => `${a}.${b}.${c}`);

const scopeArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const nameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const packageNameArb = fc.oneof(
  nameArb,
  fc.tuple(scopeArb, nameArb).map(([s, n]) => `@${s}/${n}`),
);
const rangeQualifierArb = fc.constantFrom(
  '^1.0.0',
  '~2.3.4',
  '>=3.0.0',
  '<=4.5.6',
  '5.0.0',
  '>=1.0.0 <2.0.0',
);

describe('semverUtil property tests', () => {
  describe('compareSemVer', () => {
    it('REQ-AUDIT-001: is reflexive — compareSemVer(v, v) === 0', () => {
      fc.assert(
        fc.property(versionArb, (v) => {
          expect(compareSemVer(v, v)).toBe(0);
        }),
      );
    });

    it('REQ-AUDIT-001: is anti-symmetric — sign(cmp(a,b)) === -sign(cmp(b,a))', () => {
      fc.assert(
        fc.property(versionArb, versionArb, (a, b) => {
          expect(Math.sign(compareSemVer(a, b))).toBe(-Math.sign(compareSemVer(b, a)));
        }),
      );
    });

    it('REQ-AUDIT-001: is transitive — a<=b && b<=c implies a<=c', () => {
      fc.assert(
        fc.property(versionArb, versionArb, versionArb, (a, b, c) => {
          const ab = compareSemVer(a, b);
          const bc = compareSemVer(b, c);
          if (ab <= 0 && bc <= 0) {
            expect(compareSemVer(a, c)).toBeLessThanOrEqual(0);
          }
        }),
      );
    });

    it('REQ-AUDIT-001: returns ±1 or 0 only', () => {
      fc.assert(
        fc.property(versionArb, versionArb, (a, b) => {
          const r = compareSemVer(a, b);
          expect([-1, 0, 1]).toContain(r);
        }),
      );
    });
  });

  describe('getBarePackageName', () => {
    it('REQ-OVERRIDES-005: round-trips a plain package name (no qualifier added or stripped)', () => {
      fc.assert(
        fc.property(packageNameArb, (name) => {
          expect(getBarePackageName(name)).toBe(name);
        }),
      );
    });

    it('REQ-OVERRIDES-005: strips an `@<range>` qualifier and recovers the bare name', () => {
      fc.assert(
        fc.property(packageNameArb, rangeQualifierArb, (name, range) => {
          const key = `${name}@${range}`;
          expect(getBarePackageName(key)).toBe(name);
        }),
      );
    });

    it('REQ-OVERRIDES-005: is idempotent — getBarePackageName(getBarePackageName(x)) === getBarePackageName(x)', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            packageNameArb,
            fc.tuple(packageNameArb, rangeQualifierArb).map(([n, r]) => `${n}@${r}`),
          ),
          (key) => {
            const once = getBarePackageName(key);
            expect(getBarePackageName(once)).toBe(once);
          },
        ),
      );
    });
  });

  describe('isPlainPackageName', () => {
    it('REQ-OVERRIDES-005: returns true for any plain package name', () => {
      fc.assert(
        fc.property(packageNameArb, (name) => {
          expect(isPlainPackageName(name)).toBe(true);
        }),
      );
    });

    it('REQ-OVERRIDES-005: returns false when an `@<range>` qualifier is present', () => {
      fc.assert(
        fc.property(packageNameArb, rangeQualifierArb, (name, range) => {
          expect(isPlainPackageName(`${name}@${range}`)).toBe(false);
        }),
      );
    });
  });
});
