import * as fs from 'node:fs';
import { parseDocument } from 'yaml';
import type { Logger } from '../logger';
import type { WorkspaceState } from '../workspace';
import { readWorkspaceOverrides } from '../summary/collect';
import { setJsonProperty } from '../jsonEdit';

/**
 * Move the `overrides:` block from `pnpm-workspace.yaml` into the root
 * `package.json` under `pnpm.overrides`.
 *
 * Rationale: `pnpm` honors `pnpm.overrides` in `package.json` even when
 * `--ignore-workspace` is passed, but it deliberately ignores
 * `pnpm-workspace.yaml` under that flag (the whole point of the flag is
 * to bypass the workspace file). `pnpm audit --fix` still writes its
 * fixes to the workspace yaml, so without this migration step those
 * overrides have no effect on the next install — vulnerabilities then
 * persist even though the tool reports a successful fix.
 *
 * Behavior:
 * - Returns `false` when there is no workspace yaml or no `overrides:`
 *   block to move.
 * - Otherwise rewrites `package.json` with the merged
 *   `pnpm.overrides` (existing entries preserved; yaml entries win on
 *   selector collision) and strips the `overrides:` block from the yaml.
 * - When the yaml was created mid-run by `pnpm audit --fix` (signaled by
 *   an empty `originalWorkspaceYaml`) and has no other top-level keys
 *   left, the yaml file is deleted and `hasWorkspaceYaml` is cleared so
 *   subsequent steps treat the workspace as single-package again.
 * - Respects `state.dryRun`: never writes when set.
 */
export function migrateYamlOverridesToPackageJson(state: WorkspaceState, logger: Logger): boolean {
  if (!state.hasWorkspaceYaml) return false;

  const yamlText = state.readWorkspaceYaml();
  const yamlOverrides = readWorkspaceOverrides(yamlText);
  if (yamlOverrides.size === 0) return false;

  const pjPath = state.rootPackageJson;
  if (!fs.existsSync(pjPath)) return false;

  const pjText = fs.readFileSync(pjPath, 'utf8');
  let parsed: { pnpm?: { overrides?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(pjText) as typeof parsed;
  } catch {
    logger.warn(
      'Could not parse root package.json — skipping migration of yaml overrides to pnpm.overrides.',
    );
    return false;
  }

  const merged: Record<string, string> = { ...(parsed.pnpm?.overrides as Record<string, string>) };
  for (const [k, v] of yamlOverrides) {
    merged[k] = v; // yaml wins on collision (fresh audit output)
  }

  // Rewrite package.json
  let newPj = setJsonProperty(pjText, merged, 'pnpm', 'overrides');
  if (newPj === pjText) {
    // Either nothing actually changed (already in sync) or the editor failed
    // to apply the edit. Fall back to a structured re-serialize.
    parsed.pnpm = { ...(parsed.pnpm ?? {}), overrides: merged };
    newPj = JSON.stringify(parsed, null, 2) + (pjText.endsWith('\n') ? '\n' : '');
  }

  // Strip overrides from yaml document so we don't double-apply on a
  // subsequent run that picks up both files.
  const doc = parseDocument(yamlText);
  doc.delete('overrides');
  let newYaml = String(doc);
  // yaml@2 stringifies an empty document as `{}\n` — collapse that back to
  // an empty string so we can decide whether to delete the file entirely.
  if (newYaml.trim() === '{}') newYaml = '';

  const yamlBecameEmpty = newYaml.trim() === '';
  const yamlWasCreatedMidRun = state.originalWorkspaceYaml === '';

  if (state.dryRun) {
    logger.detail(
      `Dry-run: would move ${yamlOverrides.size} override(s) from pnpm-workspace.yaml into package.json (pnpm.overrides).`,
    );
    return true;
  }

  fs.writeFileSync(pjPath, newPj, 'utf8');

  if (yamlBecameEmpty && yamlWasCreatedMidRun) {
    try {
      fs.unlinkSync(state.workspaceYaml);
    } catch {
      // best-effort: a write below will handle the residual content
    }
    state.hasWorkspaceYaml = false;
    state.desiredWorkspaceYaml = '';
  } else {
    state.desiredWorkspaceYaml = newYaml;
    if (state.hasWorkspaceYaml) {
      fs.writeFileSync(state.workspaceYaml, newYaml, 'utf8');
    }
  }

  logger.detail(
    `Moved ${yamlOverrides.size} override entr${yamlOverrides.size === 1 ? 'y' : 'ies'} from pnpm-workspace.yaml into package.json (pnpm.overrides) for --ignore-workspace compatibility.`,
  );
  return true;
}
