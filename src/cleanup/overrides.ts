import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { resolveWorkspacePackageDirs } from '../workspace/packageScope';
import { findWorkspaceFiles } from '../fsWalk';
import { removeJsonProperty } from '../jsonEdit';
import { collapseBlankLines } from '../workspaceYaml';

/**
 * Strip the `overrides:` block from pnpm-workspace.yaml and store the desired
 * content in `state.yaml.desiredWorkspaceYaml`.
 */
export function removeWorkspaceOverridesBlock(state: WorkspaceState, logger: Logger): void {
  logger.step("Remove workspace 'overrides:' block");

  if (!state.yaml.hasWorkspaceYaml) {
    logger.detail('No pnpm-workspace.yaml — skipping workspace overrides cleanup.');
    return;
  }

  const original = state.yaml.readWorkspaceYaml();
  // Match the overrides block and any blank line that immediately follows it,
  // so removal does not leave a stray blank line behind.
  const pattern = /^overrides:[ \t]*\r?\n(?:[ \t]+\S.*\r?\n?)*(?:\r?\n)?/m;

  let desired: string;
  if (pattern.test(original)) {
    desired = original.replace(pattern, '');
    desired = collapseBlankLines(desired);
    desired = desired.replace(/[\r\n]+$/, '') + state.yaml.yamlEol;
    logger.detail("Removed 'overrides:' block from pnpm-workspace.yaml.");
  } else {
    desired = original;
    logger.detail("No 'overrides:' block found in pnpm-workspace.yaml.");
  }

  state.yaml.writeDesiredWorkspaceYaml(desired);
}

/**
 * Strip `pnpm.overrides` from every package.json in the workspace.
 * Direct-dep vulnerabilities are solved in the catalog, not via overrides;
 * transitive-only overrides will be re-added by `pnpm audit --fix` later, and
 * any catalog-eligible ones are then promoted into the catalog.
 */
export function removePackageJsonOverrides(state: WorkspaceState, logger: Logger): void {
  logger.step("Remove 'pnpm.overrides' from package.json files");

  let packageJsons: string[];
  if (state.isMultiPackageWorkspace) {
    const packageDirs = resolveWorkspacePackageDirs(state);
    packageJsons = findWorkspaceFiles(state.workspaceRoot, 'package.json').filter(
      (pjPath) => packageDirs === null || packageDirs.has(path.dirname(pjPath)),
    );
  } else {
    // Single-package mode: only the root package.json. The mode banner is
    // emitted once in `prepareRun`; `WorkspaceState.initialize` already
    // guarantees the root package.json exists in this branch.
    packageJsons = [state.rootPackageJson];
  }

  for (const pjPath of packageJsons) {
    let text: string;
    try {
      text = fs.readFileSync(pjPath, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('"overrides"')) continue;

    const original = text;

    // Surgically remove `pnpm.overrides` (and an empty `pnpm` parent if it
    // becomes vacant) using jsonc-parser. This preserves whitespace,
    // property order, and trailing newline byte-for-byte.
    let parsed: { pnpm?: { overrides?: unknown } } | null;
    try {
      parsed = JSON.parse(text) as { pnpm?: { overrides?: unknown } };
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: pre-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.pnpm || !('overrides' in parsed.pnpm)) {
      continue;
    }

    text = removeJsonProperty(text, 'pnpm', 'overrides');

    // If the pnpm block is now empty (no remaining keys), drop it too.
    try {
      const reparsed = JSON.parse(text) as { pnpm?: Record<string, unknown> };
      if (
        reparsed.pnpm &&
        typeof reparsed.pnpm === 'object' &&
        Object.keys(reparsed.pnpm).length === 0
      ) {
        text = removeJsonProperty(text, 'pnpm');
      }
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: post-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }

    if (text === original) continue;

    try {
      JSON.parse(text);
    } catch (e) {
      logger.warn(`Skipped ${pjPath}: post-edit JSON was invalid (${(e as Error).message}).`);
      continue;
    }

    // Normalize trailing whitespace to exactly one newline.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.replace(/[\s]+$/, '') + eol;
    if (!state.yaml.dryRun) {
      fs.writeFileSync(pjPath, text, { encoding: 'utf8' });
    }
    const rel = path.relative(state.workspaceRoot, pjPath);
    logger.detail(
      `${state.yaml.dryRun ? 'Dry-run: would remove' : 'Removed'} pnpm.overrides from ${rel}.`,
    );
  }
}
