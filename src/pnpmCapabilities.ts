import semver from 'semver';

/** Target pnpm features resolved once from the selected workspace version. */
export interface PnpmCapabilities {
  readonly version: string | null;
  readonly major: number | null;
  readonly minor: number | null;
  readonly auditFixRequiresExplicitMode: boolean;
  readonly supportsAuditUpdate: boolean;
  readonly supportsCanonicalAuditConfig: boolean;
  readonly supportsLegacyIgnoreCves: boolean;
  readonly supportsAuditIgnorePrune: boolean;
  readonly supportsAutoDedupe: boolean;
  readonly supportsWorkspaceSettingsInclude: boolean;
}

/** Resolve pnpm's version-dependent behavior once for the current run. */
export function resolvePnpmCapabilities(version: string | null): PnpmCapabilities {
  const parsed = version ? semver.parse(version) : null;
  const major = parsed?.major ?? null;
  const minor = parsed?.minor ?? null;
  const patch = parsed?.patch ?? null;

  return {
    version,
    major,
    minor,
    auditFixRequiresExplicitMode: major !== null && major >= 11,
    supportsAuditUpdate: major !== null && major >= 11,
    // Unknown versions retain the previous best-effort canonical-config behavior.
    supportsCanonicalAuditConfig:
      major === null || major >= 12 || (major === 11 && (minor ?? 0) >= 16),
    supportsLegacyIgnoreCves: major === null || major < 12,
    supportsAuditIgnorePrune: major !== null && major >= 12,
    supportsAutoDedupe: major !== null && major >= 12,
    supportsWorkspaceSettingsInclude:
      major !== null && (major > 12 || (major === 12 && (minor ?? 0) >= 15)) && patch !== null,
  };
}

/** Keep target-workspace pnpm 10/11/12 command syntax in one place. */
export function getAuditFixArgs(
  capabilities: PnpmCapabilities,
  mode: 'override' | 'update',
): string[] {
  return capabilities.auditFixRequiresExplicitMode ? ['audit', '--fix', mode] : ['audit', '--fix'];
}
