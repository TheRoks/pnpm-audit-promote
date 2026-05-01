#!/usr/bin/env node
import * as path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { refreshDeps } from './refresh.js';
import { createLogger, type LogLevel } from './logger.js';
import { PKG_VERSION } from './version.js';

interface CliOptions {
  path: string;
  force: boolean;
  yes?: boolean;
  dryRun: boolean;
  audit: boolean;
  dedupe: boolean;
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
  .option('-v, --verbose', 'Verbose output', false)
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
