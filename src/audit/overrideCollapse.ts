import semver from 'semver';
import {
  compareSemVer,
  isPlainPackageName,
  getBarePackageName,
  normalizeRange,
} from '../semverUtil';

/**
 * Pick the stronger (higher minimum) of two fix ranges and emit a
 * major-capped floor (`^X.Y.Z`) so merged survivors do not float into the
 * next major.
 * Returns null when either input has no derivable minimum version.
 */
export function strongestFixRange(a: string, b: string): string | null {
  const minA = semver.minVersion(a)?.version;
  const minB = semver.minVersion(b)?.version;
  if (!minA || !minB) return null;

  const strongestMin = compareSemVer(minA, minB) >= 0 ? minA : minB;
  return `^${strongestMin}`;
}

const ENTRY_RE = /^([ \t]*)"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,?)\s*$/;

/**
 * A single qualified override entry feeding the generic collapse algorithm.
 * `id` is opaque to the algorithm and is echoed back via `drop`/`updates`
 * so callers can map decisions onto their own substrate (line indices,
 * YAML AST positions, etc).
 */
export interface QualifiedOverrideEntry<TId> {
  id: TId;
  /** Bare package name (e.g. `axios`, `@scope/pkg`). */
  bare: string;
  /** Normalized SemVer range derived from the qualifier portion of the key. */
  range: string;
  /** Current fix value (e.g. `>=1.15.1`). */
  val: string;
}

/**
 * Decisions produced by the generic collapse algorithm.
 *
 * - `drop`: ids of entries that should be removed (subsumed by another).
 * - `updates`: ids whose `val` should be replaced with the merged stronger
 *   fix range. Only present when the merged value differs from the original.
 */
export interface CollapseDecisions<TId> {
  drop: Set<TId>;
  updates: Map<TId, string>;
  rangeUpdates: Map<TId, string>;
}

interface RangeInterval {
  lower: string | null;
  lowerInclusive: boolean;
  upper: string | null;
  upperInclusive: boolean;
}

function parseSingleInterval(range: string): RangeInterval | null {
  let parsed: semver.Range;
  try {
    parsed = new semver.Range(range);
  } catch {
    return null;
  }
  if (parsed.set.length !== 1) return null;
  const comparators = parsed.set[0];
  if (!comparators) return null;

  const interval: RangeInterval = {
    lower: null,
    lowerInclusive: false,
    upper: null,
    upperInclusive: false,
  };

  for (const comp of comparators) {
    const op = comp.operator;
    const isWildcard = comp.value === '';
    const v = comp.semver?.version;
    if (isWildcard || !v) continue;

    if (op === '') {
      interval.lower = v;
      interval.lowerInclusive = true;
      interval.upper = v;
      interval.upperInclusive = true;
      continue;
    }

    if (op === '>' || op === '>=') {
      if (!interval.lower || semver.gt(v, interval.lower)) {
        interval.lower = v;
        interval.lowerInclusive = op === '>=';
      } else if (interval.lower === v) {
        interval.lowerInclusive = interval.lowerInclusive && op === '>=';
      }
      continue;
    }

    if (op === '<' || op === '<=') {
      if (!interval.upper || semver.lt(v, interval.upper)) {
        interval.upper = v;
        interval.upperInclusive = op === '<=';
      } else if (interval.upper === v) {
        interval.upperInclusive = interval.upperInclusive && op === '<=';
      }
    }
  }

  if (interval.lower && interval.upper) {
    const cmp = semver.compare(interval.lower, interval.upper);
    if (cmp > 0) return null;
    if (cmp === 0 && !(interval.lowerInclusive && interval.upperInclusive)) return null;
  }

  return interval;
}

function intervalsOverlap(a: RangeInterval, b: RangeInterval): boolean {
  if (a.upper && b.lower) {
    const cmp = semver.compare(a.upper, b.lower);
    if (cmp < 0) return false;
    if (cmp === 0 && !(a.upperInclusive && b.lowerInclusive)) return false;
  }
  if (b.upper && a.lower) {
    const cmp = semver.compare(b.upper, a.lower);
    if (cmp < 0) return false;
    if (cmp === 0 && !(b.upperInclusive && a.lowerInclusive)) return false;
  }
  return true;
}

function unionIntervals(a: RangeInterval, b: RangeInterval): RangeInterval {
  const chooseLower = (): { version: string | null; inclusive: boolean } => {
    if (!a.lower || !b.lower) return { version: null, inclusive: false };
    const cmp = semver.compare(a.lower, b.lower);
    if (cmp < 0) return { version: a.lower, inclusive: a.lowerInclusive };
    if (cmp > 0) return { version: b.lower, inclusive: b.lowerInclusive };
    return { version: a.lower, inclusive: a.lowerInclusive || b.lowerInclusive };
  };

  const chooseUpper = (): { version: string | null; inclusive: boolean } => {
    if (!a.upper || !b.upper) return { version: null, inclusive: false };
    const cmp = semver.compare(a.upper, b.upper);
    if (cmp > 0) return { version: a.upper, inclusive: a.upperInclusive };
    if (cmp < 0) return { version: b.upper, inclusive: b.upperInclusive };
    return { version: a.upper, inclusive: a.upperInclusive || b.upperInclusive };
  };

  const lower = chooseLower();
  const upper = chooseUpper();
  return {
    lower: lower.version,
    lowerInclusive: lower.inclusive,
    upper: upper.version,
    upperInclusive: upper.inclusive,
  };
}

function intervalToRange(interval: RangeInterval): string | null {
  if (!interval.lower && !interval.upper) return null;
  if (
    interval.lower &&
    interval.upper &&
    interval.lower === interval.upper &&
    interval.lowerInclusive &&
    interval.upperInclusive
  ) {
    return interval.lower;
  }

  const parts: string[] = [];
  if (interval.lower) parts.push(`${interval.lowerInclusive ? '>=' : '>'}${interval.lower}`);
  if (interval.upper) parts.push(`${interval.upperInclusive ? '<=' : '<'}${interval.upper}`);
  const candidate = parts.join(' ');
  return semver.validRange(candidate) ? candidate : null;
}

function mergeOverlappingRanges(a: string, b: string): string | null {
  const ai = parseSingleInterval(a);
  const bi = parseSingleInterval(b);
  if (!ai || !bi) return null;
  if (!intervalsOverlap(ai, bi)) return null;
  return intervalToRange(unionIntervals(ai, bi));
}

/**
 * Generic collapse core: for every pair of entries that share a bare
 * package name and whose ranges are subsets of one another, drop the
 * narrower entry (or the duplicate) and lift the stronger fix range onto
 * the surviving broader entry.
 *
 * Substrate-agnostic — works on JSON-line entries, YAML AST pairs, or any
 * other source as long as the caller produces normalized `bare`/`range`
 * tuples.
 */
export function collapseQualifiedOverrideEntries<TId>(
  entries: readonly QualifiedOverrideEntry<TId>[],
): CollapseDecisions<TId> {
  const drop = new Set<TId>();
  const updates = new Map<TId, string>();
  const rangeUpdates = new Map<TId, string>();
  if (entries.length < 2) return { drop, updates, rangeUpdates };

  // Working copies so the iteration can update values mid-pass.
  const working = entries.map((e) => ({ ...e, originalVal: e.val, originalRange: e.range }));

  const groups = new Map<string, typeof working>();
  for (const e of working) {
    const arr = groups.get(e.bare);
    if (arr) arr.push(e);
    else groups.set(e.bare, [e]);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (!a || drop.has(a.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        if (!b || drop.has(b.id)) continue;
        let aInB: boolean;
        let bInA: boolean;
        try {
          aInB = semver.subset(a.range, b.range);
          bInA = semver.subset(b.range, a.range);
        } catch {
          continue;
        }
        if (aInB && bInA) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          a.val = merged;
          // Equivalent selectors; keep first occurrence for stable output.
          drop.add(b.id);
          continue;
        }
        if (aInB) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          b.val = merged;
          // a is narrower than b; drop a and keep broader b with strongest fix.
          drop.add(a.id);
          break;
        }
        if (bInA) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          a.val = merged;
          // b is narrower than a; drop b and keep broader a with strongest fix.
          drop.add(b.id);
          continue;
        }

        const union = mergeOverlappingRanges(a.range, b.range);
        if (union) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          // Overlapping selectors can be represented by one broader union.
          // Keep first occurrence for deterministic output and rewrite range.
          a.range = union;
          a.val = merged;
          drop.add(b.id);
        }
      }
    }
  }

  for (const e of working) {
    if (!drop.has(e.id) && e.val !== e.originalVal) {
      updates.set(e.id, e.val);
    }
    if (!drop.has(e.id) && e.range !== e.originalRange) {
      rangeUpdates.set(e.id, e.range);
    }
  }
  return { drop, updates, rangeUpdates };
}

/**
 * Detect qualified overrides for the same bare package whose selector ranges
 * are subsets of one another, and collapse them into the broader selector
 * carrying the strongest fix range. Reduces noise in `pnpm.overrides` after
 * `pnpm audit --fix` adds multiple narrow ranges that could all be satisfied
 * by a single broader rule.
 */
export function collapseRedundantQualifiedPackageJsonOverrides(lines: readonly string[]): string[] {
  type Meta = { indent: string; key: string; bare: string; trailingComma: string };
  const meta = new Map<number, Meta>();
  const entries: QualifiedOverrideEntry<number>[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const indent = m[1] ?? '';
    const key = m[2] ?? '';
    const val = m[3] ?? '';
    const trailingComma = m[4] ?? '';
    if (isPlainPackageName(key)) continue;

    const bare = getBarePackageName(key);
    const keyRange = key.slice(bare.length + 1);
    const normalized = normalizeRange(keyRange);
    if (!normalized) continue;
    meta.set(i, { indent, key, bare, trailingComma });
    entries.push({ id: i, bare, range: normalized, val });
  }

  const { drop, updates, rangeUpdates } = collapseQualifiedOverrideEntries(entries);
  if (drop.size === 0 && updates.size === 0 && rangeUpdates.size === 0) return [...lines];

  const out: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (drop.has(idx)) continue;
    const updatedVal = updates.get(idx);
    const updatedRange = rangeUpdates.get(idx);
    const m = meta.get(idx);
    if (m && (updatedVal !== undefined || updatedRange !== undefined)) {
      // Preserve the trailing comma if the original had one; otherwise add
      // one (the post-collapse cleanup pass strips a dangling comma at end).
      const comma = m.trailingComma || ',';
      const key = updatedRange !== undefined ? `${m.bare}@${updatedRange}` : m.key;
      const val = updatedVal ?? lines[idx]?.match(ENTRY_RE)?.[3] ?? '';
      out.push(`${m.indent}"${key}": "${val}"${comma}`);
      continue;
    }
    out.push(lines[idx] ?? '');
  }
  return out;
}
