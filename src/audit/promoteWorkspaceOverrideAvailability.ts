import semver from 'semver';
import { isMap, isScalar } from 'yaml';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner } from '../pnpm';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { parseWorkspaceDoc } from '../workspaceYaml';
import { getBarePackageName, normalizeRange } from '../semverUtil';
import { getAvailableVersions } from './registry';
import { planWorkspaceOverrideAvailability } from './overrideAvailabilityPolicy';

/** Read registry metadata, apply pure policy, report diagnostics, and save the result. */
export async function guardWorkspaceOverrideAvailability(
  yaml: WorkspaceYamlSnapshot,
  pnpm: PnpmCaptureRunner,
  logger: Logger,
  baselineSafeVersions: ReadonlyMap<string, string> = new Map(),
  originalOverrides: ReadonlyMap<
    string,
    { value: string; source: 'workspace' | 'package.json' }
  > = new Map(),
): Promise<void> {
  if (!yaml.hasWorkspaceYaml) return;
  const current = yaml.readWorkspaceYaml();
  const doc = parseWorkspaceDoc(current);
  const overrides = doc?.get('overrides', true);
  if (!isMap(overrides)) return;

  const names = new Set<string>();
  for (const item of overrides.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null;
    const value = isScalar(item.value) ? String(item.value.value) : null;
    if (key === null || value === null || (!semver.valid(value) && !normalizeRange(value)))
      continue;
    const name = getBarePackageName(key);
    if (name) names.add(name);
  }
  if (names.size === 0) return;

  const versionCache = new Map<string, string[]>();
  await Promise.all([...names].map((name) => getAvailableVersions(pnpm, name, versionCache)));
  const plan = planWorkspaceOverrideAvailability({
    yaml: current,
    availableVersions: versionCache,
    baselineSafeVersions,
    originalOverrides,
  });
  for (const diagnostic of plan.diagnostics) logger[diagnostic.level](diagnostic.message);
  if (!plan.changed) return;
  yaml.writeDesiredWorkspaceYaml(plan.yaml);
}
