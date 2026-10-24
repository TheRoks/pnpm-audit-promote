import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logger';
import { mergeApprovedBuildSettings, preservePrunedAuditIgnore } from '../workspaceYaml';
import type { PnpmCapabilities } from '../pnpmCapabilities';
import { WorkspaceReadError } from '../errors';
import { restoreMinimumReleaseAgeExclude } from '../releaseAgeExclude';
import { WorkspaceMutations } from './mutations';

/** Owns the original and desired workspace YAML during one refresh run. */
export class WorkspaceYamlSnapshot {
  readonly path: string;
  readonly mutations: WorkspaceMutations;
  hasWorkspaceYaml = false;
  desiredWorkspaceYaml = '';
  yamlEol: '\r\n' | '\n' = '\n';
  originalWorkspaceYaml = '';

  constructor(path: string, mutations = new WorkspaceMutations(pathFromWorkspaceYaml(path))) {
    this.path = path;
    this.mutations = mutations;
  }

  get dryRun(): boolean {
    return this.mutations.dryRun;
  }

  set dryRun(value: boolean) {
    this.mutations.dryRun = value;
  }

  initialize(hasWorkspaceYaml: boolean, dryRun: boolean): void {
    this.hasWorkspaceYaml = hasWorkspaceYaml;
    this.dryRun = dryRun;
    if (!hasWorkspaceYaml) return;
    this.detectEol();
    this.desiredWorkspaceYaml = this.readWorkspaceYaml();
    this.originalWorkspaceYaml = this.desiredWorkspaceYaml;
  }

  detectEol(): void {
    try {
      const content = fs.readFileSync(this.path, 'utf8');
      this.yamlEol = content.includes('\r\n') ? '\r\n' : '\n';
    } catch {
      // Keep the default line ending when the file is unavailable.
    }
  }

  readWorkspaceYaml(): string {
    if (!this.hasWorkspaceYaml) return '';
    try {
      return fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new WorkspaceReadError(this.path, error);
    }
  }

  saveWorkspaceYaml(content: string): void {
    if (this.dryRun || !this.hasWorkspaceYaml) return;
    this.mutations.writeTextFile(this.path, content);
  }

  /** Update the in-memory target after adopting an external YAML edit. */
  adoptDesiredWorkspaceYaml(content: string): void {
    this.desiredWorkspaceYaml = content;
  }

  /** Update the target and persist it together, honoring dry-run mode. */
  writeDesiredWorkspaceYaml(content: string): void {
    this.desiredWorkspaceYaml = content;
    this.saveWorkspaceYaml(content);
  }

  removeWorkspaceYaml(): void {
    if (!this.dryRun && this.hasWorkspaceYaml) {
      try {
        this.mutations.removeFileSync(this.path);
      } catch {
        // Best-effort removal matches pnpm-created empty YAML cleanup behavior.
      }
    }
    this.hasWorkspaceYaml = false;
    this.desiredWorkspaceYaml = '';
  }

  /** Adopt a workspace YAML file that pnpm created during the run. */
  refreshHasWorkspaceYaml(): boolean {
    if (this.hasWorkspaceYaml || !fs.existsSync(this.path)) return false;
    this.hasWorkspaceYaml = true;
    this.detectEol();
    // There was no user-authored file at run start, so retain an empty baseline.
    this.originalWorkspaceYaml = '';
    this.desiredWorkspaceYaml = fs.readFileSync(this.path, 'utf8');
    return true;
  }

  resetMinimumReleaseAgeExclude(logger: Logger): void {
    if (!this.hasWorkspaceYaml) return;
    const current = this.readWorkspaceYaml();
    const next = restoreMinimumReleaseAgeExclude(current, this.originalWorkspaceYaml);
    if (next === current) return;
    this.writeDesiredWorkspaceYaml(next);
    logger.detail('Discarded `minimumReleaseAgeExclude` entries written by pnpm audit --fix.');
  }

  preserveAuditIgnorePrune(capabilities: PnpmCapabilities, logger: Logger): void {
    if (!capabilities.supportsAuditIgnorePrune || !this.hasWorkspaceYaml) return;
    const current = this.readWorkspaceYaml();
    const updated = preservePrunedAuditIgnore(this.desiredWorkspaceYaml, current);
    if (updated === this.desiredWorkspaceYaml) return;
    this.adoptDesiredWorkspaceYaml(updated);
    logger.detail('Preserved pnpm 12 pruning of stale `audit.ignore` entries.');
  }

  preserveApprovedBuilds(logger: Logger): boolean {
    if (!this.hasWorkspaceYaml) return false;
    const updated = mergeApprovedBuildSettings(this.desiredWorkspaceYaml, this.readWorkspaceYaml());
    if (updated === this.desiredWorkspaceYaml) return false;
    this.writeDesiredWorkspaceYaml(updated);
    logger.detail('Preserved build-script decisions recorded by pnpm approve-builds.');
    return true;
  }

  /** Restore the original workspace YAML while retaining explicit build approvals. */
  restoreInitialWorkspaceYaml(original: string | null, logger: Logger): void {
    let current: string | null = null;
    try {
      if (fs.existsSync(this.path)) current = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new WorkspaceReadError(this.path, error);
    }

    const content =
      current === null
        ? (original ?? '')
        : mergeApprovedBuildSettings(original ?? '', current, false);
    const shouldExist = original !== null || content.length > 0;
    if (shouldExist) {
      this.mutations.writeTextFile(this.path, content);
    } else {
      this.mutations.removeFileSync(this.path);
    }

    this.hasWorkspaceYaml = shouldExist;
    this.desiredWorkspaceYaml = shouldExist ? content : '';
    this.originalWorkspaceYaml = original ?? '';
    this.detectEol();
    logger.detail('Restored pnpm-workspace.yaml to its pre-run content.');
  }

  restoreWorkspaceYaml(logger: Logger): boolean {
    if (!this.hasWorkspaceYaml || !this.desiredWorkspaceYaml) return false;
    const current = this.readWorkspaceYaml();
    if (current === this.desiredWorkspaceYaml) return false;
    logger.detail('Restored pnpm-workspace.yaml after pnpm rewrote it.');
    this.writeDesiredWorkspaceYaml(this.desiredWorkspaceYaml);
    return true;
  }
}

function pathFromWorkspaceYaml(filePath: string): string {
  return path.dirname(filePath);
}
