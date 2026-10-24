import * as fs from 'node:fs';
import type { Logger } from '../logger';
import type { PnpmCaptureRunner } from '../pnpm';
import { readBaselineSafeVersions } from '../audit/baselineSafeVersions';
import { parsePnpmAuditOutput, type PnpmAuditParseResult } from '../audit/pnpmAudit';
import { readCatalogSnapshot, summarizeAuditAdvisories } from '../summary/collect';
import { readAllOverrides } from '../workspaceOverrides';
import type { AdvisorySummary } from '../summary/types';
import type { WorkspaceState } from '../workspace';
import { WorkspaceReadError } from '../errors';
import { resolveWorkspacePackageDirs } from '../workspace/packageScope';
import {
  findWorkspacePackageManifests,
  formatForPath,
  readPackageManifest,
} from '../workspace/packageManifest';
import { reconcileAfterAuditRead } from './commands';

export interface InitialState {
  originalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  workspaceName: string | undefined;
  initialAdvisories: AdvisorySummary[];
  /**
   * Parsed pre-cleanup `pnpm audit --json` snapshot. Preserved separately
   * because the package.json ranged-dep bump needs the locked-minimum view:
   * for a dep declared as `^4.17.20` the fresh install resolves to the
   * latest-in-range (e.g. 4.17.21, safe), so the post-cleanup audit no
   * longer flags it. The pre-cleanup audit reflects the locked minimum and
   * lets us still raise the declared floor to the safe minimum.
   */
  preCleanupAudit: PnpmAuditParseResult | null;
  baselineSafeVersions: ReadonlyMap<string, string>;
  /** Original lockfile, workspace YAML, and in-scope package manifests for failure recovery. */
  controlFiles: ReadonlyMap<string, string | null>;
}

export async function captureInitialState(
  state: WorkspaceState,
  pnpm: PnpmCaptureRunner,
  logger: Logger,
  opts: { skipAudit: boolean; dryRun: boolean },
): Promise<InitialState> {
  // Capture the original state BEFORE any cleanup mutates files. Used by
  // the run-summary at the end.
  const controlFiles = captureWorkspaceControlFiles(state);
  const originalYaml = state.configuration.readEffectiveYaml();
  const originalPjText = state.paths.rootPackageManifest
    ? (controlFiles.get(state.paths.rootPackageManifest) ?? null)
    : null;
  const originalLockText = controlFiles.get(state.paths.lockFile) ?? null;
  const originalCatalog = readCatalogSnapshot(originalYaml);
  const originalOverrides = readAllOverrides(
    originalYaml,
    originalPjText,
    state.paths.rootPackageManifest ? formatForPath(state.paths.rootPackageManifest) : 'json',
  );
  const workspaceName = readPackageManifestName(
    originalPjText,
    state.paths.rootPackageManifest ? formatForPath(state.paths.rootPackageManifest) : 'json',
  );

  // Capture the TRUE initial vulnerability state — i.e. the audit result
  // with any existing overrides still applied. If we ran this after the
  // cleanup phase, every existing override would be stripped first and
  // its masked vulnerabilities would resurface, only to be "fixed" again
  // when audit-fix re-adds the same overrides. That would inflate the
  // "vulnerabilities fixed" count with non-changes.
  let initialAdvisories: AdvisorySummary[] = [];
  let preCleanupAudit: PnpmAuditParseResult | null = null;
  if (!opts.skipAudit && !opts.dryRun) {
    try {
      const { stdout } = await pnpm.capture(['audit', '--json']);
      reconcileAfterAuditRead(state, logger);
      const snapshot = parsePnpmAuditOutput(stdout);
      // Retain only a valid audit snapshot. pnpm returns {"error":{...}} when
      // there is no lockfile yet; it must not shadow the post-install audit
      // that `runAuditPhase` uses for package.json bump planning.
      if (snapshot.complete) {
        preCleanupAudit = snapshot;
        initialAdvisories = summarizeAuditAdvisories(snapshot.audit);
      }
    } catch (err) {
      // Best-effort: a missing lockfile or other audit failure leaves the
      // initial set empty rather than aborting the whole run (REQ-CORE-009).
      logger.warn(
        `Pre-cleanup audit failed: ${err instanceof Error ? err.message : String(err)}. Continuing with empty advisory baseline.`,
      );
    }
  }

  return {
    originalCatalog,
    originalOverrides,
    workspaceName,
    initialAdvisories,
    preCleanupAudit,
    baselineSafeVersions: readBaselineSafeVersions(originalLockText, preCleanupAudit),
    controlFiles,
  };
}

function captureWorkspaceControlFiles(state: WorkspaceState): ReadonlyMap<string, string | null> {
  const manifests = new Set(
    state.paths.rootPackageManifest ? [state.paths.rootPackageManifest] : [],
  );
  if (state.isMultiPackageWorkspace) {
    const packageDirs = resolveWorkspacePackageDirs({
      paths: state.paths,
      yaml: state.configuration,
    });
    for (const manifest of findWorkspacePackageManifests(state.paths.workspaceRoot, packageDirs)) {
      manifests.add(manifest.path);
    }
  }

  const configPaths = state.configuration.getSnapshots().map((snapshot) => snapshot.path);
  const paths = new Set([...configPaths, state.paths.lockFile, ...manifests]);
  const snapshot = new Map<string, string | null>();
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) {
      snapshot.set(filePath, null);
      continue;
    }
    try {
      snapshot.set(filePath, fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new WorkspaceReadError(filePath, error);
    }
  }
  return snapshot;
}
function readPackageManifestName(
  text: string | null,
  format: ReturnType<typeof formatForPath>,
): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = readPackageManifest(text, format) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
