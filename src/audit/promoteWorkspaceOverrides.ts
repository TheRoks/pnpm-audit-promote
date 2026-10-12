import semver from 'semver';
import { isMap, isScalar, type Pair } from 'yaml';
import type { Logger } from '../logger';
import type { PnpmRunner } from '../pnpm';
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
import { getAvailableVersions } from './parseAdvisories';

/**
 * Validate audit-generated semver overrides against published registry
 * versions before promotion. pnpm's advisory data can suggest versions that
 * are not actually published; leaving such an override in place would make
 * the post-audit install fail even when the override is transitive-only.
 */
export async function guardWorkspaceOverrideAvailability(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
  baselineSafeVersions: ReadonlyMap<string, string> = new Map(),
  originalOverrides: ReadonlyMap<
    string,
    { value: string; source: 'workspace' | 'package.json' }
  > = new Map(),
): Promise<void> {
  if (!state.hasWorkspaceYaml) return;
  const current = state.readWorkspaceYaml();
  const doc = parseWorkspaceDoc(current);
  if (!doc) return;

  const overridesNode = doc.get('overrides', true);
  if (!isMap(overridesNode)) return;

  const { names: catalogNames, versions: catalogVersions } = readCatalog(current);
  const eligible = new Map<Pair, { name: string; catalogPromotionEligible: boolean }>();
  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const value = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || value === null || (!semver.valid(value) && !normalizeRange(value))) {
      continue;
    }
    const bareName = getBarePackageName(key);
    if (!bareName) continue;
    let catalogPromotionEligible = isPlainPackageName(key) && catalogNames.has(key);
    const catalogVersion = catalogVersions.get(bareName);
    const coercedCatalog = catalogVersion ? semver.coerce(catalogVersion)?.version : undefined;
    const keyRange = key.slice(bareName.length + 1);
    if (
      !isPlainPackageName(key) &&
      catalogNames.has(bareName) &&
      coercedCatalog &&
      semver.validRange(keyRange) &&
      semver.satisfies(coercedCatalog, keyRange)
    ) {
      catalogPromotionEligible = true;
    }
    eligible.set(item, { name: bareName, catalogPromotionEligible });
  }
  if (eligible.size === 0) return;

  const versionCache = new Map<string, string[]>();
  const packageNames = new Set([...eligible.values()].map(({ name }) => name));
  await Promise.all(
    [...packageNames].map((name) => getAvailableVersions(pnpm, name, versionCache)),
  );

  const keepItems: Pair[] = [];
  let changed = false;
  for (const item of overridesNode.items) {
    const target = eligible.get(item);
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const value = isScalar(item.value) ? String(item.value.value) : null;
    if (!target || key === null || value === null) {
      keepItems.push(item);
      continue;
    }
    const { name, catalogPromotionEligible } = target;

    const available = versionCache.get(name) ?? [];
    // An empty list means the registry lookup failed or returned no usable
    // data. Keep the existing behavior when publication status is unknown.
    if (available.length === 0) {
      keepItems.push(item);
      continue;
    }

    const currentVersion = catalogPromotionEligible ? catalogVersions.get(name) : undefined;
    const selected = selectPublishedOverrideVersion(value, available, currentVersion);
    if (selected === undefined) {
      keepItems.push(item);
      continue;
    }
    if (selected === null) {
      changed = true;
      logger.warn(
        `Dropping audit override ${name} -> ${value}: no published stable version satisfies it; leaving the catalog unchanged.`,
      );
      continue;
    }

    const baseline = baselineSafeVersions.get(name);
    const preferred =
      baseline &&
      semver.valid(baseline) &&
      semver.major(baseline) === semver.major(selected) &&
      semver.gt(baseline, selected) &&
      available.includes(baseline) &&
      (semver.valid(value) || semver.satisfies(baseline, normalizeRange(value) ?? value))
        ? baseline
        : selected;
    // pnpm can rewrite the user's ranged override, often to an exact value
    // when the workspace has `savePrefix: ''`. Keep the original range only
    // when it excludes published versions in the vulnerable selector. If its
    // floor is too low, raise it to the first published stable version above
    // the vulnerable range; the lockfile records the version actually resolved.
    const originalRange = findCompatibleOriginalOverrideRange(
      name,
      key,
      preferred,
      originalOverrides,
    );
    const vulnerableRange = getQualifiedSelectorRange(name, key);
    const sourceValue = originalRange ?? value;
    const raisedValue = vulnerableRange
      ? raiseOverrideFloorPastVulnerableVersions(sourceValue, vulnerableRange, available)
      : undefined;
    const preferredValue =
      raisedValue ?? originalRange ?? formatPreferredOverrideValue(value, preferred);
    if (
      vulnerableRange &&
      hasPublishedVulnerableMatch(preferredValue, vulnerableRange, available)
    ) {
      changed = true;
      logger.warn(
        `Dropping audit override ${name} -> ${preferredValue}: no safe published version can be represented beyond selector ${key}.`,
      );
      continue;
    }
    if (
      (catalogPromotionEligible ||
        preferred !== selected ||
        originalRange !== undefined ||
        raisedValue !== undefined) &&
      preferredValue !== value &&
      isScalar(item.value)
    ) {
      item.value.value = preferredValue;
      changed = true;
      logger.detail(
        `Adjusted audit override ${name} -> ${value} to published specifier ${preferredValue}.`,
      );
    }
    keepItems.push(item);
  }

  if (!changed) return;
  if (keepItems.length === 0) {
    doc.delete('overrides');
  } else {
    overridesNode.items = keepItems;
  }
  const next = serializeDoc(doc, current);
  state.saveWorkspaceYaml(next);
  state.desiredWorkspaceYaml = next;
}

function findCompatibleOriginalOverrideRange(
  packageName: string,
  selector: string,
  preferred: string,
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>,
): string | undefined {
  const exactMatch = originalOverrides.get(selector);
  if (exactMatch) {
    return isCompatibleRange(exactMatch.value, preferred) ? exactMatch.value : undefined;
  }

  const compatible = new Set<string>();
  for (const [originalSelector, original] of originalOverrides) {
    if (getBarePackageName(originalSelector) !== packageName) continue;
    if (isCompatibleRange(original.value, preferred)) compatible.add(original.value);
  }
  return compatible.size === 1 ? compatible.values().next().value : undefined;
}

function isCompatibleRange(value: string, version: string): boolean {
  if (semver.valid(value)) return false;
  const range = normalizeRange(value);
  return Boolean(range && semver.satisfies(version, range));
}

function getQualifiedSelectorRange(packageName: string, selector: string): string | undefined {
  if (isPlainPackageName(selector)) return undefined;
  return normalizeRange(selector.slice(packageName.length + 1)) ?? undefined;
}

function getSpecifierRange(value: string): string | undefined {
  const exact = semver.valid(value);
  return exact ? `=${exact}` : (normalizeRange(value) ?? undefined);
}

function hasPublishedVulnerableMatch(
  value: string,
  vulnerableRange: string,
  available: readonly string[],
): boolean {
  const range = getSpecifierRange(value);
  if (!range) return false;
  return available.some((version) => {
    const stable = semver.valid(version);
    return Boolean(
      stable &&
      semver.prerelease(stable) === null &&
      semver.satisfies(stable, range) &&
      semver.satisfies(stable, vulnerableRange),
    );
  });
}

function raiseOverrideFloorPastVulnerableVersions(
  value: string,
  vulnerableRange: string,
  available: readonly string[],
): string | undefined {
  const range = getSpecifierRange(value);
  const minimum = range ? semver.minVersion(range) : null;
  if (!range || !minimum) return undefined;

  const stableVersions = available
    .map((version) => semver.valid(version))
    .filter((version): version is string => version !== null && semver.prerelease(version) === null)
    .sort((a, b) => semver.compare(a, b));
  const vulnerableVersions = stableVersions.filter(
    (version) => semver.satisfies(version, range) && semver.satisfies(version, vulnerableRange),
  );
  const highestVulnerable = vulnerableVersions.at(-1);
  if (!highestVulnerable) return undefined;

  const safeFloor = stableVersions.find(
    (version) =>
      semver.gte(version, minimum) &&
      semver.gt(version, highestVulnerable) &&
      !semver.satisfies(version, vulnerableRange),
  );
  if (!safeFloor) return undefined;

  const adjusted = semver.valid(value) ? safeFloor : formatPreferredOverrideValue(value, safeFloor);
  const adjustedRange = getSpecifierRange(adjusted);
  if (
    !adjustedRange ||
    !stableVersions.some((version) => semver.satisfies(version, adjustedRange))
  ) {
    return undefined;
  }
  if (!hasPublishedVulnerableMatch(adjusted, vulnerableRange, stableVersions)) return adjusted;

  // Some disjoint OR ranges cannot be made safe by changing each clause's
  // floor independently. A simple lower bound is safe when verified against
  // every published stable version in the registry result.
  const lowerBound = `>=${safeFloor}`;
  return hasPublishedVulnerableMatch(lowerBound, vulnerableRange, stableVersions)
    ? undefined
    : lowerBound;
}

/**
 * Keep an audit override's range semantics when moving its lower bound to a
 * preferred published version. In particular, `^1.2.3` must remain a caret
 * range so later compatible patch releases can still be selected.
 */
function formatPreferredOverrideValue(value: string, preferred: string): string {
  if (semver.valid(value)) return preferred;
  const range = normalizeRange(value);
  if (!range) return preferred;

  const clauses = value.split(/\s*\|\|\s*/);
  if (clauses.length > 1) {
    return clauses.map((clause) => `${clause.trim()} >=${preferred}`).join(' || ');
  }

  return clauses
    .map((clause) => {
      const caretOrTilde = clause.match(/^(\s*[~^]\s*)\S+(.*)$/);
      if (caretOrTilde) {
        return `${caretOrTilde[1]}${preferred}${caretOrTilde[2]}`;
      }

      if (/(^|\s)(?:>=|>)\s*\S+/.test(clause)) {
        return clause.replace(/(^|\s)(?:>=|>)\s*\S+/, `$1>=${preferred}`);
      }

      return `${clause.trimEnd()} >=${preferred}`;
    })
    .join(' || ');
}

/** `undefined` means the override is not a plain semver spec and is left alone. */
function selectPublishedOverrideVersion(
  value: string,
  available: readonly string[],
  current?: string,
): string | null | undefined {
  const currentClean = current ? semver.coerce(current)?.version : undefined;
  const stableVersions = available
    .map((version) => semver.valid(version))
    .filter((version): version is string => version !== null && semver.prerelease(version) === null)
    .filter((version) => !currentClean || semver.gte(version, currentClean))
    .sort((a, b) => semver.compare(a, b));

  const exact = semver.valid(value);
  if (exact) {
    return stableVersions.find((version) => semver.eq(version, exact)) ?? null;
  }

  const range = normalizeRange(value);
  if (!range) return undefined;
  return stableVersions.find((version) => semver.satisfies(version, range)) ?? null;
}

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
  if (!isMap(overridesNode)) return current;

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
  const { items: collapsedItems, changed: collapsedChanged } = collapseQualifiedYamlOverrides(
    keepItems,
    logger,
  );

  if (updates.size === 0 && !collapsedChanged && !discarded) return current;

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
  logger.detail('Collapsed redundant qualified workspace overrides for clarity.');
  return { items: out, changed: true };
}
