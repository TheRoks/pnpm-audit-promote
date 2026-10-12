import semver from 'semver';
import { parseAllDocuments } from 'yaml';
import { parsePnpmAuditOutput, type PnpmAuditParseResult } from './pnpmAudit';

/**
 * Read versions that were already present and not flagged by the initial
 * audit. An audit-generated override must not replace one of these with an
 * older patched minimum and introduce a vulnerable dependency subtree.
 */
export function readBaselineSafeVersions(
  lockfileYaml: string | null,
  auditInput: string | PnpmAuditParseResult | null,
): ReadonlyMap<string, string> {
  if (!lockfileYaml) return new Map();
  let lockfile: unknown;
  try {
    lockfile = readLockfileDocument(lockfileYaml);
  } catch {
    return new Map();
  }
  if (!isRecord(lockfile) || !isRecord(lockfile['packages'])) return new Map();
  const audit = typeof auditInput === 'string' ? parsePnpmAuditOutput(auditInput) : auditInput;
  if (!audit?.complete) return new Map();

  const vulnerable = new Map<string, Set<string>>();
  for (const advisory of Object.values(audit.audit.advisories)) {
    if (!advisory.module_name || !advisory.findings) continue;
    const versions = vulnerable.get(advisory.module_name) ?? new Set<string>();
    for (const finding of advisory.findings) {
      if (finding.version) versions.add(finding.version);
    }
    vulnerable.set(advisory.module_name, versions);
  }

  const safe = new Map<string, string>();
  for (const rawKey of Object.keys(lockfile['packages'])) {
    // pnpm 6 lockfiles prefix package keys with `/`; later formats omit it.
    const key = rawKey.replace(/^\/+/, '');
    const separator = key.lastIndexOf('@');
    if (separator <= 0) continue;
    const name = key.slice(0, separator);
    const version = semver.valid(key.slice(separator + 1));
    if (!version || semver.prerelease(version) !== null) continue;
    if (vulnerable.get(name)?.has(version)) continue;
    const current = safe.get(name);
    if (!current || semver.gt(version, current)) safe.set(name, version);
  }
  return safe;
}

function readLockfileDocument(lockfileYaml: string): unknown {
  const documents = parseAllDocuments(lockfileYaml);
  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const document = documents[index];
    if (!document || document.errors.length > 0) continue;
    try {
      const value: unknown = document.toJS();
      // pnpm 12 can write a separate first document for its package manager
      // dependency. The workspace lock document follows it and contains the
      // packages used to resolve the workspace.
      if (isRecord(value) && isRecord(value['packages'])) return value;
    } catch {
      // Continue to an earlier valid document when a trailing document is
      // malformed. If none is usable, the caller receives undefined.
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
