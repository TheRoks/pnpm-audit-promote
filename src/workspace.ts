import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './logger.js';

/**
 * Mutable per-run workspace state, populated once and read by helper modules.
 */
export class WorkspaceState {
  readonly workspaceRoot: string;
  readonly lockFile: string;
  readonly workspaceYaml: string;
  readonly rootPackageJson: string;

  /**
   * Snapshot of the *desired* pnpm-workspace.yaml content. Re-applied after
   * every pnpm command, because pnpm 10 normalizes the file on install/up
   * and silently drops settings (e.g. `savePrefix: ''`) and bumps catalog
   * versions.
   */
  desiredWorkspaceYaml = '';

  /** Dominant EOL used by pnpm-workspace.yaml — preserved across rewrites. */
  yamlEol: '\r\n' | '\n' = '\n';

  /** When true, `saveWorkspaceYaml` and writes are no-ops. */
  dryRun = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.lockFile = path.join(workspaceRoot, 'pnpm-lock.yaml');
    this.workspaceYaml = path.join(workspaceRoot, 'pnpm-workspace.yaml');
    this.rootPackageJson = path.join(workspaceRoot, 'package.json');
  }

  static initialize(workspacePath: string, options: { dryRun?: boolean } = {}): WorkspaceState {
    const root = path.resolve(workspacePath);
    const ws = new WorkspaceState(root);
    if (!fs.existsSync(ws.workspaceYaml)) {
      throw new Error(
        `pnpm-workspace.yaml not found at '${ws.workspaceYaml}'. Pass --path <workspace root>.`,
      );
    }
    ws.dryRun = options.dryRun ?? false;
    ws.detectEol();
    // Initialize the desired snapshot from the current file so that
    // `restoreWorkspaceYaml` is safe before any cleanup step has run.
    ws.desiredWorkspaceYaml = ws.readWorkspaceYaml();
    return ws;
  }

  detectEol(): void {
    try {
      const content = fs.readFileSync(this.workspaceYaml, 'utf8');
      this.yamlEol = content.includes('\r\n') ? '\r\n' : '\n';
    } catch {
      // keep default
    }
  }

  readWorkspaceYaml(): string {
    return fs.readFileSync(this.workspaceYaml, 'utf8');
  }

  saveWorkspaceYaml(content: string): void {
    if (this.dryRun) return;
    fs.writeFileSync(this.workspaceYaml, content, 'utf8');
  }

  /**
   * If pnpm has rewritten pnpm-workspace.yaml since our last snapshot,
   * restore the desired content. Returns true when a restore happened.
   */
  restoreWorkspaceYaml(logger: Logger): boolean {
    if (!this.desiredWorkspaceYaml) return false;
    const current = this.readWorkspaceYaml();
    if (current !== this.desiredWorkspaceYaml) {
      logger.detail('Restoring pnpm-workspace.yaml (pnpm modified it)');
      this.saveWorkspaceYaml(this.desiredWorkspaceYaml);
      return true;
    }
    return false;
  }
}
