import semver from 'semver';
import { isMap, isScalar, type Pair } from 'yaml';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { applyCatalogUpdatesToDoc, parseWorkspaceDoc, readCatalog, serializeDoc } from '../catalog';
import {
  compareSemVer,
  getBarePackageName,
  isPlainPackageName,
  normalizeRange,
} from '../semverUtil';
import { reportPromotions } from './bumpReporting';
import { collapseQualifiedOverrideEntries, type QualifiedOverrideEntry } from './overrideCollapse';

/**
 * Promote direct-dependency audit fixes from the workspace yaml `overrides:`
 * block into the `catalog:` block. Transitive-only overrides (those whose key
 * carries a version qualifier or names a non-catalog package) are kept.
 * Returns the new desired workspace yaml content.
 */
export function syncAuditOverridesIntoCatalog(state: WorkspaceState, logger: Logger): string {
  if (!state.hasWorkspaceYaml) return '';
  const current = state.readWorkspaceYaml();
  const doc = parseWorkspaceDoc(current);
  if (!doc) return current;

  const overridesNode = doc.get('overrides', true);
  const catalogNode = doc.get('catalog', true);
  if (!isMap(overridesNode) || !isMap(catalogNode)) return current;

  const { names: catalogNames, versions: catalogVersions } = readCatalog(current);
  const updates = new Map<string, string>();
  const keepItems: Pair[] = [];

  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const val = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || val === null) {
      keepItems.push(item);
      continue;
    }

    if (isPlainPackageName(key) && catalogNames.has(key)) {
      updates.set(key, val);
      continue;
    }
    // Qualified override (e.g. `vite@<=6.4.1: '>=6.4.2'`): if the bare
    // package is in the catalog and its current version satisfies the
    // override selector, derive a concrete minimum version from the fix
    // range and promote it into the catalog so that pnpm installs the
    // smallest patched release rather than the latest in the range.
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
              updates.set(bareName, minVer.version);
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
  const { items: collapsedItems, changed: collapsedChanged } = collapseQualifiedYamlOverrides(
    keepItems,
    logger,
  );

  if (updates.size === 0 && !collapsedChanged) return current;

  if (updates.size > 0) {
    reportPromotions(
      current,
      updates,
      'Promoting direct-dependency audit fixes into the catalog:',
      logger,
    );

    applyCatalogUpdatesToDoc(doc, updates);
  }

  if (collapsedItems.length === 0) {
    doc.delete('overrides');
  } else {
    overridesNode.items = collapsedItems as typeof overridesNode.items;
  }

  const newYaml = serializeDoc(doc, current);
  state.saveWorkspaceYaml(newYaml);
  return newYaml;
}

/**
 * Run the generic qualified-override collapse algorithm over kept YAML
 * `overrides:` pairs, mutating values where merged and dropping subsumed
 * pairs. Returns the (possibly trimmed) item list and a `changed` flag
 * indicating whether any pair was dropped or had its value rewritten.
 */
function collapseQualifiedYamlOverrides(
  items: Pair[],
  logger: Logger,
): { items: Pair[]; changed: boolean } {
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

  const { drop, updates } = collapseQualifiedOverrideEntries(entries);
  if (drop.size === 0 && updates.size === 0) return { items, changed: false };

  const out: Pair[] = [];
  for (let i = 0; i < items.length; i++) {
    if (drop.has(i)) continue;
    const item = items[i];
    if (!item) continue;
    const updated = updates.get(i);
    if (updated !== undefined && isScalar(item.value)) {
      item.value.value = updated;
    }
    out.push(item);
  }
  logger.detail('Collapsed redundant qualified workspace overrides for clarity.');
  return { items: out, changed: true };
}
