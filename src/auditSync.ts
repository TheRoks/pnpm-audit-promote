import * as fs from 'node:fs';
import type { Logger } from './logger.js';
import type { WorkspaceState } from './workspace.js';
import type { PnpmRunner } from './pnpm.js';
import {
  CATALOG_BLOCK_PATTERN,
  OVERRIDES_BLOCK_PATTERN,
  applyCatalogUpdates,
  collapseBlankLines,
  getCatalogNames,
} from './catalog.js';
import { findMatchingBrace } from './jsonEdit.js';
import {
  compareSemVer,
  getBarePackageName,
  getConcreteVersion,
  isPlainPackageName,
} from './semverUtil.js';

interface PnpmAuditAdvisory {
  module_name?: string;
  patched_versions?: string;
  findings?: Array<{ paths?: string[] }>;
}

interface PnpmAuditOutput {
  advisories?: Record<string, PnpmAuditAdvisory>;
}

/**
 * Compute catalog version bumps for direct-dependency vulnerabilities found
 * by `pnpm audit --json`.
 */
export async function getDirectDepCatalogBumps(
  state: WorkspaceState,
  pnpm: PnpmRunner,
  logger: Logger,
): Promise<Map<string, string>> {
  const bumps = new Map<string, string>();
  const { stdout } = await pnpm.capture(['audit', '--json']);
  if (!stdout.trim()) return bumps;

  let audit: PnpmAuditOutput;
  try {
    audit = JSON.parse(stdout) as PnpmAuditOutput;
  } catch {
    logger.warn('Could not parse audit JSON; skipping pre-audit bump.');
    return bumps;
  }
  if (!audit.advisories) return bumps;

  const catalogNames = getCatalogNames(state.desiredWorkspaceYaml);

  for (const adv of Object.values(audit.advisories)) {
    const module = adv.module_name ?? '';
    if (!catalogNames.has(module)) continue;

    let isDirect = false;
    for (const f of adv.findings ?? []) {
      for (const p of f.paths ?? []) {
        const segs = p.split('>').map((s) => s.trim());
        if (segs.length < 1) continue;
        const first = segs[0] === '.' && segs.length >= 2 ? segs[1] : segs[0];
        if (first === module) {
          isDirect = true;
          break;
        }
      }
      if (isDirect) break;
    }
    if (!isDirect) continue;

    const version = getConcreteVersion(adv.patched_versions ?? '');
    if (!version) continue;

    const existing = bumps.get(module);
    if (!existing || compareSemVer(version, existing) > 0) {
      bumps.set(module, version);
    }
  }
  return bumps;
}

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
  const catalogNames = getCatalogNames(current);
  const remaining: string[] = [];
  const updates = new Map<string, string>();
  const entryPattern =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/;

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
    }
    remaining.push(line);
  }

  if (updates.size === 0) return current;

  logger.detail('Promoting direct-dep audit fixes into catalog:');
  for (const [k, v] of updates) {
    logger.bullet(`${k} -> ${v}`);
  }

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

  const catalogNames = getCatalogNames(desiredYaml);
  const promotions = new Map<string, string>();
  const keptLines: string[] = [];
  const entryRe = /^([ \t]*)"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,?)\s*$/;

  for (const line of body.split(/\r?\n/)) {
    const m = entryRe.exec(line);
    if (m) {
      const key = m[2] ?? '';
      const val = m[3] ?? '';
      const bare = getBarePackageName(key);
      if (catalogNames.has(bare)) {
        const version = getConcreteVersion(val);
        if (version) {
          const existing = promotions.get(bare);
          if (!existing || compareSemVer(version, existing) > 0) {
            promotions.set(bare, version);
          }
          continue;
        }
      }
    }
    keptLines.push(line);
  }

  if (promotions.size === 0) return desiredYaml;

  logger.detail('Promoting direct-dep audit fixes from package.json into catalog:');
  for (const [k, v] of promotions) {
    logger.bullet(`${k} -> ${v}`);
  }

  const newYaml = applyCatalogUpdates(desiredYaml, promotions);
  state.saveWorkspaceYaml(newYaml);

  // Trim leading/trailing blank lines from the kept entries.
  const cleaned = [...keptLines];
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
