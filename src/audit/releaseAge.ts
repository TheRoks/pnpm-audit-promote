import semver from 'semver';
import { isMap, isScalar, type Pair } from 'yaml';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner } from '../pnpm';
import { fetchPublishTimes } from './releaseAgeRegistry';
import { getAvailableVersions } from './registry';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { parseWorkspaceDoc, serializeDoc } from '../workspaceYaml';
import { getBarePackageName } from '../semverUtil';
import {
  isExcludedByReleaseAge,
  parseMinimumReleaseAgeExclude,
  readMinimumReleaseAge,
  selectReleaseAgeCandidates,
  shouldBlockOverrideForReleaseAge,
  type BlockedOverride,
} from './releaseAgePolicy';
export {
  isExcludedByReleaseAge,
  isOldEnough,
  parseMinimumReleaseAgeExclude,
  readMinimumReleaseAge,
  selectReleaseAgeCandidates,
  shouldBlockOverrideForReleaseAge,
} from './releaseAgePolicy';
export type { BlockedOverride, ReleaseAgeExcludeEntry } from './releaseAgePolicy';

/**
 * REQ-PNPM11-012: after `pnpm audit --fix`, verify every override pnpm wrote
 * into `pnpm-workspace.yaml` against the user's `minimumReleaseAge` gate.
 *
 * An override is dropped when **all** of its satisfying published versions were
 * published more recently than `minimumReleaseAge` ago (i.e. none is old
 * enough). Leaving such an override in place would make the subsequent
 * `pnpm install` fail under pnpm's strict release-age resolution; dropping it
 * keeps the install working without expanding the user's
 * `minimumReleaseAgeExclude` list (REQ-PNPM11-011).
 *
 * Overrides matching the user's own exclude entries are kept, as are overrides
 * whose value is not a plain version/range (e.g. `npm:`/`catalog:`/`link:`),
 * and those for which no candidate version or publish time can be resolved.
 *
 * No-op when there is no workspace yaml, no `overrides` block, or no positive
 * `minimumReleaseAge`. Honours `dryRun` via the YAML snapshot.
 */
export async function guardWorkspaceOverrideReleaseAge(
  yaml: WorkspaceYamlSnapshot,
  pnpm: PnpmCaptureRunner,
  logger: Logger,
  options: { now?: Date } = {},
): Promise<BlockedOverride[]> {
  if (!yaml.hasWorkspaceYaml) return [];
  const current = yaml.readWorkspaceYaml();
  const minutes = readMinimumReleaseAge(current);
  if (minutes === null) return [];

  const doc = parseWorkspaceDoc(current);
  if (!doc) return [];
  const overridesNode = doc.get('overrides', true);
  if (!isMap(overridesNode)) return [];

  const excludeEntries = parseMinimumReleaseAgeExclude(current);
  const now = options.now ?? new Date();
  const versionsCache = new Map<string, string[]>();
  const timesCache = new Map<string, Map<string, string>>();

  const keepItems: Pair[] = [];
  const dropped: BlockedOverride[] = [];

  for (const item of overridesNode.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const val = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || val === null) {
      keepItems.push(item);
      continue;
    }

    const name = getBarePackageName(key);
    const referenceVersion = semver.valid(val) ?? semver.minVersion(val)?.version ?? null;
    if (isExcludedByReleaseAge(name, referenceVersion, excludeEntries)) {
      keepItems.push(item);
      continue;
    }

    const available =
      !semver.valid(val) && semver.validRange(val)
        ? await getAvailableVersions(pnpm, name, versionsCache)
        : [];
    const candidates = selectReleaseAgeCandidates(val, available);
    if (!candidates || candidates.length === 0) {
      keepItems.push(item);
      continue;
    }

    const times = await fetchPublishTimes(pnpm, name, timesCache);
    if (
      !shouldBlockOverrideForReleaseAge({
        name,
        value: val,
        minutes,
        excludeEntries,
        candidates,
        publishTimes: times,
        now,
      })
    ) {
      keepItems.push(item);
      continue;
    }

    dropped.push({ key, name, value: val, minimumReleaseAgeMinutes: minutes });
    logger.warn(
      `Dropping override ${key} -> ${val}: no published version satisfying it is older than ` +
        `minimumReleaseAge (${minutes} min). Re-run once the patch matures, or add it to ` +
        `minimumReleaseAgeExclude yourself to allow the fresh version.`,
    );
  }

  if (dropped.length === 0) return [];

  if (keepItems.length === 0) {
    doc.delete('overrides');
  } else {
    overridesNode.items = keepItems;
  }
  const next = serializeDoc(doc, current);
  yaml.writeDesiredWorkspaceYaml(next);
  logger.detail(
    `Dropped ${dropped.length} override(s) blocked by minimumReleaseAge before reinstall.`,
  );
  return dropped;
}
