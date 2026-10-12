import * as fs from 'node:fs';
import { parseDocument } from 'yaml';
import type { Logger } from '../logger';
import { preservePrunedAuditIgnore } from '../workspaceYaml';
import { WorkspaceReadError } from '../errors';
import { restoreMinimumReleaseAgeExclude } from '../releaseAgeExclude';

/** Owns the original and desired workspace YAML during one refresh run. */
export class WorkspaceYamlSnapshot {
  readonly path: string;
  hasWorkspaceYaml = false;
  desiredWorkspaceYaml = '';
  yamlEol: '\r\n' | '\n' = '\n';
  dryRun = false;
  originalWorkspaceYaml = '';

  constructor(path: string) {
    this.path = path;
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
    fs.writeFileSync(this.path, content, 'utf8');
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
        fs.rmSync(this.path, { force: true });
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

  preserveAuditIgnorePrune(pnpmMajor: number | null, logger: Logger): void {
    if ((pnpmMajor ?? 0) < 12 || !this.hasWorkspaceYaml) return;
    const current = this.readWorkspaceYaml();
    const updated = preservePrunedAuditIgnore(this.desiredWorkspaceYaml, current);
    if (updated === this.desiredWorkspaceYaml) return;
    this.adoptDesiredWorkspaceYaml(updated);
    logger.detail('Preserved pnpm 12 pruning of stale `audit.ignore` entries.');
  }

  preserveApprovedBuilds(logger: Logger): boolean {
    if (!this.hasWorkspaceYaml) return false;
    const actual = parseDocument(this.readWorkspaceYaml());
    const desired = parseDocument(this.desiredWorkspaceYaml);
    if (actual.errors.length > 0 || desired.errors.length > 0) return false;

    let changed = false;
    for (const key of [
      'allowBuilds',
      'permissions',
      'onlyBuiltDependencies',
      'ignoredBuiltDependencies',
      'neverBuiltDependencies',
    ]) {
      const current = actual.get(key);
      if (JSON.stringify(current) === JSON.stringify(desired.get(key))) continue;
      if (actual.has(key)) desired.set(key, current);
      else desired.delete(key);
      changed = true;
    }
    if (!changed) return false;
    this.writeDesiredWorkspaceYaml(desired.toString().replace(/\n/g, this.yamlEol));
    logger.detail('Preserved build-script decisions recorded by pnpm approve-builds.');
    return true;
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
