import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logger';
import type { PnpmRunner } from '../pnpm';
import type { WorkspaceState } from '../workspace';
import { extractAdvisories, readAllOverrides, readCatalogSnapshot, safeReadFile } from './collect';
import { renderTerminalSummary } from './render';
import type { AdvisorySummary, PackageJsonDepChange, RunSummaryData } from './types';

/**
 * Inputs needed to assemble a {@link RunSummaryData} after the orchestrator
 * has finished its work. Pure-data; no rendering side effects.
 */
export interface CollectRunSummaryArgs {
  state: WorkspaceState;
  pnpm: PnpmRunner;
  skipAudit: boolean;
  dryRun: boolean;
  durationMs: number;
  toolVersion: string;
  workspaceName: string | undefined;
  originalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  initialAdvisories: readonly AdvisorySummary[];
  /** Direct-dep bumps applied to workspace package.json files (non-catalog). */
  pkgJsonDepChanges: readonly PackageJsonDepChange[];
}

/**
 * Capture the post-run state and return a {@link RunSummaryData} struct.
 * Always succeeds; a failed final audit leaves `finalAdvisories` empty
 * rather than throwing.
 */
export async function collectRunSummary(args: CollectRunSummaryArgs): Promise<RunSummaryData> {
  const { state, pnpm, skipAudit, dryRun } = args;

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

  return {
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
    pkgJsonDepChanges: args.pkgJsonDepChanges,
  };
}

export interface RenderRunSummaryArgs {
  logger: Logger;
  /** Optional path to write a plain-text copy of the summary. */
  summaryFile?: string;
  dryRun: boolean;
}

/**
 * Render `summary` to the terminal (color) and optionally write a plain-text
 * copy to `summaryFile`.
 */
export function renderRunSummary(summary: RunSummaryData, args: RenderRunSummaryArgs): void {
  const { logger, summaryFile, dryRun } = args;

  const colored = renderTerminalSummary(summary, { color: process.stdout.isTTY ?? false });
  logger.raw('');
  logger.raw(colored);

  if (summaryFile && !dryRun) {
    try {
      const outputPath = resolveSummaryOutputPath(summary.workspaceRoot, summaryFile);
      const plain = renderTerminalSummary(summary, { color: false });
      fs.writeFileSync(outputPath, plain + '\n', 'utf8');
      logger.detail(`Wrote run summary to ${outputPath}.`);
    } catch (e) {
      logger.warn(`Could not write summary to ${summaryFile}: ${(e as Error).message}.`);
    }
  }
}

function resolveSummaryOutputPath(workspaceRoot: string, summaryFile: string): string {
  const targetPath = path.resolve(summaryFile);
  const rootPath = path.resolve(workspaceRoot);

  if (!isWithinRoot(rootPath, targetPath)) {
    throw new Error(`output path is outside workspace root '${rootPath}'`);
  }

  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      throw new Error('output path points to a directory');
    }
    const realTargetPath = fs.realpathSync(targetPath);
    const realRoot = fs.realpathSync(rootPath);
    if (!isWithinRoot(realRoot, realTargetPath)) {
      throw new Error(`output path resolves outside workspace root '${rootPath}'`);
    }
  }

  const targetDir = path.dirname(targetPath);
  if (fs.existsSync(targetDir)) {
    const realTargetDir = fs.realpathSync(targetDir);
    const realRoot = fs.realpathSync(rootPath);
    if (!isWithinRoot(realRoot, realTargetDir) && realTargetDir !== realRoot) {
      throw new Error(`output path resolves outside workspace root '${rootPath}'`);
    }
  }

  return targetPath;
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const rel = path.relative(rootPath, targetPath);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
