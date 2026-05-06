import semver from 'semver';
import {
  compareSemVer,
  isPlainPackageName,
  getBarePackageName,
  normalizeRange,
} from '../semverUtil';

/**
 * Pick the stronger (higher minimum) of two `>=X.Y.Z`-style fix ranges.
 * Returns null when either input has no derivable minimum version.
 */
export function strongestFixRange(a: string, b: string): string | null {
  if (a === b) return a;

  const minA = semver.minVersion(a)?.version;
  const minB = semver.minVersion(b)?.version;
  if (!minA || !minB) return null;

  return compareSemVer(minA, minB) >= 0 ? `>=${minA}` : `>=${minB}`;
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
  if (entries.length < 2) return { drop, updates };

  // Working copies so the iteration can update values mid-pass.
  const working = entries.map((e) => ({ ...e, originalVal: e.val }));

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
        }
      }
    }
  }

  for (const e of working) {
    if (!drop.has(e.id) && e.val !== e.originalVal) {
      updates.set(e.id, e.val);
    }
  }
  return { drop, updates };
}

/**
 * Detect qualified overrides for the same bare package whose selector ranges
 * are subsets of one another, and collapse them into the broader selector
 * carrying the strongest fix range. Reduces noise in `pnpm.overrides` after
 * `pnpm audit --fix` adds multiple narrow ranges that could all be satisfied
 * by a single broader rule.
 */
export function collapseRedundantQualifiedPackageJsonOverrides(lines: readonly string[]): string[] {
  type Meta = { indent: string; key: string; trailingComma: string };
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
    meta.set(i, { indent, key, trailingComma });
    entries.push({ id: i, bare, range: normalized, val });
  }

  const { drop, updates } = collapseQualifiedOverrideEntries(entries);
  if (drop.size === 0 && updates.size === 0) return [...lines];

  const out: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (drop.has(idx)) continue;
    const updated = updates.get(idx);
    const m = meta.get(idx);
    if (updated !== undefined && m) {
      // Preserve the trailing comma if the original had one; otherwise add
      // one (the post-collapse cleanup pass strips a dangling comma at end).
      const comma = m.trailingComma || ',';
      out.push(`${m.indent}"${m.key}": "${updated}"${comma}`);
      continue;
    }
    out.push(lines[idx] ?? '');
  }
  return out;
}
