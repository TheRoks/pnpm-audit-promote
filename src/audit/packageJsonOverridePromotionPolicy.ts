import semver from 'semver';
import { applyCatalogUpdates, readCatalog } from '../catalog';
import { findMatchingBrace } from '../jsonEdit';
import { compareSemVer, getBarePackageName, isPlainPackageName } from '../semverUtil';
import { collapseRedundantQualifiedPackageJsonOverrides } from './overrideCollapse';
import type { PackageManifestFormat } from '../workspace/packageManifest';
import { readPackageManifest, removeManifestProperty } from '../workspace/packageManifest';

export interface PackageJsonOverridePromotionPlan {
  packageJsonText: string;
  yaml: string;
  changed: boolean;
  promotions: ReadonlyMap<string, string>;
  diagnostics: string[];
}

/** Use the same promotion policy for pnpm's JSON5 and YAML package manifests. */
export function planPackageManifestOverridesIntoCatalog(
  manifestText: string,
  format: PackageManifestFormat,
  desiredYaml: string,
): PackageJsonOverridePromotionPlan {
  if (format === 'json') return planPackageJsonOverridesIntoCatalog(manifestText, desiredYaml);
  const unchanged = (diagnostics: string[] = []): PackageJsonOverridePromotionPlan => ({
    packageJsonText: manifestText,
    yaml: desiredYaml,
    changed: false,
    promotions: new Map(),
    diagnostics,
  });

  let manifest: unknown;
  try {
    manifest = readPackageManifest(manifestText, format);
  } catch {
    return unchanged([
      `Could not parse the root ${format} package manifest; skipped override promotion.`,
    ]);
  }
  if (!isRecord(manifest)) return unchanged();
  const pnpm = isRecord(manifest['pnpm']) ? manifest['pnpm'] : null;
  const overrides = pnpm && isRecord(pnpm['overrides']) ? pnpm['overrides'] : null;
  if (!overrides) return unchanged();

  const { names: catalogNames, versions: catalogVersions } = readCatalog(desiredYaml);
  const promotions = new Map<string, string>();
  let skippedPlainForCatalog = 0;
  for (const [key, rawValue] of Object.entries(overrides)) {
    if (typeof rawValue !== 'string') continue;
    const bare = getBarePackageName(key);
    if (!catalogNames.has(bare)) continue;
    if (isPlainPackageName(key)) {
      skippedPlainForCatalog++;
      continue;
    }
    const keyRange = key.slice(bare.length + 1);
    const catalogVersion = catalogVersions.get(bare);
    const coercedCatalog = catalogVersion ? semver.coerce(catalogVersion)?.version : undefined;
    if (
      !coercedCatalog ||
      !semver.validRange(keyRange) ||
      !semver.satisfies(coercedCatalog, keyRange)
    ) {
      continue;
    }
    const minimum = semver.minVersion(rawValue);
    if (!minimum) continue;
    const existing = promotions.get(bare);
    const base = existing ?? catalogVersion ?? '';
    if (!base || compareSemVer(minimum.version, base) > 0) {
      promotions.set(bare, semver.valid(rawValue) ? minimum.version : rawValue);
    }
  }

  if (promotions.size === 0) {
    return unchanged(
      skippedPlainForCatalog > 0
        ? [
            `Skipped ${skippedPlainForCatalog} plain package manifest override(s) for catalog packages because they do not include a vulnerable selector range.`,
          ]
        : [],
    );
  }

  let packageJsonText = manifestText;
  for (const key of Object.keys(overrides)) {
    const bare = getBarePackageName(key);
    if (!promotions.has(bare) || isPlainPackageName(key)) continue;
    const keyRange = key.slice(bare.length + 1);
    const catalogVersion = catalogVersions.get(bare);
    const promoted = promotions.get(bare);
    const coercedCatalog = catalogVersion ? semver.coerce(catalogVersion)?.version : undefined;
    if (
      typeof promoted === 'string' &&
      coercedCatalog &&
      semver.validRange(keyRange) &&
      semver.satisfies(coercedCatalog, keyRange) &&
      semver.minVersion(String(overrides[key])) &&
      compareSemVer(semver.minVersion(String(overrides[key]))!.version, catalogVersion ?? '') > 0
    ) {
      packageJsonText = removeManifestProperty(packageJsonText, format, 'pnpm', 'overrides', key);
    }
  }

  let reparsed: unknown;
  try {
    reparsed = readPackageManifest(packageJsonText, format);
  } catch {
    return unchanged(['Could not validate edited package manifest; skipped override promotion.']);
  }
  const updatedPnpm = isRecord(reparsed) && isRecord(reparsed['pnpm']) ? reparsed['pnpm'] : null;
  const remaining =
    updatedPnpm && isRecord(updatedPnpm['overrides']) ? updatedPnpm['overrides'] : null;
  if (updatedPnpm && remaining && Object.keys(remaining).length === 0) {
    packageJsonText = removeManifestProperty(packageJsonText, format, 'pnpm', 'overrides');
  }
  if (updatedPnpm && Object.keys(updatedPnpm).length === 0) {
    packageJsonText = removeManifestProperty(packageJsonText, format, 'pnpm');
  }

  return {
    packageJsonText,
    yaml: applyCatalogUpdates(desiredYaml, promotions),
    changed: packageJsonText !== manifestText || promotions.size > 0,
    promotions,
    diagnostics:
      skippedPlainForCatalog > 0
        ? [
            `Skipped ${skippedPlainForCatalog} plain package manifest override(s) for catalog packages because they do not include a vulnerable selector range.`,
          ]
        : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pure package.json and catalog transformation for direct override promotion. */
export function planPackageJsonOverridesIntoCatalog(
  packageJsonText: string,
  desiredYaml: string,
): PackageJsonOverridePromotionPlan {
  const unchanged = (diagnostics: string[] = []): PackageJsonOverridePromotionPlan => ({
    packageJsonText,
    yaml: desiredYaml,
    changed: false,
    promotions: new Map(),
    diagnostics,
  });
  const startMatch = /"overrides"\s*:\s*\{/.exec(packageJsonText);
  if (!startMatch) return unchanged();

  const bodyStart = startMatch.index + startMatch[0].length;
  const end = findMatchingBrace(packageJsonText, bodyStart - 1);
  if (end < 0) return unchanged();

  const body = packageJsonText.slice(bodyStart, end);
  const { names: catalogNames, versions: catalogVersions } = readCatalog(desiredYaml);
  const promotions = new Map<string, string>();
  const keptLines: string[] = [];
  const entryRe = /^([ \t]*)"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,?)\s*$/;
  let skippedPlainForCatalog = 0;

  for (const line of body.split(/\r?\n/)) {
    const match = entryRe.exec(line);
    if (match) {
      const key = match[2] ?? '';
      const value = match[3] ?? '';
      const bare = getBarePackageName(key);
      if (catalogNames.has(bare)) {
        // Only qualified overrides carry vulnerable-range context. Bare
        // keys can cause cross-range catalog bumps.
        if (!isPlainPackageName(key)) {
          const keyRange = key.slice(bare.length + 1);
          const catalogVersion = catalogVersions.get(bare);
          const coercedCatalog = catalogVersion
            ? semver.coerce(catalogVersion)?.version
            : undefined;
          if (
            coercedCatalog &&
            semver.validRange(keyRange) &&
            semver.satisfies(coercedCatalog, keyRange)
          ) {
            const minVersion = semver.minVersion(value);
            if (minVersion) {
              const existing = promotions.get(bare);
              const base = existing ?? catalogVersion ?? '';
              if (!base || compareSemVer(minVersion.version, base) > 0) {
                promotions.set(bare, semver.valid(value) ? minVersion.version : value);
                continue;
              }
            }
          }
        } else {
          skippedPlainForCatalog++;
        }
      }
    }
    keptLines.push(line);
  }

  const optimizedKeptLines = collapseRedundantQualifiedPackageJsonOverrides(keptLines);
  const keptChanged = optimizedKeptLines.length !== keptLines.length;
  if (promotions.size === 0 && !keptChanged) {
    return unchanged(
      skippedPlainForCatalog > 0
        ? [
            `Skipped ${skippedPlainForCatalog} plain package.json override(s) for catalog packages because they do not include a vulnerable selector range.`,
          ]
        : [],
    );
  }

  const diagnostics: string[] = [];
  if (skippedPlainForCatalog > 0) {
    diagnostics.push(
      `Skipped ${skippedPlainForCatalog} plain package.json override(s) for catalog packages because they do not include a vulnerable selector range.`,
    );
  }
  if (keptChanged)
    diagnostics.push('Collapsed redundant qualified package.json overrides for clarity.');

  let yaml = desiredYaml;
  if (promotions.size > 0) yaml = applyCatalogUpdates(desiredYaml, promotions);

  // Trim leading/trailing blank lines from the kept entries.
  const cleaned = [...optimizedKeptLines];
  while (cleaned.length > 0 && !cleaned[0]!.trim()) cleaned.shift();
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1]!.trim()) cleaned.pop();

  // Strip any dangling comma from the last remaining entry.
  for (let index = cleaned.length - 1; index >= 0; index--) {
    const line = cleaned[index]!;
    const trailing = /^(.*"\s*)\s*,\s*$/.exec(line);
    if (trailing) {
      cleaned[index] = trailing[1] ?? line;
      break;
    } else if (/"\s*$/.test(line)) {
      break;
    }
  }

  const eol = packageJsonText.includes('\r\n') ? '\r\n' : '\n';
  // Re-use the indentation before the closing `}` of the overrides object.
  const textBeforeClose = packageJsonText.slice(0, end);
  const previousNewline = textBeforeClose.lastIndexOf('\n');
  const rawIndent = previousNewline >= 0 ? textBeforeClose.slice(previousNewline + 1) : '';
  const closingIndent = /^[\t ]*$/.test(rawIndent) ? rawIndent : '  ';
  const newBody = cleaned.length === 0 ? '' : `${eol}${cleaned.join(eol)}${eol}${closingIndent}`;
  let newPackageJsonText =
    packageJsonText.slice(0, bodyStart) + newBody + packageJsonText.slice(end);

  if (cleaned.length === 0) {
    newPackageJsonText = newPackageJsonText.replace(/,?\s*"overrides"\s*:\s*\{\s*\}\s*,?/s, '');
    newPackageJsonText = newPackageJsonText.replace(/,?\s*"pnpm"\s*:\s*\{\s*\}\s*,?/s, '');
    newPackageJsonText = newPackageJsonText.replace(/,(\s*,)+/g, ',');
    newPackageJsonText = newPackageJsonText.replace(/\{\s*,/g, '{');
    newPackageJsonText = newPackageJsonText.replace(/,\s*\}/g, ' }');
  }

  return {
    packageJsonText: newPackageJsonText,
    yaml,
    changed: newPackageJsonText !== packageJsonText || yaml !== desiredYaml,
    promotions,
    diagnostics,
  };
}
