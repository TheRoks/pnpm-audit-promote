import * as path from 'node:path';
import type { Logger } from './logger';
import { discoverWorkspace } from './workspace/discovery';
import { WorkspaceYamlSnapshot } from './workspace/yamlSnapshot';

export { findEnclosingPnpmWorkspaceYaml, discoverWorkspace } from './workspace/discovery';
export {
  detectWorkspacePnpmMajor,
  detectWorkspacePnpmVersion,
  readWorkspacePnpmPin,
  readAuditIgnoreList,
  readAuditLevel,
  readAutoDedupe,
} from './workspace/pnpmConfig';
export { resolveWorkspacePackageDirs } from './workspace/packageScope';
export type { WorkspaceIdentity } from './workspace/discovery';
export type { WorkspacePackageScopeSource } from './workspace/packageScope';

/**
 * Per-run workspace aggregate. Workspace identity and pnpm metadata live here;
 * the YAML snapshot owns file state and reconciliation behavior.
 */
export class WorkspaceState {
  readonly workspaceRoot: string;
  readonly lockFile: string;
  readonly workspaceYaml: string;
  readonly rootPackageJson: string;
  readonly yaml: WorkspaceYamlSnapshot;

  isMultiPackageWorkspace = false;
  pnpmMajor: number | null = null;
  pnpmVersion: string | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.lockFile = path.join(this.workspaceRoot, 'pnpm-lock.yaml');
    this.workspaceYaml = path.join(this.workspaceRoot, 'pnpm-workspace.yaml');
    this.rootPackageJson = path.join(this.workspaceRoot, 'package.json');
    this.yaml = new WorkspaceYamlSnapshot(this.workspaceYaml);
  }

  static initialize(
    workspacePath: string,
    options: { dryRun?: boolean; ignoreParentWorkspace?: boolean } = {},
  ): WorkspaceState {
    const identity = discoverWorkspace(workspacePath, {
      ignoreParentWorkspace: options.ignoreParentWorkspace,
    });
    const state = new WorkspaceState(identity.workspaceRoot);
    state.isMultiPackageWorkspace = identity.isMultiPackageWorkspace;
    state.yaml.initialize(identity.hasWorkspaceYaml, options.dryRun ?? false);
    return state;
  }

  get hasWorkspaceYaml(): boolean {
    return this.yaml.hasWorkspaceYaml;
  }

  set hasWorkspaceYaml(value: boolean) {
    this.yaml.hasWorkspaceYaml = value;
  }

  get desiredWorkspaceYaml(): string {
    return this.yaml.desiredWorkspaceYaml;
  }

  set desiredWorkspaceYaml(value: string) {
    this.yaml.desiredWorkspaceYaml = value;
  }

  get yamlEol(): '\r\n' | '\n' {
    return this.yaml.yamlEol;
  }

  set yamlEol(value: '\r\n' | '\n') {
    this.yaml.yamlEol = value;
  }

  get dryRun(): boolean {
    return this.yaml.dryRun;
  }

  set dryRun(value: boolean) {
    this.yaml.dryRun = value;
  }

  get originalWorkspaceYaml(): string {
    return this.yaml.originalWorkspaceYaml;
  }

  set originalWorkspaceYaml(value: string) {
    this.yaml.originalWorkspaceYaml = value;
  }

  recordPnpmMajor(major: number | null): void {
    this.pnpmMajor = major;
  }

  recordPnpmVersion(version: string | null): void {
    this.pnpmVersion = version;
  }

  detectEol(): void {
    this.yaml.detectEol();
  }

  readWorkspaceYaml(): string {
    return this.yaml.readWorkspaceYaml();
  }

  saveWorkspaceYaml(content: string): void {
    this.yaml.saveWorkspaceYaml(content);
  }

  refreshHasWorkspaceYaml(): boolean {
    return this.yaml.refreshHasWorkspaceYaml();
  }

  resetMinimumReleaseAgeExclude(logger: Logger): void {
    this.yaml.resetMinimumReleaseAgeExclude(logger);
  }

  preserveAuditIgnorePrune(logger: Logger): void {
    this.yaml.preserveAuditIgnorePrune(this.pnpmMajor, logger);
  }

  preserveApprovedBuilds(logger: Logger): boolean {
    return this.yaml.preserveApprovedBuilds(logger);
  }

  restoreWorkspaceYaml(logger: Logger): boolean {
    return this.yaml.restoreWorkspaceYaml(logger);
  }
}
