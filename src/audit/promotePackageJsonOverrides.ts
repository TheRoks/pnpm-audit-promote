import * as fs from 'node:fs';
import type { Logger } from '../logger';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { reportPromotions } from './bumpReporting';
import { planPackageManifestOverridesIntoCatalog } from './packageJsonOverridePromotionPolicy';
import { formatForPath } from '../workspace/packageManifest';

export {
  planPackageJsonOverridesIntoCatalog,
  planPackageManifestOverridesIntoCatalog,
  type PackageJsonOverridePromotionPlan,
} from './packageJsonOverridePromotionPolicy';

/** Apply the pure package.json promotion plan at the filesystem boundary. */
export interface PackageJsonOverrideWorkspace {
  rootPackageJson: string;
  yaml: WorkspaceYamlSnapshot;
  updateCatalogs?: (updates: ReadonlyMap<string, string>) => void;
}

export function syncPackageJsonOverridesIntoCatalog(
  workspace: PackageJsonOverrideWorkspace,
  desiredYaml: string,
  logger: Logger,
): string {
  if (!fs.existsSync(workspace.rootPackageJson)) return desiredYaml;

  const packageJsonText = fs.readFileSync(workspace.rootPackageJson, 'utf8');
  const plan = planPackageManifestOverridesIntoCatalog(
    packageJsonText,
    formatForPath(workspace.rootPackageJson),
    desiredYaml,
  );
  if (!plan.changed) {
    for (const diagnostic of plan.diagnostics) logger.detail(diagnostic);
    return desiredYaml;
  }

  if (plan.promotions.size > 0) {
    reportPromotions(
      desiredYaml,
      plan.promotions,
      'Promoting direct-dependency audit fixes from package.json into the catalog:',
      logger,
    );
    if (workspace.updateCatalogs) workspace.updateCatalogs(plan.promotions);
    else workspace.yaml.writeDesiredWorkspaceYaml(plan.yaml);
  }
  for (const diagnostic of plan.diagnostics) logger.detail(diagnostic);
  if (plan.packageJsonText !== packageJsonText) {
    workspace.yaml.mutations.writeTextFile(workspace.rootPackageJson, plan.packageJsonText);
  }
  return plan.yaml;
}
