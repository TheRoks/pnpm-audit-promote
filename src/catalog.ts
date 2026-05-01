/**
 * Regex-based pnpm-workspace.yaml manipulation that preserves formatting,
 * ordering, and quoting style. Matches the PowerShell helpers from the
 * original script.
 */

export const OVERRIDES_BLOCK_PATTERN = /^(overrides:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;

export const CATALOG_BLOCK_PATTERN = /^(catalog:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+))/m;

/**
 * Pattern matching a single `name: value` mapping line in YAML, capturing
 * the (possibly quoted) name into one of three groups.
 */
export const YAML_KEY_PATTERN = /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:/;

/** Get catalog package names from the given workspace yaml content. */
export function getCatalogNames(yaml: string): Set<string> {
  const names = new Set<string>();
  const cm = CATALOG_BLOCK_PATTERN.exec(yaml);
  if (!cm) return names;

  const body = cm[2] ?? '';
  for (const line of body.split(/\r?\n/)) {
    const m = YAML_KEY_PATTERN.exec(line);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    if (name) names.add(name);
  }
  return names;
}

/**
 * Map of catalog package name -> concrete version string, parsed from the
 * given workspace yaml. Entries whose value is not a concrete version
 * (e.g. `$ref` aliases) are omitted.
 */
export function getCatalogVersions(yaml: string): Map<string, string> {
  const versions = new Map<string, string>();
  const cm = CATALOG_BLOCK_PATTERN.exec(yaml);
  if (!cm) return versions;

  const body = cm[2] ?? '';
  const entryPattern =
    /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/;
  for (const line of body.split(/\r?\n/)) {
    const m = entryPattern.exec(line);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    const raw = m[4] ?? m[5] ?? m[6] ?? '';
    if (!name) continue;
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
      `^(\\s+(?:'${escaped}'|"${escaped}"|${escaped})\\s*:\\s*)(?:'[^']*'|"[^"]*"|\\S+)([ \\t]*)$`,
      'gm',
    );
    catalogBody = catalogBody.replace(entry, `$1'${version}'$2`);
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
