export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';

export interface AdvisorySummary {
  id: string;
  module: string;
  severity: Severity;
  title: string;
  url?: string;
  cves: string[];
}

export interface CatalogChange {
  name: string;
  before: string;
  after: string;
  bump: 'patch' | 'minor' | 'major' | 'unknown';
}

export interface PackageJsonDepChange {
  /** Absolute path to the package.json file that was modified. */
  pkgJsonPath: string;
  name: string;
  before: string;
  after: string;
  bump: 'patch' | 'minor' | 'major' | 'unknown';
}

export interface OverrideChange {
  selector: string;
  /** Prior value, if any. Always set for `modified` and `removed`. */
  before?: string;
  /** New value. Always set for `added` and `modified`; undefined for `removed`. */
  after?: string;
  source: 'workspace' | 'package.json';
  /**
   * Classification of the change:
   * - `added`    — selector did not exist before this run
   * - `modified` — selector existed but its value changed
   * - `removed`  — selector existed before but is no longer present (e.g.
   *   replaced by a different selector when `pnpm audit --fix` re-derived
   *   the override list from advisories)
   */
  kind: 'added' | 'modified' | 'removed';
}

export interface RunSummaryData {
  workspaceRoot: string;
  workspaceName?: string;
  toolVersion: string;
  durationMs: number;
  dryRun: boolean;
  auditSkipped: boolean;
  originalCatalog: ReadonlyMap<string, string>;
  finalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  finalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  initialAdvisories: readonly AdvisorySummary[];
  finalAdvisories: readonly AdvisorySummary[];
  /** Direct-dep bumps applied to workspace package.json files (non-catalog). */
  pkgJsonDepChanges: readonly PackageJsonDepChange[];
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  info: 4,
  unknown: 5,
};
