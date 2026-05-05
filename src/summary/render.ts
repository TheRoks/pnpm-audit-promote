/**
 * Terminal-pretty rendering of {@link RunSummaryData}. Pure function:
 * takes a snapshot, returns a string. Pass `{ color: false }` for a
 * plain-text version suitable for writing to a file.
 */
import pc from 'picocolors';
import { getBarePackageName } from '../semverUtil';
import { diffAdvisories, diffCatalog, diffOverrides } from './collect';
import {
  type AdvisorySummary,
  type CatalogChange,
  type RunSummaryData,
  type Severity,
} from './types';

export interface RenderOptions {
  /** When false, ANSI escape codes are stripped (for file output). */
  color?: boolean;
  /** Total width for separator lines. Defaults to 64. */
  width?: number;
}

/**
 * Render a beautifully formatted, terminal-pretty run summary.
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
  const overrideEntries = overrideChanges.length;
  const transitiveLine =
    overrideEntries === 0
      ? `${c.bold('0')} override entries changed`
      : `${c.bold(String(overrideEntries))} override ${pluralize(overrideEntries, 'entry', 'entries')} changed${
          transitivePackages.size > 0
            ? c.dim(
                ` (${transitivePackages.size} ${pluralize(transitivePackages.size, 'package')})`,
              )
            : ''
        }`;
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
    out.push(`  ${c.dim('No override changes.')}`);
  } else {
    const selW = Math.max(...overrideChanges.map((o) => o.selector.length));
    const valW = Math.max(
      ...overrideChanges.map((o) =>
        o.kind === 'removed' ? (o.before ?? '').length : (o.after ?? '').length,
      ),
    );
    for (const o of overrideChanges) {
      const src = o.source === 'workspace' ? 'pnpm-workspace.yaml' : 'package.json';
      if (o.kind === 'removed') {
        const wasNote = c.dim(` (was ${o.before ?? ''})`);
        out.push(
          `    ${padEnd(o.selector, selW)}  ${c.red('✗')}  ${padEnd(c.red('removed'), valW)}  ${c.dim(`(${src})`)}${wasNote}`,
        );
      } else if (o.kind === 'modified') {
        const wasNote = c.dim(` (was ${o.before ?? ''})`);
        out.push(
          `    ${padEnd(o.selector, selW)}  ${c.dim('→')}  ${padEnd(c.green(o.after ?? ''), valW)}  ${c.dim(`(${src})`)}${wasNote}`,
        );
      } else {
        out.push(
          `    ${padEnd(o.selector, selW)}  ${c.dim('→')}  ${padEnd(c.green(o.after ?? ''), valW)}  ${c.dim(`(${src})`)}`,
        );
      }
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

function severityLabel(s: Severity): string {
  if (s === 'unknown') return 'UNKNOWN';
  return s.toUpperCase();
}

export function formatDuration(durationMs: number): string {
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
