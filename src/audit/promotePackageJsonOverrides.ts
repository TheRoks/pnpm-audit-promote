import * as fs from 'node:fs';
import semver from 'semver';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { applyCatalogUpdates, readCatalog } from '../catalog';
import { findMatchingBrace } from '../jsonEdit';
import { compareSemVer, getBarePackageName, isPlainPackageName } from '../semverUtil';
import { reportPromotions } from './bumpReporting';
import { collapseRedundantQualifiedPackageJsonOverrides } from './overrideCollapse';

/**
 * Promote direct-dependency audit fixes from the root package.json's
 * `pnpm.overrides` block into the pnpm catalog. Returns the (possibly
 * updated) desired workspace yaml content.
 */
export function syncPackageJsonOverridesIntoCatalog(
  state: WorkspaceState,
  desiredYaml: string,
  logger: Logger,
): string {
  if (!fs.existsSync(state.rootPackageJson)) return desiredYaml;

  const pjText = fs.readFileSync(state.rootPackageJson, 'utf8');
  const startMatch = /"overrides"\s*:\s*\{/.exec(pjText);
  if (!startMatch) return desiredYaml;

  const bodyStart = startMatch.index + startMatch[0].length;
  const end = findMatchingBrace(pjText, bodyStart - 1);
  if (end < 0) return desiredYaml;

  const body = pjText.slice(bodyStart, end);

  const { names: catalogNames, versions: catalogVersions } = readCatalog(desiredYaml);
  const promotions = new Map<string, string>();
  const keptLines: string[] = [];
  const entryRe = /^([ \t]*)"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,?)\s*$/;
  let skippedPlainForCatalog = 0;

  for (const line of body.split(/\r?\n/)) {
    const m = entryRe.exec(line);
    if (m) {
      const key = m[2] ?? '';
      const val = m[3] ?? '';
      const bare = getBarePackageName(key);
      if (catalogNames.has(bare)) {
        // Only promote qualified overrides (`name@selector`) where the current
        // catalog version matches the selector range. Bare keys (`name`) do
        // not carry vulnerable-range context and can cause cross-range bumps.
        if (!isPlainPackageName(key)) {
          const keyRange = key.slice(bare.length + 1); // strip `name@`
          const catalogVer = catalogVersions.get(bare);
          const coercedCatalog = catalogVer ? semver.coerce(catalogVer)?.version : undefined;
          if (
            coercedCatalog &&
            semver.validRange(keyRange) &&
            semver.satisfies(coercedCatalog, keyRange)
          ) {
            const minVer = semver.minVersion(val);
            if (minVer) {
              const existing = promotions.get(bare);
              const base = existing ?? catalogVer ?? '';
              if (!base || compareSemVer(minVer.version, base) > 0) {
                promotions.set(bare, minVer.version);
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

  if (skippedPlainForCatalog > 0) {
    logger.detail(
      `Skipped ${skippedPlainForCatalog} plain package.json override(s) for catalog packages because they do not include a vulnerable selector range.`,
    );
  }

  const optimizedKeptLines = collapseRedundantQualifiedPackageJsonOverrides(keptLines);
  const keptChanged = optimizedKeptLines.length !== keptLines.length;

  if (promotions.size === 0 && !keptChanged) return desiredYaml;

  let newYaml = desiredYaml;
  if (promotions.size > 0) {
    reportPromotions(
      desiredYaml,
      promotions,
      'Promoting direct-dependency audit fixes from package.json into the catalog:',
      logger,
    );

    newYaml = applyCatalogUpdates(desiredYaml, promotions);
    state.saveWorkspaceYaml(newYaml);
  }
  if (keptChanged) {
    logger.detail('Collapsed redundant qualified package.json overrides for clarity.');
  }

  // Trim leading/trailing blank lines from the kept entries.
  const cleaned = [...optimizedKeptLines];
  while (cleaned.length > 0 && !cleaned[0]!.trim()) cleaned.shift();
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1]!.trim()) cleaned.pop();

  // Strip any dangling comma from the last remaining entry.
  for (let j = cleaned.length - 1; j >= 0; j--) {
    const l = cleaned[j]!;
    const trailing = /^(.*"\s*)\s*,\s*$/.exec(l);
    if (trailing) {
      cleaned[j] = trailing[1] ?? l;
      break;
    } else if (/"\s*$/.test(l)) {
      break;
    }
  }

  const eol = pjText.includes('\r\n') ? '\r\n' : '\n';
  const newBody = cleaned.length === 0 ? '' : `${eol}${cleaned.join(eol)}${eol}  `;

  let newPj = pjText.slice(0, bodyStart) + newBody + pjText.slice(end);

  if (cleaned.length === 0) {
    newPj = newPj.replace(/,?\s*"overrides"\s*:\s*\{\s*\}\s*,?/s, '');
    newPj = newPj.replace(/,?\s*"pnpm"\s*:\s*\{\s*\}\s*,?/s, '');
    newPj = newPj.replace(/,(\s*,)+/g, ',');
    newPj = newPj.replace(/\{\s*,/g, '{');
    newPj = newPj.replace(/,\s*\}/g, ' }');
  }

  if (!state.dryRun) {
    fs.writeFileSync(state.rootPackageJson, newPj, 'utf8');
  }
  return newYaml;
}
