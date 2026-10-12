/** Normalized subset of pnpm's JSON audit response consumed by this tool. */
export interface PnpmAuditFinding {
  version?: string;
  paths?: string[];
}

export interface PnpmAuditAdvisory {
  module_name?: string;
  patched_versions?: string;
  vulnerable_versions?: string;
  severity?: string;
  title?: string;
  github_advisory_id?: string;
  cves?: string[];
  url?: string;
  findings?: PnpmAuditFinding[];
}

export interface PnpmAuditOutput {
  advisories: Record<string, PnpmAuditAdvisory>;
}

export type PnpmAuditParseResult =
  | {
      complete: true;
      audit: PnpmAuditOutput;
      topLevelKeys: string[];
    }
  | {
      complete: false;
      reason: 'empty' | 'invalid-json' | 'invalid-shape';
      topLevelKeys: string[];
    };

/** Parse and validate pnpm audit JSON once for policy and reporting consumers. */
export function parsePnpmAuditOutput(stdout: string): PnpmAuditParseResult {
  if (!stdout.trim()) return { complete: false, reason: 'empty', topLevelKeys: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { complete: false, reason: 'invalid-json', topLevelKeys: [] };
  }
  if (!isRecord(parsed)) {
    return { complete: false, reason: 'invalid-shape', topLevelKeys: [] };
  }

  const advisories = parsed['advisories'];
  if (!isRecord(advisories)) {
    return {
      complete: false,
      reason: 'invalid-shape',
      topLevelKeys: Object.keys(parsed),
    };
  }

  const normalized: Record<string, PnpmAuditAdvisory> = {};
  for (const [id, advisory] of Object.entries(advisories)) {
    if (!isRecord(advisory)) continue;
    normalized[id] = normalizeAdvisory(advisory);
  }
  return {
    complete: true,
    audit: { advisories: normalized },
    topLevelKeys: Object.keys(parsed),
  };
}

function normalizeAdvisory(value: Record<string, unknown>): PnpmAuditAdvisory {
  const findings = value['findings'];
  return {
    module_name: stringValue(value['module_name']),
    patched_versions: stringValue(value['patched_versions']),
    vulnerable_versions: stringValue(value['vulnerable_versions']),
    severity: stringValue(value['severity']),
    title: stringValue(value['title']),
    github_advisory_id: stringValue(value['github_advisory_id']),
    cves: Array.isArray(value['cves'])
      ? value['cves'].filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    url: stringValue(value['url']),
    findings: Array.isArray(findings)
      ? findings.filter(isRecord).map((finding) => ({
          version: stringValue(finding['version']),
          paths: Array.isArray(finding['paths'])
            ? finding['paths'].filter((entry): entry is string => typeof entry === 'string')
            : undefined,
        }))
      : undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
