/**
 * Regex-based pnpm-workspace.yaml manipulation that preserves formatting,
 * ordering, and quoting style. Reads use the `yaml` AST for robustness
 * (anchors, comments, nested mappings); writes stay regex-based so the
 * file's original formatting is preserved byte-for-byte.
 */
import { parseDocument } from 'yaml';

export const OVERRIDES_BLOCK_PATTERN = /^(overrides:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;

export const CATALOG_BLOCK_PATTERN = /^(catalog:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;

/**
 * Pattern matching a single `name: value` mapping line in YAML, capturing
 * the (possibly quoted) name into one of three groups.
 */
export const YAML_KEY_PATTERN = /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:/;

function readCatalogMap(yaml: string): Map<string, string | null> {
  const result = new Map<string, string | null>();
  let doc;
  try {
    doc = parseDocument(yaml, { keepSourceTokens: false });
  } catch {
    return result;
  }
  // Bail on parse errors so malformed input never produces partial results.
  if (doc.errors.length > 0) return result;

  // `toJS` resolves aliases and produces plain JS values, which is what we
  // want for read-only inspection.
  let raw: unknown;
  try {
    raw = doc.toJS();
  } catch {
    return result;
  }
  if (typeof raw !== 'object' || raw === null) return result;
  const catalog = (raw as { catalog?: unknown }).catalog;
  if (typeof catalog !== 'object' || catalog === null) return result;

  for (const [name, value] of Object.entries(catalog as Record<string, unknown>)) {
    if (typeof value === 'string') result.set(name, value);
    else if (typeof value === 'number') result.set(name, String(value));
    else result.set(name, null);
  }
  return result;
}

/** Get catalog package names from the given workspace yaml content. */
export function getCatalogNames(yaml: string): Set<string> {
  return new Set(readCatalogMap(yaml).keys());
}

/**
 * Map of catalog package name -> concrete version string, parsed from the
 * given workspace yaml. Entries whose value is not a concrete version
 * (e.g. `$ref` aliases) are omitted.
 */
export function getCatalogVersions(yaml: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [name, raw] of readCatalogMap(yaml)) {
    if (!raw) continue;
    if (raw.startsWith('$')) continue;
    const concrete = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw)?.[1];
    if (concrete) versions.set(name, concrete);
  }
  return versions;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply catalog version updates to the workspace yaml text.
 * `updates` maps package name -> concrete version.
 *
 * NOTE: the trailing capture is `[ \t]*` (NOT `\s*`) because `\s` matches
 * newlines and would silently swallow following lines under multiline mode.
 */
export function applyCatalogUpdates(yaml: string, updates: ReadonlyMap<string, string>): string {
  if (updates.size === 0) return yaml;

  const cm = CATALOG_BLOCK_PATTERN.exec(yaml);
  if (!cm) return yaml;

  let catalogBody = cm[2] ?? '';
  for (const [name, version] of updates) {
    const escaped = escapeRegex(name);
    const entry = new RegExp(
      `^(\\s+(?:'${escaped}'|"${escaped}"|${escaped})\\s*:\\s*)(?:'([^']*)'|"([^"]*)"|(\\S+))([ \\t]*)$`,
      'gm',
    );
    catalogBody = catalogBody.replace(
      entry,
      (_match, prefix: string, sq?: string, dq?: string, _bare?: string, trail?: string) => {
        let wrapped: string;
        if (sq !== undefined) wrapped = `'${version}'`;
        else if (dq !== undefined) wrapped = `"${version}"`;
        else wrapped = version;
        return `${prefix}${wrapped}${trail ?? ''}`;
      },
    );
  }

  const eolMatch = /\r?\n/.exec(yaml);
  const eol = eolMatch?.[0] ?? '\n';
  return (
    yaml.slice(0, cm.index) + 'catalog:' + eol + catalogBody + yaml.slice(cm.index + cm[0].length)
  );
}

/** Collapse 3+ consecutive newlines down to a single blank line. */
export function collapseBlankLines(text: string): string {
  return text.replace(/(\r?\n){3,}/g, (_m) => {
    const eol = _m.includes('\r\n') ? '\r\n' : '\n';
    return eol + eol;
  });
}
