/**
 * pnpm 11's `pnpm audit --fix` appends the patched version of every fixed
 * advisory to the top-level `minimumReleaseAgeExclude` block in
 * `pnpm-workspace.yaml`. This tool must never expand that list
 * (REQ-PNPM11-011), so after pnpm rewrites the file we reset the block to the
 * user's original content — or remove it entirely when the user had none.
 *
 * The helpers operate on raw text to preserve the rest of the file's
 * formatting and EOL style. They handle both block-mapping (`  name: version`)
 * and block-sequence (`  - name@version`) bodies, which are the two forms
 * pnpm emits.
 */

interface BlockRange {
  start: number;
  end: number;
}

/** Match a top-level `minimumReleaseAgeExclude:` header line. */
const HEADER_RE = /^minimumReleaseAgeExclude[ \t]*:[^\r\n]*(\r?\n|$)/m;

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Locate the byte range of the top-level `minimumReleaseAgeExclude:` block —
 * the header line plus every following indented body line (mapping entries or
 * sequence items). Trailing blank lines are excluded; they belong to the next
 * sibling. Returns `null` when the key is absent.
 */
function locateBlock(yaml: string): BlockRange | null {
  const header = HEADER_RE.exec(yaml);
  if (!header) return null;
  const start = header.index;
  let cursor = header.index + header[0].length;
  let end = cursor; // end of the last body line consumed (incl. its EOL)
  const lineRe = /([^\r\n]*)(\r?\n|$)/y;
  while (cursor < yaml.length) {
    lineRe.lastIndex = cursor;
    const m = lineRe.exec(yaml);
    if (!m) break;
    const consumed = m[0].length;
    if (consumed === 0) break;
    const text = m[1]!;
    const isIndented = /^[ \t]+\S/.test(text);
    const isBlank = text.trim() === '';
    if (isIndented) {
      cursor += consumed;
      end = cursor;
      continue;
    }
    if (isBlank) {
      cursor += consumed; // tentatively skip; do not extend `end`
      continue;
    }
    break; // a new top-level key — stop
  }
  return { start, end };
}

/** Return the `minimumReleaseAgeExclude` block text (header + body), or null. */
function extractBlock(yaml: string): string | null {
  const range = locateBlock(yaml);
  if (!range) return null;
  return yaml.slice(range.start, range.end);
}

/**
 * Reset the top-level `minimumReleaseAgeExclude` block in `current` to the
 * block found in `original`. When `original` has no such block the block is
 * removed from `current`. When `current` has no block it is returned
 * unchanged. The result reuses `current`'s dominant EOL style.
 */
export function restoreMinimumReleaseAgeExclude(current: string, original: string): string {
  const range = locateBlock(current);
  if (!range) return current; // nothing pnpm added

  const originalBlock = extractBlock(original);

  if (originalBlock === null) {
    // The user had no exclude block: remove the one pnpm wrote.
    return current.slice(0, range.start) + current.slice(range.end);
  }

  // Re-key the original block onto the current file's EOL style.
  const eol = detectEol(current);
  const normalized = originalBlock.replace(/\r?\n/g, eol);
  if (current.slice(range.start, range.end) === normalized) return current;
  return current.slice(0, range.start) + normalized + current.slice(range.end);
}
