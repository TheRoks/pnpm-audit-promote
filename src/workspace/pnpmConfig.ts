import * as fs from 'node:fs';
import { formatForPath, readPackageManifest } from './packageManifest';
import { parse as parseYaml } from 'yaml';
import { resolvePnpmCapabilities, type PnpmCapabilities } from '../pnpmCapabilities';

export interface WorkspacePnpmPin {
  major: number | null;
  version: string | null;
}

/** Read the target workspace's pnpm pin once and return both normalized forms. */
export function readWorkspacePnpmPin(pkgJsonPath: string): WorkspacePnpmPin {
  let parsed: { packageManager?: unknown; devEngines?: unknown };
  try {
    parsed = readPackageManifest(
      fs.readFileSync(pkgJsonPath, 'utf8'),
      formatForPath(pkgJsonPath),
    ) as typeof parsed;
  } catch {
    return { major: null, version: null };
  }
  return {
    major:
      extractMajorFromPackageManager(parsed.packageManager) ??
      extractMajorFromDevEngines(parsed.devEngines),
    version:
      extractFullVersionFromPackageManager(parsed.packageManager) ??
      extractFullVersionFromDevEngines(parsed.devEngines),
  };
}

export function detectWorkspacePnpmMajor(pkgJsonPath: string): number | null {
  return readWorkspacePnpmPin(pkgJsonPath).major;
}

/** Detect an exact pnpm major.minor.patch from the target package.json. */
export function detectWorkspacePnpmVersion(pkgJsonPath: string): string | null {
  return readWorkspacePnpmPin(pkgJsonPath).version;
}

function extractFullVersionFromPackageManager(pm: unknown): string | null {
  if (typeof pm !== 'string') return null;
  const match = /^pnpm@v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/i.exec(pm.trim());
  return match?.[1] ?? null;
}

function extractFullVersionFromDevEngines(devEngines: unknown): string | null {
  if (devEngines === null || typeof devEngines !== 'object') return null;
  return extractFullVersionFromDevEnginesEntry(
    (devEngines as { packageManager?: unknown }).packageManager,
  );
}

function extractFullVersionFromDevEnginesEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return extractFullVersionFromPackageManager(entry);
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const version = extractFullVersionFromDevEnginesEntry(item);
      if (version) return version;
    }
    return null;
  }
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as { name?: unknown; version?: unknown };
    if (typeof obj.name !== 'string' || obj.name.trim().toLowerCase() !== 'pnpm') return null;
    if (typeof obj.version !== 'string') return null;
    return (
      /^(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(obj.version.trim())?.[1] ?? null
    );
  }
  return null;
}

function extractMajorFromPackageManager(pm: unknown): number | null {
  if (typeof pm !== 'string') return null;
  const trimmed = pm.trim();
  // Accept `pnpm@10.33.0`, `pnpm@v11.0.0`, `pnpm@11`, and
  // `pnpm@11.0.0+sha512-...` —
  // corepack/pnpm allow an optional `+<integrity>` suffix after the version.
  const match = /^pnpm@v?(\d+)(?:[.\s+]|$)/i.exec(trimmed);
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  return Number.isFinite(major) ? major : null;
}

function extractMajorFromDevEngines(devEngines: unknown): number | null {
  if (devEngines === null || typeof devEngines !== 'object') return null;
  const pm = (devEngines as { packageManager?: unknown }).packageManager;
  return extractMajorFromDevEnginesEntry(pm);
}

function extractMajorFromDevEnginesEntry(entry: unknown): number | null {
  if (typeof entry === 'string') {
    // Same shape as the legacy `packageManager` field (e.g. `pnpm@11`,
    // `pnpm@^11.0.0`). Reuse the parser; range operators before the digits
    // are not produced by `pnpm init` for the string form, so a strict
    // `pnpm@<digits>.` match here is sufficient — but we relax it to also
    // accept a bare `pnpm@11` (no trailing dot) since users do write that.
    const trimmed = entry.trim();
    const m = /^pnpm@v?(\d+)(?:[.\s]|$)/i.exec(trimmed);
    if (!m) return null;
    const major = Number.parseInt(m[1]!, 10);
    return Number.isFinite(major) ? major : null;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const v = extractMajorFromDevEnginesEntry(item);
      if (v !== null) return v;
    }
    return null;
  }
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as { name?: unknown; version?: unknown };
    if (typeof obj.name !== 'string' || obj.name.trim().toLowerCase() !== 'pnpm') return null;
    if (typeof obj.version !== 'string') return null;
    // Strip optional range operators (`^`, `~`, `>=`, etc.) before parsing
    // the major. `>=11.0.0` and `^11` both resolve to 11.
    const match = /v?(\d+)\b/.exec(obj.version);
    if (!match) return null;
    const major = Number.parseInt(match[1]!, 10);
    return Number.isFinite(major) ? major : null;
  }
  return null;
}
export function readAuditIgnoreList(
  yamlContent: string,
  pnpmTarget?: string | null | PnpmCapabilities,
): Set<string> {
  if (!yamlContent.trim()) return new Set();
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return new Set();
  }
  if (parsed === null || typeof parsed !== 'object') return new Set();
  const root = parsed as Record<string, unknown>;
  const ids = new Set<string>();
  const audit = root['audit'];
  const capabilities = getPnpmCapabilities(pnpmTarget);
  if (capabilities.supportsCanonicalAuditConfig && audit !== null && typeof audit === 'object') {
    const canonical = audit as Record<string, unknown>;
    if ('ignore' in canonical) {
      addStringIds(ids, canonical['ignore']);
      return ids;
    }
  }

  const auditConfig = root['auditConfig'];
  if (auditConfig === null || typeof auditConfig !== 'object') return ids;
  const cfg = auditConfig as Record<string, unknown>;
  const legacyKeys = capabilities.supportsLegacyIgnoreCves
    ? ['ignoreGhsas', 'ignoreCves']
    : ['ignoreGhsas'];
  for (const key of legacyKeys) addStringIds(ids, cfg[key]);
  return ids;
}

function addStringIds(ids: Set<string>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const id of list) {
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
}

/**
 * Parse the target pnpm version's audit threshold from `pnpm-workspace.yaml`.
 * Returns `audit.level` when supported, otherwise the legacy `auditLevel`.
 */
export function readAuditLevel(
  yamlContent: string,
  pnpmTarget?: string | null | PnpmCapabilities,
): string | null {
  if (!yamlContent.trim()) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const audit = root['audit'];
  const capabilities = getPnpmCapabilities(pnpmTarget);
  if (capabilities.supportsCanonicalAuditConfig && audit !== null && typeof audit === 'object') {
    const canonicalLevel = (audit as Record<string, unknown>)['level'];
    if (typeof canonicalLevel === 'string') return canonicalLevel;
  }
  const level = root['auditLevel'];
  return typeof level === 'string' ? level : null;
}

function getPnpmCapabilities(target?: string | null | PnpmCapabilities): PnpmCapabilities {
  return typeof target === 'object' && target !== null
    ? target
    : resolvePnpmCapabilities(target ?? null);
}

/** Parse whether pnpm's install-time auto-dedupe is enabled in workspace YAML. */
export function readAutoDedupe(yamlContent: string): boolean {
  if (!yamlContent.trim()) return false;
  try {
    const parsed: unknown = parseYaml(yamlContent);
    if (parsed === null || typeof parsed !== 'object') return false;
    return (parsed as Record<string, unknown>)['autoDedupe'] === true;
  } catch {
    return false;
  }
}
