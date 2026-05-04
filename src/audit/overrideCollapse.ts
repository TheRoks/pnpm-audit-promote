import semver from 'semver';
import {
  compareSemVer,
  isPlainPackageName,
  getBarePackageName,
  normalizeRange,
} from '../semverUtil.js';

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
 * Detect qualified overrides for the same bare package whose selector ranges
 * are subsets of one another, and collapse them into the broader selector
 * carrying the strongest fix range. Reduces noise in `pnpm.overrides` after
 * `pnpm audit --fix` adds multiple narrow ranges that could all be satisfied
 * by a single broader rule.
 */
export function collapseRedundantQualifiedPackageJsonOverrides(lines: readonly string[]): string[] {
  type Candidate = {
    idx: number;
    bare: string;
    range: string;
    keyRange: string;
    val: string;
    originalVal: string;
    indent: string;
  };
  const candidates: Candidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const indent = m[1] ?? '';
    const key = m[2] ?? '';
    const val = m[3] ?? '';
    if (isPlainPackageName(key)) continue;

    const bare = getBarePackageName(key);
    const keyRange = key.slice(bare.length + 1);
    const normalized = normalizeRange(keyRange);
    if (!normalized) continue;
    candidates.push({
      idx: i,
      bare,
      range: normalized,
      keyRange,
      val,
      originalVal: val,
      indent,
    });
  }

  if (candidates.length < 2) return [...lines];

  const drop = new Set<number>();
  const byIndex = new Map<number, Candidate>();
  for (const c of candidates) byIndex.set(c.idx, c);

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = c.bare;
    const arr = groups.get(k);
    if (arr) arr.push(c);
    else groups.set(k, [c]);
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (!a || drop.has(a.idx)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        if (!b || drop.has(b.idx)) continue;
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
          drop.add(b.idx);
          continue;
        }
        if (aInB) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          b.val = merged;
          // a is narrower than b; drop a and keep broader b with strongest fix.
          drop.add(a.idx);
          break;
        }
        if (bInA) {
          const merged = strongestFixRange(a.val, b.val);
          if (!merged) continue;
          a.val = merged;
          // b is narrower than a; drop b and keep broader a with strongest fix.
          drop.add(b.idx);
        }
      }
    }
  }

  const changedValues = new Set<number>();
  for (const c of candidates) {
    if (c.val !== c.originalVal) changedValues.add(c.idx);
  }

  if (drop.size === 0 && changedValues.size === 0) return [...lines];

  const out: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (drop.has(idx)) continue;
    const candidate = byIndex.get(idx);
    if (candidate && changedValues.has(idx)) {
      const rewritten = `${candidate.indent}"${candidate.bare}@${candidate.keyRange}": "${candidate.val}",`;
      out.push(rewritten);
      continue;
    }
    out.push(lines[idx] ?? '');
  }
  return out;
}
