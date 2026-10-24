import { consoleLogger, type Logger } from '../logger';
import { WorkspaceState } from '../workspace';
import { readWorkspacePnpmPin } from '../workspace/pnpmConfig';
import { createPnpmRunner, ensurePnpmAvailable, getPnpmMajor, type PnpmRunner } from '../pnpm';
import { createProgressLogger } from '../progress';
import type { RefreshOptions } from './types';

export interface PreparedRun {
  logger: Logger;
  progressLogger: ReturnType<typeof createProgressLogger>;
  state: WorkspaceState;
  pnpm: PnpmRunner;
  dryRun: boolean;
  skipAudit: boolean;
  startedAt: number;
}

export async function prepareRun(options: RefreshOptions): Promise<PreparedRun> {
  const logger = options.logger ?? consoleLogger;
  const dryRun = options.dryRun ?? false;
  const skipAudit = options.skipAudit ?? false;
  const startedAt = Date.now();

  const totalProgressSteps = skipAudit ? 6 : 11;
  const progressLogger = createProgressLogger(logger, totalProgressSteps);

  if (!options.pnpm && !dryRun) {
    await ensurePnpmAvailable();
  }
  const ignoreWorkspace = options.ignoreWorkspace ?? false;
  const state = WorkspaceState.initialize(options.path, {
    dryRun,
    ignoreParentWorkspace: ignoreWorkspace,
  });
  const pnpm =
    options.pnpm ??
    createPnpmRunner({
      cwd: state.paths.workspaceRoot,
      logger,
      inheritOutput: logger.isVerbose(),
      dryRun,
      extraArgs: ignoreWorkspace ? ['--ignore-workspace'] : [],
    });

  logger.info(`Workspace root: ${state.paths.workspaceRoot}${dryRun ? ' (dry-run)' : ''}`);
  if (ignoreWorkspace) {
    logger.info('Ignoring any enclosing pnpm workspace (--ignore-workspace).');
  }
  if (!state.yaml.hasWorkspaceYaml) {
    logger.info('No pnpm-workspace.yaml detected — catalog promotion steps will be skipped.');
  }
  if (!state.isMultiPackageWorkspace) {
    logger.info(
      'Single-package mode: cleanup and audit-driven bumps are confined to the workspace root.',
    );
  }

  // Detect the pnpm version of the *target* workspace. The CLI itself ships
  // pinned to a specific pnpm version (via its own `packageManager` field),
  // so `pnpm --version` on PATH reports the *CLI's* pnpm, not the version
  // that will actually execute commands inside `--path`. Corepack (and any
  // wrapper that respects `packageManager` / `devEngines.packageManager`)
  // selects the target's pin instead. We mirror that: read the workspace
  // package.json first. If the pin declares only a major (for example, a
  // semver range), resolve the exact target version through the runner when
  // its reported major agrees with the workspace pin. Failures degrade
  // gracefully — the run keeps the best-known capability profile.
  let major: number | null = null;
  let version: string | null = null;
  let source = 'unknown';
  try {
    const pin = readWorkspacePnpmPin(
      state.paths.rootPackageManifest ?? state.paths.rootPackageJson,
    );
    major = pin.major;
    version = pin.version;
    if (major !== null) source = 'workspace package.json';
  } catch {
    // ignore — fall through to PATH lookup
  }
  if (major === null || version === null) {
    try {
      const versionText = await pnpm.version();
      const resolvedMajor = getPnpmMajor(versionText);
      if (major === null || resolvedMajor === major) {
        major = resolvedMajor;
        version = versionText || null;
        source = versionText ? `pnpm --version (${versionText})` : 'pnpm --version';
      }
    } catch {
      // Keep the detected workspace-pin major and its fallback profile.
    }
  }
  state.recordPnpm(major, version);
  state.configuration.initialize(state.pnpmCapabilities);
  logger.detail(`Target workspace pnpm major: ${major ?? 'unknown'} (from ${source}).`);

  const auditFixMode = options.auditFixMode ?? 'override';
  if (auditFixMode !== 'override' && auditFixMode !== 'update') {
    throw new Error(
      `Invalid audit fix mode '${String(auditFixMode)}'; expected 'override' or 'update'.`,
    );
  }
  if (!skipAudit && auditFixMode === 'update' && !state.pnpmCapabilities.supportsAuditUpdate) {
    throw new Error('The audit fix mode "update" requires a detectable pnpm 11 or newer target.');
  }

  return { logger, progressLogger, state, pnpm, dryRun, skipAudit, startedAt };
}
