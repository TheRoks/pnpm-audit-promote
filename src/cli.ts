#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { refreshDeps } from './refresh';
import { createLogger, type LogLevel } from './logger';
import pkg from '../package.json' with { type: 'json' };

const { version: PKG_VERSION } = pkg;

interface CliOptions {
  path: string;
  force: boolean;
  yes?: boolean;
  dryRun: boolean;
  audit: boolean;
  dedupe: boolean;
  allowMajor: boolean;
  releaseAgeCheck: boolean;
  summary: boolean;
  summaryFile?: string;
  verbose: boolean;
  quiet: boolean;
  ignoreWorkspace: boolean;
}

const program = new Command();

program
  .name('pnpm-audit-promote')
  .description(
    'Refresh pnpm dependencies, run audit --fix, and promote catalog-eligible overrides back into the pnpm catalog.',
  )
  .version(PKG_VERSION)
  .option(
    '-p, --path <dir>',
    'Workspace root containing pnpm-workspace.yaml or a package.json with packageManager set to pnpm',
    process.cwd(),
  )
  .option('-f, --force', 'Skip the confirmation prompt before destructive deletes', false)
  .option('-y, --yes', 'Alias for --force')
  .option('-n, --dry-run', 'Plan and log changes without writing files or invoking pnpm', false)
  .option('--no-audit', 'Skip the pnpm audit and catalog promotion phase')
  .option('--no-dedupe', 'Skip pnpm dedupe calls')
  .option(
    '--no-allow-major',
    'Refuse catalog bumps that cross a major version boundary; leave the vulnerability for override handling. (Default is to allow them with a warning.)',
  )
  .option(
    '--no-release-age-check',
    "Skip the post-audit check that drops overrides pinning a version too fresh for the workspace's minimumReleaseAge gate. Use for fully offline runs.",
  )
  .option('--no-summary', 'Suppress the Markdown PR summary printed at the end of the run.')
  .option('--summary-file <path>', 'Also write the Markdown PR summary to the given file path.')
  .option(
    '-v, --verbose',
    'Verbose output (includes raw pnpm stdout/stderr and command tracing)',
    false,
  )
  .option('-q, --quiet', 'Quiet output (warnings + errors only)', false)
  .option(
    '--ignore-workspace',
    'Treat --path as the workspace root even when an enclosing pnpm-workspace.yaml exists in a parent. Forwards --ignore-workspace to every pnpm invocation so installs/overrides stay local.',
    false,
  )
  .action(async (opts: CliOptions) => {
    const level: LogLevel = opts.quiet ? 'quiet' : opts.verbose ? 'verbose' : 'normal';
    const logger = createLogger({ level });
    try {
      const workspacePath = path.resolve(opts.path);
      await refreshDeps({
        path: workspacePath,
        force: opts.force || Boolean(opts.yes),
        dryRun: opts.dryRun,
        skipAudit: !opts.audit,
        skipDedupe: !opts.dedupe,
        allowMajor: opts.allowMajor,
        releaseAgeCheck: opts.releaseAgeCheck,
        summary: opts.summary,
        summaryFile: normalizeSummaryFileOption(opts.summaryFile, workspacePath),
        ignoreWorkspace: opts.ignoreWorkspace,
        logger,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(pc.red(`Error: ${msg}`));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(pc.red(`Error: ${msg}`));
  process.exit(1);
});

function normalizeSummaryFileOption(
  summaryFile: string | undefined,
  workspacePath: string,
): string | undefined {
  if (summaryFile === undefined) return undefined;
  const trimmed = summaryFile.trim();
  if (!trimmed) {
    throw new Error('Invalid --summary-file value: path cannot be empty.');
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspacePath, trimmed);
}
