import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logger';
import type { WorkspacePaths } from '../workspace';
import type { WorkspaceMutations } from '../workspace/mutations';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import type { WorkspaceConfiguration } from '../workspace/configuration';
import { resolveWorkspacePackageDirs } from '../workspace/packageScope';
import {
  findWorkspacePackageManifests,
  findPackageManifest,
  readPackageManifest,
  formatForPath,
  removeManifestProperty,
  ensureManifestNewline,
} from '../workspace/packageManifest';
import { collapseBlankLines } from '../workspaceYaml';

interface OverrideCleanupWorkspace {
  paths: WorkspacePaths;
  isMultiPackageWorkspace: boolean;
  mutations: WorkspaceMutations;
  yaml: WorkspaceYamlSnapshot;
  configuration: Pick<WorkspaceConfiguration, 'readWorkspaceYaml' | 'getOwnerSnapshot'>;
}

/**
 * Strip the `overrides:` block from pnpm-workspace.yaml and store the desired
 * content in `state.yaml.desiredWorkspaceYaml`.
 */
export function removeWorkspaceOverridesBlock(
  state: Pick<OverrideCleanupWorkspace, 'yaml' | 'configuration'>,
  logger: Logger,
): void {
  logger.step("Remove workspace 'overrides:' block");

  if (!state.yaml.hasWorkspaceYaml) {
    logger.detail('No pnpm-workspace.yaml — skipping workspace overrides cleanup.');
    return;
  }

  const owner = state.configuration.getOwnerSnapshot('overrides');
  if (!owner) {
    logger.detail(
      "Workspace 'overrides' are owned by a read-only config dependency; skipping cleanup.",
    );
    return;
  }

  const original = owner.readWorkspaceYaml();
  // Match the overrides block and any blank line that immediately follows it,
  // so removal does not leave a stray blank line behind.
  const pattern = /^overrides:[ \t]*\r?\n(?:[ \t]+\S.*\r?\n?)*(?:\r?\n)?/m;

  let desired: string;
  if (pattern.test(original)) {
    desired = original.replace(pattern, '');
    desired = collapseBlankLines(desired);
    desired = desired.replace(/[\r\n]+$/, '') + owner.yamlEol;
    logger.detail(`Removed 'overrides:' block from ${path.basename(owner.path)}.`);
  } else {
    desired = original;
    logger.detail(`No 'overrides:' block found in ${path.basename(owner.path)}.`);
  }

  owner.writeDesiredWorkspaceYaml(desired);
}

/**
 * Strip `pnpm.overrides` from every package.json in the workspace.
 * Direct-dep vulnerabilities are solved in the catalog, not via overrides;
 * transitive-only overrides will be re-added by `pnpm audit --fix` later, and
 * any catalog-eligible ones are then promoted into the catalog.
 */
export function removePackageJsonOverrides(state: OverrideCleanupWorkspace, logger: Logger): void {
  logger.step("Remove 'pnpm.overrides' from package.json files");

  let manifests: string[];
  if (state.isMultiPackageWorkspace) {
    const packageDirs = resolveWorkspacePackageDirs({
      paths: state.paths,
      yaml: state.configuration,
    });
    manifests = findWorkspacePackageManifests(state.paths.workspaceRoot, packageDirs).map(
      (manifest) => manifest.path,
    );
  } else {
    // Single-package mode is confined to the effective root manifest.
    const manifest = findPackageManifest(state.paths.workspaceRoot);
    manifests = manifest ? [manifest.path] : [];
  }

  for (const pjPath of manifests) {
    let text: string;
    try {
      text = fs.readFileSync(pjPath, 'utf8');
    } catch {
      continue;
    }
    const original = text;
    const format = formatForPath(pjPath);
    let parsed: { pnpm?: { overrides?: unknown } } | null;
    try {
      parsed = readPackageManifest(text, format) as { pnpm?: { overrides?: unknown } };
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: pre-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.pnpm || !('overrides' in parsed.pnpm)) {
      continue;
    }

    text = removeManifestProperty(text, format, 'pnpm', 'overrides');

    // If the pnpm block is now empty (no remaining keys), drop it too.
    try {
      const reparsed = readPackageManifest(text, format) as { pnpm?: Record<string, unknown> };
      if (
        reparsed.pnpm &&
        typeof reparsed.pnpm === 'object' &&
        Object.keys(reparsed.pnpm).length === 0
      ) {
        text = removeManifestProperty(text, format, 'pnpm');
      }
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: post-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }

    if (text === original) continue;

    try {
      readPackageManifest(text, format);
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: post-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }

    // Normalize trailing whitespace to exactly one newline.
    text = ensureManifestNewline(text);
    state.mutations.writeTextFile(pjPath, text);
    const rel = path.relative(state.paths.workspaceRoot, pjPath);
    logger.detail(
      `${state.yaml.dryRun ? 'Dry-run: would remove' : 'Removed'} pnpm.overrides from ${rel}.`,
    );
  }
}
