import type { Logger } from '../logger';
import type { WorkspaceYamlSnapshot } from '../workspace/yamlSnapshot';
import { reportPromotions } from './bumpReporting';
import { planAuditOverridesIntoCatalog } from './workspaceOverridePromotionPolicy';

/** Apply the pure promotion plan at the workspace and logging boundary. */
export function syncAuditOverridesIntoCatalog(
  yaml: WorkspaceYamlSnapshot,
  logger: Logger,
  options: {
    catalog?: { names: ReadonlySet<string>; versions: ReadonlyMap<string, string> };
    reportYaml?: string;
    updateCatalogs?: (updates: ReadonlyMap<string, string>) => void;
  } = {},
): string {
  if (!yaml.hasWorkspaceYaml) return '';
  const current = yaml.readWorkspaceYaml();
  const plan = planAuditOverridesIntoCatalog(current, options.catalog);
  if (!plan.changed) return current;

  if (plan.promotions.size > 0) {
    reportPromotions(
      options.reportYaml ?? current,
      plan.promotions,
      'Promoting direct-dependency audit fixes into the catalog:',
      logger,
    );
    options.updateCatalogs?.(plan.promotions);
  }
  for (const diagnostic of plan.diagnostics) logger.detail(diagnostic);
  yaml.writeDesiredWorkspaceYaml(plan.yaml);
  return plan.yaml;
}
