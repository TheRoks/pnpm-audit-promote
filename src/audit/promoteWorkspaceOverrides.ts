import semver from 'semver';
import type { Logger } from '../logger.js';
import type { WorkspaceState } from '../workspace.js';
import {
  CATALOG_BLOCK_PATTERN,
  OVERRIDES_BLOCK_PATTERN,
  applyCatalogUpdates,
  collapseBlankLines,
  readCatalog,
} from '../catalog.js';
import { compareSemVer, getBarePackageName, isPlainPackageName } from '../semverUtil.js';
import { reportPromotions } from './bumpReporting.js';

/**
 * Promote direct-dependency audit fixes from the workspace yaml `overrides:`
 * block into the `catalog:` block. Transitive-only overrides (those whose key
 * carries a version qualifier or names a non-catalog package) are kept.
 * Returns the new desired workspace yaml content.
 */
export function syncAuditOverridesIntoCatalog(state: WorkspaceState, logger: Logger): string {
  const current = state.readWorkspaceYaml();
  const om = OVERRIDES_BLOCK_PATTERN.exec(current);
  const cm = CATALOG_BLOCK_PATTERN.exec(current);
  if (!om || !cm) return current;

  const overridesBody = om[2] ?? '';
  const { names: catalogNames, versions: catalogVersions } = readCatalog(current);
  const remaining: string[] = [];
  const updates = new Map<string, string>();
  const entryPattern =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^'"\r\n]+?))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s]+))\s*$/;

  for (const line of overridesBody.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = entryPattern.exec(line);
    if (m) {
      const key = m[1] ?? m[2] ?? m[3] ?? '';
      const val = m[4] ?? m[5] ?? m[6] ?? '';
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
    }
    remaining.push(line);
  }

  if (updates.size === 0) return current;

  reportPromotions(
    current,
    updates,
    'Promoting direct-dependency audit fixes into the catalog:',
    logger,
  );

  let newYaml = applyCatalogUpdates(current, updates);

  // Re-locate the overrides block in the rewritten yaml and replace or strip.
  const om2 = OVERRIDES_BLOCK_PATTERN.exec(newYaml);
  if (om2) {
    const eol = state.yamlEol;
    if (remaining.length > 0) {
      const remainingBody = remaining.join(eol).replace(/\s+$/, '') + eol;
      const newBlock = `overrides:${eol}${remainingBody}`;
      newYaml = newYaml.slice(0, om2.index) + newBlock + newYaml.slice(om2.index + om2[0].length);
    } else {
      newYaml = newYaml.slice(0, om2.index) + newYaml.slice(om2.index + om2[0].length);
    }
    newYaml = collapseBlankLines(newYaml);
  }

  state.saveWorkspaceYaml(newYaml);
  return newYaml;
}
