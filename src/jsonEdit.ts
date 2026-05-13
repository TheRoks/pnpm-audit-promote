/**
 * Minimal textual edits to JSON to preserve formatting, property order, and
 * trailing whitespace.
 *
 * `findMatchingBrace` remains a hand-rolled scanner because the audit
 * promotion code needs to slice the *body* of the `overrides` object to
 * iterate it line by line, and no off-the-shelf library exposes that.
 *
 * `removeJsonProperty` delegates to `jsonc-parser`'s `modify` + `applyEdits`,
 * which produces minimal, formatting-preserving edits and correctly handles
 * the leading/trailing comma cases that the previous regex had to special-case.
 */
import { applyEdits, modify } from 'jsonc-parser';

/**
 * Given the index of an opening `{` or `[`, return the index of the matching
 * closer, accounting for nested braces/brackets and string literals (with
 * backslash escapes). Returns -1 if no match.
 */
export function findMatchingBrace(text: string, openIndex: number): number {
  const opener = text[openIndex];
  let closer: string;
  if (opener === '{') closer = '}';
  else if (opener === '[') closer = ']';
  else return -1;

  let i = openIndex + 1;
  let depth = 1;
  let inStr = false;
  let escape = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === opener) depth++;
      else if (c === closer) {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Set a JSON property at the given path. Returns the modified text with the
 * property written (created or updated) while preserving existing formatting.
 * The path is variadic: pass one segment for a top-level property, multiple
 * for nested ones (e.g. `setJsonProperty(text, 'new-value', 'dependencies', 'react')`).
 *
 * Indentation of any newly-inserted lines is auto-detected from `text` so
 * the result blends in with the file's existing style (2-space, 4-space,
 * or tab).
 */
export function setJsonProperty(text: string, value: unknown, ...jsonPath: string[]): string {
  if (jsonPath.length === 0) return text;
  let edits;
  try {
    edits = modify(text, jsonPath, value, {
      formattingOptions: detectJsonFormatting(text),
    });
  } catch {
    return text;
  }
  if (edits.length === 0) return text;
  return applyEdits(text, edits);
}

/**
 * Detect the indent unit (tabs vs spaces, and how many spaces) used by a
 * JSON text. Looks for the first indented line that begins a new key. Falls
 * back to two spaces — the default for `package.json` files written by npm.
 */
function detectJsonFormatting(text: string): {
  tabSize: number;
  insertSpaces: boolean;
  eol: string;
} {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  // First line that starts with whitespace followed by a `"` (a JSON key).
  const m = /\n([\t ]+)"/.exec(text);
  if (!m) return { tabSize: 2, insertSpaces: true, eol };
  const indent = m[1] ?? '  ';
  if (indent.startsWith('\t')) {
    return { tabSize: 1, insertSpaces: false, eol };
  }
  return { tabSize: indent.length, insertSpaces: true, eol };
}

/**
 * Remove a JSON property at the given path. Returns the modified text, or
 * the original text if the property does not exist. The path is variadic:
 * pass one segment for a top-level property, multiple for nested ones
 * (e.g. `removeJsonProperty(text, 'pnpm', 'overrides')`).
 */
export function removeJsonProperty(text: string, ...jsonPath: string[]): string {
  if (jsonPath.length === 0) return text;
  let edits;
  try {
    edits = modify(text, jsonPath, undefined, {});
  } catch {
    // jsonc-parser throws when an intermediate path segment is missing.
    // Treat that as a no-op rather than propagating the error.
    return text;
  }
  if (edits.length === 0) return text;
  return applyEdits(text, edits);
}
