import { describe, expect, it } from 'vitest';
import {
  EnclosingWorkspaceError,
  NonInteractiveConfirmationError,
  PnpmCommandFailedError,
  PnpmNotInstalledError,
  WorkspaceNotFoundError,
} from '../src/errors';

describe('typed error contract', () => {
  it('REQ-ERRORS-001: WorkspaceNotFoundError extends Error and carries workspaceRoot', () => {
    const err = new WorkspaceNotFoundError('/some/path');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkspaceNotFoundError);
    expect(err.name).toBe('WorkspaceNotFoundError');
    expect(err.workspaceRoot).toBe('/some/path');
    expect(err.message).toContain('/some/path');
    expect(err.message).toContain('--path');
  });

  it('REQ-ERRORS-002: EnclosingWorkspaceError extends Error and carries both paths', () => {
    const err = new EnclosingWorkspaceError('/child', '/parent');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EnclosingWorkspaceError);
    expect(err.name).toBe('EnclosingWorkspaceError');
    expect(err.requestedPath).toBe('/child');
    expect(err.enclosingWorkspaceRoot).toBe('/parent');
    expect(err.message).toContain('/child');
    expect(err.message).toContain('/parent');
    expect(err.message).toContain('--ignore-workspace');
  });

  it('REQ-ERRORS-003: PnpmNotInstalledError extends Error and has stable name + message', () => {
    const err = new PnpmNotInstalledError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PnpmNotInstalledError);
    expect(err.name).toBe('PnpmNotInstalledError');
    expect(err.message).toMatch(/pnpm is not installed/i);
  });

  it('REQ-ERRORS-004: PnpmCommandFailedError extends Error and exposes args + exitCode', () => {
    const err = new PnpmCommandFailedError(['install', '--frozen-lockfile'], 7);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PnpmCommandFailedError);
    expect(err.name).toBe('PnpmCommandFailedError');
    expect(err.args).toEqual(['install', '--frozen-lockfile']);
    expect(err.exitCode).toBe(7);
    expect(err.message).toContain('pnpm install --frozen-lockfile');
    expect(err.message).toContain('exit code 7');
  });

  it('REQ-ERRORS-005: NonInteractiveConfirmationError extends Error and has stable name + message', () => {
    const err = new NonInteractiveConfirmationError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NonInteractiveConfirmationError);
    expect(err.name).toBe('NonInteractiveConfirmationError');
    expect(err.message).toMatch(/non-interactively/i);
    expect(err.message).toContain('--force');
  });
});
