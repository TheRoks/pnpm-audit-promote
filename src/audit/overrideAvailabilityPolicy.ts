import semver from 'semver';
import { isMap, isScalar, type Pair } from 'yaml';
import { readCatalog } from '../catalog';
import { parseWorkspaceDoc, serializeDoc } from '../workspaceYaml';
import { getBarePackageName, isPlainPackageName, normalizeRange } from '../semverUtil';

export interface OverrideAvailabilityDiagnostic {
  level: 'detail' | 'warn';
  message: string;
}

export interface OverrideAvailabilityPlan {
  yaml: string;
  changed: boolean;
  diagnostics: OverrideAvailabilityDiagnostic[];
}

/** Pure registry-snapshot decision for audit-generated workspace overrides. */
export function planWorkspaceOverrideAvailability(input: {
  yaml: string;
  catalog?: { names: ReadonlySet<string>; versions: ReadonlyMap<string, string> };
  availableVersions: ReadonlyMap<string, readonly string[]>;
  baselineSafeVersions?: ReadonlyMap<string, string>;
  originalOverrides?: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
}): OverrideAvailabilityPlan {
  const {
    yaml: current,
    availableVersions,
    baselineSafeVersions = new Map(),
    originalOverrides = new Map(),
  } = input;
  const diagnostics: OverrideAvailabilityDiagnostic[] = [];
  const doc = parseWorkspaceDoc(current);
  if (!doc) return { yaml: current, changed: false, diagnostics };

  const overridesNode = doc.get('overrides', true);
  if (!isMap(overridesNode)) return { yaml: current, changed: false, diagnostics };

  const { names: catalogNames, versions: catalogVersions } = input.catalog ?? readCatalog(current);
  const eligible = new Map<Pair, { name: string; catalogPromotionEligible: boolean }>();
  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const value = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || value === null || (!semver.valid(value) && !normalizeRange(value)))
      continue;
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
  if (eligible.size === 0) return { yaml: current, changed: false, diagnostics };

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
    const published = availableVersions.get(name) ?? [];
    // Unknown registry state keeps the override so policy does not make an unsafe guess.
    if (published.length === 0) {
      keepItems.push(item);
      continue;
    }

    const currentVersion = catalogPromotionEligible ? catalogVersions.get(name) : undefined;
    const selected = selectPublishedOverrideVersion(value, published, currentVersion);
    if (selected === undefined) {
      keepItems.push(item);
      continue;
    }
    if (selected === null) {
      changed = true;
      diagnostics.push({
        level: 'warn',
        message: `Dropping audit override ${name} -> ${value}: no published stable version satisfies it; leaving the catalog unchanged.`,
      });
      continue;
    }

    const baseline = baselineSafeVersions.get(name);
    const preferred =
      baseline &&
      semver.valid(baseline) &&
      semver.major(baseline) === semver.major(selected) &&
      semver.gt(baseline, selected) &&
      published.includes(baseline) &&
      (semver.valid(value) || semver.satisfies(baseline, normalizeRange(value) ?? value))
        ? baseline
        : selected;
    const originalRange = findCompatibleOriginalOverrideRange(
      name,
      key,
      preferred,
      originalOverrides,
    );
    const vulnerableRange = getQualifiedSelectorRange(name, key);
    const sourceValue = originalRange ?? value;
    const raisedValue = vulnerableRange
      ? raiseOverrideFloorPastVulnerableVersions(sourceValue, vulnerableRange, published)
      : undefined;
    const preferredValue =
      raisedValue ?? originalRange ?? formatPreferredOverrideValue(value, preferred);
    if (
      vulnerableRange &&
      hasPublishedVulnerableMatch(preferredValue, vulnerableRange, published)
    ) {
      changed = true;
      diagnostics.push({
        level: 'warn',
        message: `Dropping audit override ${name} -> ${preferredValue}: no safe published version can be represented beyond selector ${key}.`,
      });
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
      diagnostics.push({
        level: 'detail',
        message: `Adjusted audit override ${name} -> ${value} to published specifier ${preferredValue}.`,
      });
    }
    keepItems.push(item);
  }

  if (!changed) return { yaml: current, changed: false, diagnostics };
  if (keepItems.length === 0) doc.delete('overrides');
  else overridesNode.items = keepItems;
  return { yaml: serializeDoc(doc, current), changed: true, diagnostics };
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
