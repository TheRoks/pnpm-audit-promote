/**
 * pnpm 11 changed several `pnpm-workspace.yaml` defaults that interfere with
 * `pnpm-audit-promote`'s job:
 *
 *  - `minimumReleaseAge` defaults to `1440` (24 hours), blocking upgrades to
 *    packages that were published less than a day ago. This makes
 *    `pnpm audit --fix` unable to promote a freshly-published patch release.
 *    We *do not* zero this gate — see REQ-PNPM11-010. Instead,
 *    {@link addMinimumReleaseAgeExcludeEntries} pre-seeds only the specific
 *    advisory-fix versions into `minimumReleaseAgeExclude`, leaving the
 *    global gate intact for every other package (REQ-PNPM11-009).
 *  - `pnpm audit --fix` itself writes `minimumReleaseAgeExclude` entries into
 *    `pnpm-workspace.yaml`, which the existing `restoreWorkspaceYaml` flow
 *    would clobber if it blindly wrote back the pre-run snapshot. See
 *    {@link mergeMinimumReleaseAgeExclude} for the reconciliation step.
 *
 * The helpers in this module are intentionally regex-based so they preserve
 * the YAML byte-for-byte outside the keys they explicitly target — matching
 * the rest of the project's "minimal, line-oriented YAML editing" style.
 *
 * All helpers operate on the top-level scope only; nested matches inside
 * other mappings are not touched.
 */

const SPLIT_EOL_RE = /\r?\n/g;

/** Match a top-level `key:` line (no leading whitespace). */
function topLevelKeyRegex(key: string): RegExp {
  return new RegExp(`^${escapeRegExp(key)}\\s*:`, 'm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detect the dominant EOL in `yaml` (mirrors WorkspaceState.detectEol). */
function detectEol(yaml: string): '\r\n' | '\n' {
  return yaml.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Return the raw value associated with a top-level scalar key (no nested
 * mappings). Returns `null` when the key is missing or refers to a block
 * mapping/sequence rather than a scalar.
 */
export function getTopLevelScalar(yaml: string, key: string): string | null {
  if (!yaml) return null;
  // `[ \t]*` rather than `\s*` so the regex cannot jump across line boundaries
  // and match a nested key on the next line (e.g. the body of a block).
  const re = new RegExp(`^${escapeRegExp(key)}[ \\t]*:[ \\t]*([^\\r\\n]*)$`, 'm');
  const match = re.exec(yaml);
  if (!match) return null;
  const value = match[1]!.trim();
  // A bare `key:` with no value is a block start, not a scalar.
  if (value === '') return null;
  return value;
}

/**
 * Return true when `yaml` contains a top-level key (scalar, sequence, or
 * mapping form).
 */
export function hasTopLevelKey(yaml: string, key: string): boolean {
  if (!yaml) return false;
  return topLevelKeyRegex(key).test(yaml);
}

/**
 * Merge the `minimumReleaseAgeExclude` block from `source` into `target`,
 * returning the new target text. pnpm 11's `pnpm audit --fix` writes the
 * minimum patched version of each fixed advisory into this block; without a
 * merge step the subsequent `restoreWorkspaceYaml` would discard those
 * entries. Existing entries in `target` are preserved; entries with the
 * same key in `source` override them.
 *
 * The implementation is regex-based — when either side uses a flow-style
 * mapping (rare in pnpm-generated yaml) the source block is left as-is on
 * the file (no merge attempted) and `target` is returned unchanged.
 */
export function mergeMinimumReleaseAgeExclude(target: string, source: string): string {
  const sourceBlock = extractMinimumReleaseAgeExcludeBlock(source);
  if (!sourceBlock) return target;

  const eol = detectEol(target || source);
  const targetBlockRange = locateMinimumReleaseAgeExcludeBlock(target);

  if (!targetBlockRange) {
    const trailingEol = target.length === 0 || target.endsWith('\n') ? '' : eol;
    return `${target}${trailingEol}minimumReleaseAgeExclude:${eol}${sourceBlock.indented}${eol}`;
  }

  // Merge entry-by-entry, source overrides target.
  const targetEntries = parseExcludeEntries(targetBlockRange.body);
  const sourceEntries = parseExcludeEntries(sourceBlock.indented);
  const merged = new Map<string, string>();
  for (const [name, line] of targetEntries) merged.set(name, line);
  for (const [name, line] of sourceEntries) merged.set(name, line);

  const mergedLines = Array.from(merged.values()).join(eol);
  const newBlock = `minimumReleaseAgeExclude:${eol}${mergedLines}${eol}`;
  return target.slice(0, targetBlockRange.start) + newBlock + target.slice(targetBlockRange.end);
}

interface ExcludeBlock {
  /** The body lines below `minimumReleaseAgeExclude:`, joined by `\n`. */
  indented: string;
}

interface BlockRange extends ExcludeBlock {
  start: number;
  end: number;
  body: string;
}

function extractMinimumReleaseAgeExcludeBlock(yaml: string): ExcludeBlock | null {
  const range = locateMinimumReleaseAgeExcludeBlock(yaml);
  if (!range) return null;
  return { indented: range.body };
}

/**
 * Locate the byte range of a top-level `minimumReleaseAgeExclude:` block —
 * header line plus all subsequent indented body lines. Returns `null` when
 * the key is missing or has no indented children (e.g. inline flow form,
 * which pnpm does not write).
 */
function locateMinimumReleaseAgeExcludeBlock(yaml: string): BlockRange | null {
  const headerMatch = /^minimumReleaseAgeExclude\s*:[^\r\n]*(\r?\n|$)/m.exec(yaml);
  if (!headerMatch) return null;
  const headerStart = headerMatch.index;
  let cursor = headerMatch.index + headerMatch[0].length;
  const lineRe = /([^\r\n]*)(\r?\n|$)/y;
  const bodyLines: string[] = [];
  let lastNonBlankCursor = cursor;
  while (cursor < yaml.length) {
    lineRe.lastIndex = cursor;
    const m = lineRe.exec(yaml);
    if (!m) break;
    const lineText = m[1]!;
    const consumed = m[0].length;
    if (consumed === 0) break;
    const isIndentedContent = /^\s+\S/.test(lineText);
    const isBlank = lineText.trim() === '';
    if (isIndentedContent) {
      bodyLines.push(lineText);
      cursor += consumed;
      lastNonBlankCursor = cursor;
      continue;
    }
    if (isBlank && bodyLines.length > 0) {
      bodyLines.push(lineText);
      cursor += consumed;
      continue;
    }
    break;
  }
  if (bodyLines.length === 0) return null;
  // Trim trailing blank lines from the body window — they belong to the
  // next sibling, not to this block.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === '') {
    bodyLines.pop();
  }
  if (bodyLines.length === 0) return null;
  const body = bodyLines.join('\n');
  return { start: headerStart, end: lastNonBlankCursor, body, indented: body };
}

function parseExcludeEntries(blockBody: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = blockBody.split(SPLIT_EOL_RE);
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = /^(\s+)([^:\s]+)\s*:/.exec(line);
    if (!m) continue;
    map.set(m[2]!, line);
  }
  return map;
}

/**
 * Merge a `name -> version` map into the top-level
 * `minimumReleaseAgeExclude` block of `yaml`. Existing entries in `yaml`
 * are preserved; entries in `additions` override on key collision.
 *
 * When the block is missing, it is appended. When `additions` is empty,
 * `yaml` is returned unchanged.
 *
 * Used to pre-seed advisory-fix versions before `pnpm audit --fix override`
 * so pnpm 11's release-age gate does not reject freshly-published patches,
 * without disturbing the user\u2019s global `minimumReleaseAge` setting.
 */
export function addMinimumReleaseAgeExcludeEntries(
  yaml: string,
  additions: ReadonlyMap<string, string>,
): string {
  if (additions.size === 0) return yaml;
  const eol = detectEol(yaml || '');
  const range = locateMinimumReleaseAgeExcludeBlock(yaml);

  if (!range) {
    const lines = [...additions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, version]) => `  ${name}: ${version}`)
      .join(eol);
    const trailingEol = yaml.length === 0 || yaml.endsWith('\n') ? '' : eol;
    return `${yaml}${trailingEol}minimumReleaseAgeExclude:${eol}${lines}${eol}`;
  }

  const existing = parseExcludeEntries(range.body);
  const merged = new Map<string, string>(existing);
  for (const [name, version] of additions) {
    merged.set(name, `  ${name}: ${version}`);
  }
  const mergedLines = Array.from(merged.values()).join(eol);
  const newBlock = `minimumReleaseAgeExclude:${eol}${mergedLines}${eol}`;
  return yaml.slice(0, range.start) + newBlock + yaml.slice(range.end);
}
