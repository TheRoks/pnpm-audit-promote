import * as fs from 'node:fs';
import type { Logger } from '../logger.js';
import type { PnpmRunner } from '../pnpm.js';
import type { WorkspaceState } from '../workspace.js';
import {
  extractAdvisories,
  readAllOverrides,
  readCatalogSnapshot,
  safeReadFile,
} from './collect.js';
import { renderTerminalSummary } from './render.js';
import type { AdvisorySummary, RunSummaryData } from './types.js';

export interface EmitRunSummaryArgs {
  state: WorkspaceState;
  pnpm: PnpmRunner;
  logger: Logger;
  /** When false, summary emission is skipped entirely. */
  enabled: boolean;
  /** Optional path to write a plain-text copy of the summary. */
  summaryFile?: string;
  skipAudit: boolean;
  dryRun: boolean;
  durationMs: number;
  toolVersion: string;
  workspaceName: string | undefined;
  originalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  initialAdvisories: readonly AdvisorySummary[];
}

/**
 * Capture the post-run state, render a terminal-pretty summary, and
 * (optionally) write a plain-text copy to `summaryFile`. Returns the
 * computed {@link RunSummaryData} (or `null` if disabled) so callers
 * can expose it programmatically.
 */
export async function emitRunSummary(args: EmitRunSummaryArgs): Promise<RunSummaryData | null> {
  if (!args.enabled) return null;
  const { state, pnpm, logger, skipAudit, dryRun } = args;

  const finalYaml = state.desiredWorkspaceYaml || (dryRun ? '' : state.readWorkspaceYaml());
  const finalPjText = safeReadFile(state.rootPackageJson);
  const finalCatalog = readCatalogSnapshot(finalYaml);
  const finalOverrides = readAllOverrides(finalYaml, finalPjText);

  let finalAdvisories: AdvisorySummary[] = [];
  if (!skipAudit && !dryRun) {
    try {
      const { stdout } = await pnpm.capture(['audit', '--json']);
      finalAdvisories = extractAdvisories(stdout);
    } catch {
      // Best-effort: leave the remaining-vuln list empty rather than fail the run.
    }
  }

  const summary: RunSummaryData = {
    workspaceRoot: state.workspaceRoot,
    workspaceName: args.workspaceName,
    toolVersion: args.toolVersion,
    durationMs: args.durationMs,
    dryRun,
    auditSkipped: skipAudit,
    originalCatalog: args.originalCatalog,
    finalCatalog,
    originalOverrides: args.originalOverrides,
    finalOverrides,
    initialAdvisories: args.initialAdvisories,
    finalAdvisories,
  };

  const colored = renderTerminalSummary(summary, { color: true });
  logger.raw('');
  logger.raw(colored);

  if (args.summaryFile && !dryRun) {
    try {
      const plain = renderTerminalSummary(summary, { color: false });
      fs.writeFileSync(args.summaryFile, plain + '\n', 'utf8');
      logger.detail(`Wrote run summary to ${args.summaryFile}.`);
    } catch (e) {
      logger.warn(`Could not write summary to ${args.summaryFile}: ${(e as Error).message}.`);
    }
  }

  return summary;
}
