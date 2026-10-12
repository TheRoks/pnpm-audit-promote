import * as fs from 'node:fs';
import type { Logger } from '../logger';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { reportPromotions } from './bumpReporting';
import { planPackageJsonOverridesIntoCatalog } from './packageJsonOverridePromotionPolicy';

export {
  planPackageJsonOverridesIntoCatalog,
  type PackageJsonOverridePromotionPlan,
} from './packageJsonOverridePromotionPolicy';

/** Apply the pure package.json promotion plan at the filesystem boundary. */
export interface PackageJsonOverrideWorkspace {
  rootPackageJson: string;
  yaml: WorkspaceYamlSnapshot;
}

export function syncPackageJsonOverridesIntoCatalog(
  workspace: PackageJsonOverrideWorkspace,
  desiredYaml: string,
  logger: Logger,
): string {
  if (!fs.existsSync(workspace.rootPackageJson)) return desiredYaml;

  const packageJsonText = fs.readFileSync(workspace.rootPackageJson, 'utf8');
  const plan = planPackageJsonOverridesIntoCatalog(packageJsonText, desiredYaml);
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
    workspace.yaml.writeDesiredWorkspaceYaml(plan.yaml);
  }
  for (const diagnostic of plan.diagnostics) logger.detail(diagnostic);
  if (!workspace.yaml.dryRun && plan.packageJsonText !== packageJsonText) {
    fs.writeFileSync(workspace.rootPackageJson, plan.packageJsonText, 'utf8');
  }
  return plan.yaml;
}
