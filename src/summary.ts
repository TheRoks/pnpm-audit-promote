/**
 * Run summary collector + terminal-pretty renderer.
 *
 * Produces a beautifully formatted, ANSI-colored summary describing what
 * `refreshDeps` changed: direct (catalog) bumps, transitive overrides
 * added by `pnpm audit --fix`, and the set of CVEs that are now
 * resolved. The same renderer (with `color: false`) is used to write a
 * plain-text copy to disk via `--summary-file`.
 */
import * as fs from 'node:fs';
import pc from 'picocolors';
import semver from 'semver';
import { getCatalogVersions } from './catalog.js';
import { getBarePackageName } from './semverUtil.js';

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';

export interface AdvisorySummary {
  id: string;
  module: string;
  severity: Severity;
  title: string;
  url?: string;
  cves: string[];
}

export interface CatalogChange {
  name: string;
  before: string;
  after: string;
  bump: 'patch' | 'minor' | 'major' | 'unknown';
}

export interface OverrideChange {
  selector: string;
  before?: string;
  after: string;
  source: 'workspace' | 'package.json';
}

export interface RunSummaryData {
  workspaceRoot: string;
  workspaceName?: string;
  toolVersion: string;
  durationMs: number;
  dryRun: boolean;
  auditSkipped: boolean;
  originalCatalog: ReadonlyMap<string, string>;
  finalCatalog: ReadonlyMap<string, string>;
  originalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  finalOverrides: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>;
  initialAdvisories: readonly AdvisorySummary[];
  finalAdvisories: readonly AdvisorySummary[];
}

const PNPM_AUDIT_SEVERITIES = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
  'unknown',
]);

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  info: 4,
  unknown: 5,
};

/**
 * Parse `pnpm audit --json` stdout into a normalized advisory list.
 * Tolerates malformed input by returning an empty array.
 */
export function extractAdvisories(jsonStdout: string): AdvisorySummary[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const advisories = (parsed as { advisories?: Record<string, unknown> }).advisories;
  if (!advisories || typeof advisories !== 'object') return [];

  const out: AdvisorySummary[] = [];
  for (const [id, entry] of Object.entries(advisories)) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const sevRaw = typeof a.severity === 'string' ? a.severity.toLowerCase() : 'unknown';
    const severity: Severity = (PNPM_AUDIT_SEVERITIES as Set<string>).has(sevRaw)
      ? (sevRaw as Severity)
      : 'unknown';
    const cves = Array.isArray(a.cves)
      ? a.cves.filter((c): c is string => typeof c === 'string')
      : [];
    out.push({
      id,
      module: typeof a.module_name === 'string' ? a.module_name : '',
      severity,
      title: typeof a.title === 'string' ? a.title : '',
      url: typeof a.url === 'string' ? a.url : undefined,
      cves,
    });
  }
  return out;
}

function bumpTier(before: string, after: string): CatalogChange['bump'] {
  const a = semver.coerce(before)?.version;
  const b = semver.coerce(after)?.version;
  if (!a || !b) return 'unknown';
  if (semver.major(b) > semver.major(a)) return 'major';
  if (semver.minor(b) > semver.minor(a)) return 'minor';
  if (semver.patch(b) !== semver.patch(a)) return 'patch';
  return 'unknown';
}

/** Compute the delta between two catalog snapshots (entries whose version changed). */
export function diffCatalog(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): CatalogChange[] {
  const changes: CatalogChange[] = [];
  for (const [name, afterVer] of after) {
    const beforeVer = before.get(name);
    if (!beforeVer) continue; // new catalog entries (rare) are out of scope
    if (beforeVer === afterVer) continue;
    changes.push({ name, before: beforeVer, after: afterVer, bump: bumpTier(beforeVer, afterVer) });
  }
  changes.sort((a, b) => a.name.localeCompare(b.name));
  return changes;
}

/**
 * Compute overrides in the final state that were not present (or had a
 * different value) in the original state. Represents transitive
 * vulnerabilities `pnpm audit --fix` patched.
 */
export function diffOverrides(
  before: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>,
  after: ReadonlyMap<string, { value: string; source: 'workspace' | 'package.json' }>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  for (const [selector, { value, source }] of after) {
    const prior = before.get(selector);
    if (prior && prior.value === value) continue;
    changes.push({ selector, before: prior?.value, after: value, source });
  }
  changes.sort((a, b) => a.selector.localeCompare(b.selector));
  return changes;
}

/** Fixed = present in initial, absent (by id) from final. */
export function diffAdvisories(
  initial: readonly AdvisorySummary[],
  final: readonly AdvisorySummary[],
): { fixed: AdvisorySummary[]; remaining: AdvisorySummary[] } {
  const finalIds = new Set(final.map((a) => a.id));
  const fixed = initial.filter((a) => !finalIds.has(a.id));
  const sortBySev = (a: AdvisorySummary, b: AdvisorySummary): number =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.module.localeCompare(b.module);
  return {
    fixed: [...fixed].sort(sortBySev),
    remaining: [...final].sort(sortBySev),
  };
}

/**
 * Read the `overrides:` block from a workspace yaml string and return a
 * `selector -> value` map.
 */
export function readWorkspaceOverrides(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const blockRe = /^(overrides:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;
  const m = blockRe.exec(yaml);
  if (!m) return out;
  const body = m[2] ?? '';
  const entryRe =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s]+))\s*$/;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const em = entryRe.exec(line);
    if (!em) continue;
    const key = em[1] ?? em[2] ?? em[3] ?? '';
    const val = em[4] ?? em[5] ?? em[6] ?? '';
    if (key) out.set(key, val);
  }
  return out;
}

/** Read `pnpm.overrides` from a package.json text. Tolerant of malformed input. */
export function readPackageJsonOverrides(jsonText: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(jsonText) as { pnpm?: { overrides?: Record<string, unknown> } };
    const overrides = parsed?.pnpm?.overrides;
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === 'string') out.set(k, v);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

/** Convenience: catalog snapshot from yaml text, only entries with concrete versions. */
export function readCatalogSnapshot(yaml: string): Map<string, string> {
  return new Map(getCatalogVersions(yaml));
}

/** Combine workspace + package.json overrides into one selector-keyed map. */
export function readAllOverrides(
  workspaceYaml: string,
  rootPackageJsonText: string | null,
): Map<string, { value: string; source: 'workspace' | 'package.json' }> {
  const out = new Map<string, { value: string; source: 'workspace' | 'package.json' }>();
  for (const [k, v] of readWorkspaceOverrides(workspaceYaml)) {
    out.set(k, { value: v, source: 'workspace' });
  }
  if (rootPackageJsonText) {
    for (const [k, v] of readPackageJsonOverrides(rootPackageJsonText)) {
      // package.json takes precedence in display when keys collide.
      out.set(k, { value: v, source: 'package.json' });
    }
  }
  return out;
}

/** Read a file, returning null on any error. */
export function safeReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function severityLabel(s: Severity): string {
  if (s === 'unknown') return 'UNKNOWN';
  return s.toUpperCase();
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Visible width of a string with ANSI escape codes stripped. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, '').length;
}

function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

interface ColorFns {
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  magenta: (s: string) => string;
  blue: (s: string) => string;
  gray: (s: string) => string;
}

const identity = (s: string): string => s;
const NO_COLOR: ColorFns = {
  dim: identity,
  bold: identity,
  cyan: identity,
  green: identity,
  yellow: identity,
  red: identity,
  magenta: identity,
  blue: identity,
  gray: identity,
};
const ANSI_COLOR: ColorFns = {
  dim: pc.dim,
  bold: pc.bold,
  cyan: pc.cyan,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  magenta: pc.magenta,
  blue: pc.blue,
  gray: pc.gray,
};

function severityColor(s: Severity, c: ColorFns): (s: string) => string {
  switch (s) {
    case 'critical':
      return (text): string => c.bold(c.red(text));
    case 'high':
      return c.red;
    case 'moderate':
      return c.yellow;
    case 'low':
      return c.cyan;
    case 'info':
      return c.gray;
    default:
      return c.gray;
  }
}

function bumpColor(b: CatalogChange['bump'], c: ColorFns): (s: string) => string {
  switch (b) {
    case 'major':
      return (text): string => c.bold(c.yellow(text));
    case 'minor':
      return c.green;
    case 'patch':
      return c.cyan;
    default:
      return c.gray;
  }
}

interface RenderOptions {
  /** When false, ANSI escape codes are stripped (for file output). */
  color?: boolean;
  /** Total width for separator lines. Defaults to 64. */
  width?: number;
}

/**
 * Render a beautifully formatted, terminal-pretty run summary.
 *
 * Pass `{ color: false }` to get a plain-text version suitable for
 * writing to a file.
 */
export function renderTerminalSummary(data: RunSummaryData, options: RenderOptions = {}): string {
  const c = options.color === false ? NO_COLOR : ANSI_COLOR;
  const width = options.width ?? 64;
  const directChanges = diffCatalog(data.originalCatalog, data.finalCatalog);
  const overrideChanges = diffOverrides(data.originalOverrides, data.finalOverrides);
  const { fixed, remaining } = diffAdvisories(data.initialAdvisories, data.finalAdvisories);

  const transitivePackages = new Set<string>();
  for (const o of overrideChanges) transitivePackages.add(getBarePackageName(o.selector));

  const cves = new Set<string>();
  for (const a of fixed) for (const cve of a.cves) cves.add(cve);

  const out: string[] = [];
  const rule = c.dim('─'.repeat(width));
  const heavyRule = c.cyan('═'.repeat(width));

  // Header
  const title = data.workspaceName
    ? `Dependency refresh — ${c.bold(data.workspaceName)}`
    : 'Dependency refresh summary';
  out.push(heavyRule);
  out.push(`  ${c.bold(c.cyan(title))}`);
  out.push(heavyRule);
  out.push('');

  if (data.dryRun) {
    out.push(`  ${c.yellow('⚠')}  ${c.yellow('Dry run — no files were modified.')}`);
    out.push('');
  }
  if (data.auditSkipped) {
    out.push(
      `  ${c.yellow('⚠')}  ${c.yellow('Audit phase skipped (--no-audit); vulnerability data is incomplete.')}`,
    );
    out.push('');
  }

  // Headline metrics
  const directLine = `${c.bold(String(directChanges.length))} direct ${pluralize(directChanges.length, 'package')} updated`;
  const transitiveLine = `${c.bold(String(transitivePackages.size))} transitive ${pluralize(transitivePackages.size, 'package')} pinned via overrides`;
  const fixedCount = fixed.length;
  const fixedLine =
    fixedCount > 0
      ? `${c.bold(c.green(String(fixedCount)))} ${pluralize(fixedCount, 'vulnerability', 'vulnerabilities')} fixed${
          cves.size > 0 ? c.dim(` (${cves.size} ${pluralize(cves.size, 'CVE')} resolved)`) : ''
        }`
      : `${c.bold('0')} vulnerabilities fixed`;
  const remainingLine =
    remaining.length === 0
      ? `${c.bold(c.green('0'))} remaining`
      : `${c.bold(c.red(String(remaining.length)))} ${pluralize(remaining.length, 'vulnerability', 'vulnerabilities')} remaining`;

  out.push(`  ${c.green('●')} ${directLine}`);
  out.push(`  ${c.green('●')} ${transitiveLine}`);
  out.push(`  ${c.green('●')} ${fixedLine}`);
  out.push(`  ${remaining.length === 0 ? c.green('●') : c.red('●')} ${remainingLine}`);
  out.push('');

  // Direct (catalog) bumps
  out.push(`  ${c.bold('Direct dependencies (catalog)')}`);
  out.push(`  ${rule}`);
  if (directChanges.length === 0) {
    out.push(`  ${c.dim('No catalog versions changed.')}`);
  } else {
    const nameW = Math.max(...directChanges.map((d) => d.name.length));
    const beforeW = Math.max(...directChanges.map((d) => d.before.length));
    const afterW = Math.max(...directChanges.map((d) => d.after.length));
    for (const d of directChanges) {
      const tier = d.bump === 'unknown' ? '?' : d.bump.toUpperCase();
      const tierStr = bumpColor(d.bump, c)(tier);
      out.push(
        `    ${padEnd(d.name, nameW)}  ${c.dim(padStart(d.before, beforeW))} ${c.dim('→')} ${padStart(d.after, afterW)}  ${tierStr}`,
      );
    }
  }
  out.push('');

  // Transitive overrides
  out.push(`  ${c.bold('Transitive overrides')}`);
  out.push(`  ${rule}`);
  if (overrideChanges.length === 0) {
    out.push(`  ${c.dim('No new transitive overrides were introduced.')}`);
  } else {
    const selW = Math.max(...overrideChanges.map((o) => o.selector.length));
    const valW = Math.max(...overrideChanges.map((o) => o.after.length));
    for (const o of overrideChanges) {
      const src = o.source === 'workspace' ? 'pnpm-workspace.yaml' : 'package.json';
      const wasNote = o.before ? c.dim(` (was ${o.before})`) : '';
      out.push(
        `    ${padEnd(o.selector, selW)}  ${c.dim('→')}  ${padEnd(c.green(o.after), valW)}  ${c.dim(`(${src})`)}${wasNote}`,
      );
    }
  }
  out.push('');

  // Fixed vulnerabilities
  out.push(`  ${c.bold('Vulnerabilities fixed')}`);
  out.push(`  ${rule}`);
  if (fixed.length === 0) {
    out.push(`  ${c.dim('No vulnerabilities were resolved during this run.')}`);
  } else {
    renderAdvisoryRows(fixed, out, c);
  }
  out.push('');

  // Remaining vulnerabilities (only if any)
  if (remaining.length > 0) {
    out.push(`  ${c.bold(c.red('Vulnerabilities remaining'))}`);
    out.push(`  ${rule}`);
    renderAdvisoryRows(remaining, out, c);
    out.push('');
  }

  // Footer
  out.push(heavyRule);
  out.push(
    c.dim(
      `  Generated by pnpm-audit-promote@${data.toolVersion} in ${formatDuration(data.durationMs)}`,
    ),
  );
  out.push(heavyRule);

  return out.join('\n');
}

function renderAdvisoryRows(
  advisories: readonly AdvisorySummary[],
  out: string[],
  c: ColorFns,
): void {
  const sevW = Math.max(...advisories.map((a) => severityLabel(a.severity).length));
  const modW = Math.max(...advisories.map((a) => a.module.length));
  const cveW = Math.max(...advisories.map((a) => (a.cves[0] ? a.cves[0].length : '—'.length)));
  for (const a of advisories) {
    const sev = severityColor(a.severity, c)(padEnd(severityLabel(a.severity), sevW));
    const cveStr = a.cves[0] ?? '—';
    const cveExtra = a.cves.length > 1 ? c.dim(` (+${a.cves.length - 1})`) : '';
    const title = a.title || c.dim('—');
    out.push(
      `    ${sev}  ${padEnd(a.module, modW)}  ${c.dim(padEnd(cveStr, cveW))}${cveExtra}  ${title}`,
    );
  }
}

function pluralize(n: number, singular: string, plural?: string): string {
  if (n === 1) return singular;
  return plural ?? `${singular}s`;
}
