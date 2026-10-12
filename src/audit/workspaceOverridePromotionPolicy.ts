import semver from 'semver';
import { isMap, isScalar, type Pair } from 'yaml';
import { applyCatalogUpdatesToDoc, readCatalog } from '../catalog';
import { parseWorkspaceDoc, serializeDoc } from '../workspaceYaml';
import {
  compareSemVer,
  getBarePackageName,
  isPlainPackageName,
  normalizeRange,
} from '../semverUtil';
import { collapseQualifiedOverrideEntries, type QualifiedOverrideEntry } from './overrideCollapse';

export interface WorkspaceOverridePromotionPlan {
  yaml: string;
  changed: boolean;
  promotions: ReadonlyMap<string, string>;
  diagnostics: string[];
}

export function planAuditOverridesIntoCatalog(current: string): WorkspaceOverridePromotionPlan {
  const doc = parseWorkspaceDoc(current);
  if (!doc) return { yaml: current, changed: false, promotions: new Map(), diagnostics: [] };

  const overridesNode = doc.get('overrides', true);
  if (!isMap(overridesNode)) {
    return { yaml: current, changed: false, promotions: new Map(), diagnostics: [] };
  }

  // A missing `catalog:` block disables promotions but still allows the
  // collapse pass to consolidate redundant qualified overrides (which is
  // useful when pnpm 11 writes many open-ended selectors for the same
  // package via `pnpm audit --fix override`).
  const catalogNode = doc.get('catalog', true);
  const hasCatalog = isMap(catalogNode);
  const { names: catalogNames, versions: catalogVersions } = hasCatalog
    ? readCatalog(current)
    : { names: new Set<string>(), versions: new Map<string, string>() };
  const updates = new Map<string, string>();
  const keepItems: Pair[] = [];

  let discarded = false;
  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const val = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || val === null) {
      keepItems.push(item);
      continue;
    }

    if (isPlainPackageName(key) && catalogNames.has(key)) {
      // REQ-OVERRIDES-006: never lower the catalog version.
      // If the override value is at or below the current catalog entry,
      // discard the override as redundant rather than promoting it.
      const currentVer = catalogVersions.get(key);
      if (currentVer && compareSemVer(val, currentVer) <= 0) {
        discarded = true;
        continue;
      }
      updates.set(key, val);
      continue;
    }
    // Qualified override (e.g. `vite@<=6.4.1: '>=6.4.2'`): if the bare
    // package is in the catalog and its current version satisfies the
    // override selector, promote the fix specifier into the catalog. Keep a
    // range as a range so later compatible releases remain eligible.
    if (!isPlainPackageName(key)) {
      const bareName = getBarePackageName(key);
      if (catalogNames.has(bareName)) {
        const keyRange = key.slice(bareName.length + 1); // strip `name@`
        const catalogVer = catalogVersions.get(bareName);
        const coercedCatalog = catalogVer ? semver.coerce(catalogVer)?.version : undefined;
        if (
          coercedCatalog &&
          semver.validRange(keyRange) &&
          semver.satisfies(coercedCatalog, keyRange)
        ) {
          const minVer = semver.minVersion(val);
          if (minVer) {
            const existing = updates.get(bareName);
            const base = existing ?? catalogVer ?? '';
            if (base && compareSemVer(minVer.version, base) > 0) {
              updates.set(bareName, semver.valid(val) ? minVer.version : val);
              continue; // discard the override — catalog will be patched
            }
            // The existing update/catalog is already >= minVer. Discard the
            // override if the updated version won't satisfy the selector
            // anyway (the override condition will never fire after install).
            const finalVer = existing ?? catalogVer ?? '';
            const coercedFinal = finalVer ? semver.coerce(finalVer)?.version : undefined;
            if (coercedFinal && !semver.satisfies(coercedFinal, keyRange)) {
              continue; // dead override — catalog already exceeds the selector
            }
          }
        }
      }
    }
    keepItems.push(item);
  }

  // Even when no catalog promotions happen, collapse subsumed qualified
  // overrides so duplicate / subset selectors don't accumulate over time.
  const { items: collapsedItems, changed: collapsedChanged } =
    collapseQualifiedYamlOverrides(keepItems);

  if (updates.size === 0 && !collapsedChanged && !discarded) {
    return { yaml: current, changed: false, promotions: updates, diagnostics: [] };
  }

  if (updates.size > 0) applyCatalogUpdatesToDoc(doc, updates);

  if (collapsedItems.length === 0) {
    doc.delete('overrides');
  } else {
    overridesNode.items = collapsedItems as typeof overridesNode.items;
  }

  const newYaml = serializeDoc(doc, current);
  const diagnostics = collapsedChanged
    ? ['Collapsed redundant qualified workspace overrides for clarity.']
    : [];
  return { yaml: newYaml, changed: true, promotions: updates, diagnostics };
}

/**
 * Run the generic qualified-override collapse algorithm over kept YAML
 * `overrides:` pairs, mutating values where merged and dropping subsumed
 * pairs. Returns the (possibly trimmed) item list and a `changed` flag
 * indicating whether any pair was dropped or had its value rewritten.
 */
function collapseQualifiedYamlOverrides(items: Pair[]): { items: Pair[]; changed: boolean } {
  if (items.length < 2) return { items, changed: false };

  const entries: QualifiedOverrideEntry<number>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const val = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || val === null) continue;
    if (isPlainPackageName(key)) continue;

    const bare = getBarePackageName(key);
    const keyRange = key.slice(bare.length + 1);
    const normalized = normalizeRange(keyRange);
    if (!normalized) continue;
    entries.push({ id: i, bare, range: normalized, val });
  }

  const { drop, updates, rangeUpdates } = collapseQualifiedOverrideEntries(entries);
  if (drop.size === 0 && updates.size === 0 && rangeUpdates.size === 0) {
    return { items, changed: false };
  }

  const out: Pair[] = [];
  for (let i = 0; i < items.length; i++) {
    if (drop.has(i)) continue;
    const item = items[i];
    if (!item) continue;
    const updated = updates.get(i);
    const updatedRange = rangeUpdates.get(i);
    if (updatedRange !== undefined && isScalar(item.key)) {
      const currentKey = String(item.key.value);
      item.key.value = `${getBarePackageName(currentKey)}@${updatedRange}`;
    }
    if (updated !== undefined && isScalar(item.value)) {
      item.value.value = updated;
    }
    out.push(item);
  }
  return { items: out, changed: true };
}
