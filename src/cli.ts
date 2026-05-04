#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { refreshDeps } from './refresh.js';
import { createLogger, type LogLevel } from './logger.js';
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
  summary: boolean;
  summaryFile?: string;
  verbose: boolean;
  quiet: boolean;
}

const program = new Command();

program
  .name('pnpm-audit-promote')
  .description(
    'Refresh pnpm dependencies, run audit --fix, and promote catalog-eligible overrides back into the pnpm catalog.',
  )
  .version(PKG_VERSION)
  .option('-p, --path <dir>', 'Workspace root containing pnpm-workspace.yaml', process.cwd())
  .option('-f, --force', 'Skip the confirmation prompt before destructive deletes', false)
  .option('-y, --yes', 'Alias for --force')
  .option('-n, --dry-run', 'Plan and log changes without writing files or invoking pnpm', false)
  .option('--no-audit', 'Skip the pnpm audit and catalog promotion phase')
  .option('--no-dedupe', 'Skip pnpm dedupe calls')
  .option(
    '--allow-major',
    'Allow catalog bumps that cross a major version boundary (still logged as warnings). Use --no-allow-major to skip them.',
    true,
  )
  .option('--no-summary', 'Suppress the Markdown PR summary printed at the end of the run.')
  .option('--summary-file <path>', 'Also write the Markdown PR summary to the given file path.')
  .option(
    '-v, --verbose',
    'Verbose output (includes raw pnpm stdout/stderr and command tracing)',
    false,
  )
  .option('-q, --quiet', 'Quiet output (warnings + errors only)', false)
  .action(async (opts: CliOptions) => {
    const level: LogLevel = opts.quiet ? 'quiet' : opts.verbose ? 'verbose' : 'normal';
    const logger = createLogger({ level });
    try {
      await refreshDeps({
        path: path.resolve(opts.path),
        force: opts.force || Boolean(opts.yes),
        dryRun: opts.dryRun,
        skipAudit: !opts.audit,
        skipDedupe: !opts.dedupe,
        allowMajor: opts.allowMajor,
        summary: opts.summary,
        summaryFile: opts.summaryFile,
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
