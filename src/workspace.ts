import * as path from 'node:path';
import type { Logger } from './logger';
import { resolvePnpmCapabilities, type PnpmCapabilities } from './pnpmCapabilities';
import { discoverWorkspace } from './workspace/discovery';
import { WorkspaceMutations } from './workspace/mutations';
import { WorkspaceConfiguration } from './workspace/configuration';
import { findPackageManifest } from './workspace/packageManifest';
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

export interface WorkspacePaths {
  readonly workspaceRoot: string;
  readonly lockFile: string;
  readonly workspaceYaml: string;
  readonly rootPackageJson: string;
  readonly rootPackageManifest: string | null;
}

/**
 * Per-run workspace aggregate. Workspace identity and pnpm metadata live here;
 * the YAML snapshot owns file state and reconciliation behavior.
 */
export class WorkspaceState {
  readonly paths: WorkspacePaths;
  readonly mutations: WorkspaceMutations;
  readonly yaml: WorkspaceYamlSnapshot;
  readonly configuration: WorkspaceConfiguration;

  isMultiPackageWorkspace = false;
  pnpmMajor: number | null = null;
  pnpmVersion: string | null = null;
  pnpmCapabilities: PnpmCapabilities = resolvePnpmCapabilities(null);

  constructor(workspaceRoot: string) {
    const root = path.resolve(workspaceRoot);
    this.paths = Object.freeze({
      workspaceRoot: root,
      lockFile: path.join(root, 'pnpm-lock.yaml'),
      workspaceYaml: path.join(root, 'pnpm-workspace.yaml'),
      rootPackageJson: path.join(root, 'package.json'),
      rootPackageManifest: findPackageManifest(root)?.path ?? null,
    });
    this.mutations = new WorkspaceMutations(this.paths.workspaceRoot);
    this.yaml = new WorkspaceYamlSnapshot(this.paths.workspaceYaml, this.mutations);
    this.configuration = new WorkspaceConfiguration(
      this.paths.workspaceRoot,
      this.yaml,
      this.mutations,
    );
  }

  /** @deprecated Use the immutable `paths` value in internal code. */
  get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  /** @deprecated Use `paths.lockFile` in internal code. */
  get lockFile(): string {
    return this.paths.lockFile;
  }

  /** @deprecated Use `paths.workspaceYaml` in internal code. */
  get workspaceYaml(): string {
    return this.paths.workspaceYaml;
  }

  /** @deprecated Use `paths.rootPackageJson` in internal code. */
  get rootPackageJson(): string {
    return this.paths.rootPackageJson;
  }

  static initialize(
    workspacePath: string,
    options: { dryRun?: boolean; ignoreParentWorkspace?: boolean } = {},
  ): WorkspaceState {
    const identity = discoverWorkspace(workspacePath, {
      ignoreParentWorkspace: options.ignoreParentWorkspace,
    });
    const state = new WorkspaceState(identity.workspaceRoot);
    state.mutations.dryRun = options.dryRun ?? false;
    state.isMultiPackageWorkspace = identity.isMultiPackageWorkspace;
    state.yaml.initialize(identity.hasWorkspaceYaml, options.dryRun ?? false);
    return state;
  }

  /** @deprecated Use `yaml.hasWorkspaceYaml` in new integrations. */
  get hasWorkspaceYaml(): boolean {
    return this.yaml.hasWorkspaceYaml;
  }

  /** @deprecated Use `yaml.hasWorkspaceYaml` in new integrations. */
  set hasWorkspaceYaml(value: boolean) {
    this.yaml.hasWorkspaceYaml = value;
  }

  /** @deprecated Use `yaml.desiredWorkspaceYaml` in new integrations. */
  get desiredWorkspaceYaml(): string {
    return this.yaml.desiredWorkspaceYaml;
  }

  /** @deprecated Use `yaml.desiredWorkspaceYaml` in new integrations. */
  set desiredWorkspaceYaml(value: string) {
    this.yaml.desiredWorkspaceYaml = value;
  }

  /** @deprecated Use `yaml.yamlEol` in new integrations. */
  get yamlEol(): '\r\n' | '\n' {
    return this.yaml.yamlEol;
  }

  /** @deprecated Use `yaml.yamlEol` in new integrations. */
  set yamlEol(value: '\r\n' | '\n') {
    this.yaml.yamlEol = value;
  }

  /** @deprecated Use `yaml.dryRun` in new integrations. */
  get dryRun(): boolean {
    return this.yaml.dryRun;
  }

  /** @deprecated Use `yaml.dryRun` in new integrations. */
  set dryRun(value: boolean) {
    this.yaml.dryRun = value;
  }

  /** @deprecated Use `yaml.originalWorkspaceYaml` in new integrations. */
  get originalWorkspaceYaml(): string {
    return this.yaml.originalWorkspaceYaml;
  }

  /** @deprecated Use `yaml.originalWorkspaceYaml` in new integrations. */
  set originalWorkspaceYaml(value: string) {
    this.yaml.originalWorkspaceYaml = value;
  }

  recordPnpmMajor(major: number | null): void {
    this.pnpmMajor = major;
    this.pnpmCapabilities = resolvePnpmCapabilities(
      this.pnpmVersion ?? (major === null ? null : `${major}.0.0`),
    );
  }

  recordPnpmVersion(version: string | null): void {
    this.pnpmVersion = version;
    this.pnpmCapabilities = resolvePnpmCapabilities(
      version ?? (this.pnpmMajor === null ? null : `${this.pnpmMajor}.0.0`),
    );
  }

  recordPnpm(major: number | null, version: string | null): void {
    this.pnpmMajor = major;
    this.pnpmVersion = version;
    this.pnpmCapabilities = resolvePnpmCapabilities(
      version ?? (major === null ? null : `${major}.0.0`),
    );
  }

  /** @deprecated Use the matching `yaml` method in new integrations. */
  detectEol(): void {
    this.yaml.detectEol();
  }

  /** @deprecated Use `yaml.readWorkspaceYaml()` in new integrations. */
  readWorkspaceYaml(): string {
    return this.yaml.readWorkspaceYaml();
  }

  /** @deprecated Use `yaml.saveWorkspaceYaml()` in new integrations. */
  saveWorkspaceYaml(content: string): void {
    this.yaml.saveWorkspaceYaml(content);
  }

  /** @deprecated Use `yaml.refreshHasWorkspaceYaml()` in new integrations. */
  refreshHasWorkspaceYaml(): boolean {
    return this.yaml.refreshHasWorkspaceYaml();
  }

  /** @deprecated Use `yaml.resetMinimumReleaseAgeExclude()` in new integrations. */
  resetMinimumReleaseAgeExclude(logger: Logger): void {
    this.yaml.resetMinimumReleaseAgeExclude(logger);
  }

  /** @deprecated Use `yaml.preserveAuditIgnorePrune()` in new integrations. */
  preserveAuditIgnorePrune(logger: Logger): void {
    this.yaml.preserveAuditIgnorePrune(this.pnpmCapabilities, logger);
  }

  /** @deprecated Use `yaml.preserveApprovedBuilds()` in new integrations. */
  preserveApprovedBuilds(logger: Logger): boolean {
    return this.yaml.preserveApprovedBuilds(logger);
  }

  /** @deprecated Use `yaml.restoreWorkspaceYaml()` in new integrations. */
  restoreWorkspaceYaml(logger: Logger): boolean {
    return this.yaml.restoreWorkspaceYaml(logger);
  }
}
