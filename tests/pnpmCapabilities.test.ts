import { describe, expect, it } from 'vitest';
import { getAuditFixArgs, resolvePnpmCapabilities } from '../src/pnpmCapabilities';

describe('resolvePnpmCapabilities', () => {
  it('REQ-PNPM-CAP-001: resolves pnpm 10 command and config behavior', () => {
    const capabilities = resolvePnpmCapabilities('10.33.0');

    expect(capabilities.auditFixRequiresExplicitMode).toBe(false);
    expect(capabilities.supportsAuditUpdate).toBe(false);
    expect(capabilities.supportsCanonicalAuditConfig).toBe(false);
    expect(capabilities.supportsLegacyIgnoreCves).toBe(true);
    expect(capabilities.supportsAuditIgnorePrune).toBe(false);
    expect(capabilities.supportsAutoDedupe).toBe(false);
    expect(capabilities.supportsWorkspaceSettingsInclude).toBe(false);
    expect(getAuditFixArgs(capabilities, 'override')).toEqual(['audit', '--fix']);
  });

  it('REQ-PNPM-CAP-002: recognizes the pnpm 11.16 canonical audit config threshold', () => {
    expect(resolvePnpmCapabilities('11.15.0').supportsCanonicalAuditConfig).toBe(false);
    expect(resolvePnpmCapabilities('11.16.0').supportsCanonicalAuditConfig).toBe(true);
    expect(getAuditFixArgs(resolvePnpmCapabilities('11.16.0'), 'update')).toEqual([
      'audit',
      '--fix',
      'update',
    ]);
  });

  it('REQ-PNPM-CAP-003: enables pnpm 12 workspace and dedupe features', () => {
    const capabilities = resolvePnpmCapabilities('12.0.0');

    expect(capabilities.supportsCanonicalAuditConfig).toBe(true);
    expect(capabilities.supportsLegacyIgnoreCves).toBe(false);
    expect(capabilities.supportsAuditIgnorePrune).toBe(true);
    expect(capabilities.supportsAutoDedupe).toBe(true);
    expect(capabilities.supportsWorkspaceSettingsInclude).toBe(false);
    expect(resolvePnpmCapabilities('12.14.9').supportsWorkspaceSettingsInclude).toBe(false);
    expect(resolvePnpmCapabilities('12.15.0').supportsWorkspaceSettingsInclude).toBe(true);
    expect(resolvePnpmCapabilities('12.16.0').supportsWorkspaceSettingsInclude).toBe(true);
  });

  it('REQ-PNPM-CAP-004: keeps explicit best-effort fallbacks when the version is unknown', () => {
    const capabilities = resolvePnpmCapabilities(null);

    expect(capabilities.auditFixRequiresExplicitMode).toBe(false);
    expect(capabilities.supportsAuditUpdate).toBe(false);
    expect(capabilities.supportsCanonicalAuditConfig).toBe(true);
    expect(capabilities.supportsLegacyIgnoreCves).toBe(true);
    expect(capabilities.supportsAuditIgnorePrune).toBe(false);
    expect(capabilities.supportsAutoDedupe).toBe(false);
    expect(capabilities.supportsWorkspaceSettingsInclude).toBe(false);
  });

  it('REQ-PNPM-CAP-005: detects delegated workspace settings introduced in pnpm 12.15', () => {
    expect(resolvePnpmCapabilities('12.14.9').supportsWorkspaceSettingsInclude).toBe(false);
    expect(resolvePnpmCapabilities('12.15.0').supportsWorkspaceSettingsInclude).toBe(true);
    expect(resolvePnpmCapabilities('12.15.4').supportsWorkspaceSettingsInclude).toBe(true);
  });
});
