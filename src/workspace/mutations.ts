import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Owns program-initiated workspace writes and removals for one refresh run. */
export class WorkspaceMutations {
  readonly root: string;
  dryRun: boolean;
  private readonly explicitlyIncludedFiles = new Set<string>();

  constructor(root: string, dryRun = false) {
    this.root = path.resolve(root);
    this.dryRun = dryRun;
  }

  /** Authorize one literal path named by the workspace's pnpm `include` map. */
  authorizeIncludedFile(target: string): void {
    const resolved = path.resolve(target);
    this.explicitlyIncludedFiles.add(resolved);
    try {
      this.explicitlyIncludedFiles.add(fs.realpathSync(resolved));
    } catch {
      // The caller validates that the included file exists before mutation.
    }
  }

  writeTextFile(target: string, content: string): boolean {
    const resolved = this.resolveTarget(target);
    if (this.dryRun) return false;

    if (fs.existsSync(resolved) && fs.readFileSync(resolved, 'utf8') === content) return false;

    const temporary = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let mode: number | undefined;
    try {
      if (fs.existsSync(resolved)) mode = fs.statSync(resolved).mode & 0o777;
      fs.writeFileSync(temporary, content, { encoding: 'utf8', mode });
      fs.renameSync(temporary, resolved);
      return true;
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }

  removeFileSync(target: string): boolean {
    const resolved = this.resolveTarget(target);
    if (this.dryRun || !fs.existsSync(resolved)) return false;
    fs.rmSync(resolved, { force: true });
    return true;
  }

  async removeDirectory(
    target: string,
    beforeRemove?: (resolvedTarget: string) => Promise<void>,
  ): Promise<boolean> {
    const resolved = this.resolveTarget(target);
    if (this.dryRun || !fs.existsSync(resolved)) return false;
    if (beforeRemove) await beforeRemove(resolved);
    if (fs.existsSync(resolved)) {
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
    return !fs.existsSync(resolved);
  }

  private resolveTarget(target: string): string {
    const requested = path.resolve(target);
    let resolved = requested;
    try {
      if (fs.lstatSync(requested).isSymbolicLink()) resolved = fs.realpathSync(requested);
    } catch {
      // Missing files are validated using their nearest existing parent below.
    }
    const relative = path.relative(this.root, resolved);
    const explicitlyIncluded =
      this.explicitlyIncludedFiles.has(requested) || this.explicitlyIncludedFiles.has(resolved);
    if (
      !explicitlyIncluded &&
      (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    ) {
      throw new Error(
        `Refusing to mutate '${resolved}': path is not contained within workspace root '${this.root}'.`,
      );
    }

    const realRoot = fs.realpathSync(this.root);
    let existingParent = path.dirname(resolved);
    while (!fs.existsSync(existingParent)) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) break;
      existingParent = parent;
    }
    const realParent = fs.realpathSync(existingParent);
    const realRelative = path.relative(realRoot, realParent);
    if (!explicitlyIncluded && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
      throw new Error(
        `Refusing to mutate '${resolved}': its parent resolves outside workspace root '${this.root}'.`,
      );
    }
    return resolved;
  }
}
