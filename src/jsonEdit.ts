/**
 * Minimal textual edits to JSON to preserve formatting, property order, and
 * trailing whitespace. Mirrors the PowerShell helpers used by the original
 * script.
 */

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
 * Remove the JSON property `"name": <value>` (object/array/string/literal)
 * along with one neighboring comma. Returns the modified text, or the original
 * text if the property does not exist.
 */
export function removeJsonProperty(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`"${escaped}"\\s*:\\s*`);
  const km = keyRe.exec(text);
  if (!km) return text;

  const valStart = km.index + km[0].length;
  if (valStart >= text.length) return text;

  let valEnd = -1;
  const c = text[valStart];
  if (c === '{' || c === '[') {
    const close = findMatchingBrace(text, valStart);
    if (close < 0) return text;
    valEnd = close + 1;
  } else if (c === '"') {
    let i = valStart + 1;
    let escape = false;
    while (i < text.length) {
      const ch = text[i];
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') {
        valEnd = i + 1;
        break;
      }
      i++;
    }
    if (valEnd < 0) return text;
  } else {
    let i = valStart;
    while (i < text.length && !/[,}\]\s]/.test(text[i] ?? '')) i++;
    valEnd = i;
  }

  let start = km.index;
  let end = valEnd;

  const trailing = /^[ \t]*,/.exec(text.slice(end));
  if (trailing) {
    end += trailing[0].length;
  } else {
    // No trailing comma: this property was the last in its parent. We must
    // also strip the leading comma (and any whitespace, including newlines,
    // between that comma and our key) so the parent stays valid JSON.
    const leading = /,\s*$/.exec(text.slice(0, start));
    if (leading) start -= leading[0].length;
  }

  const lead = /[ \t]*$/.exec(text.slice(0, start));
  if (lead && lead[0].length > 0) start -= lead[0].length;
  const lb = /^\r?\n/.exec(text.slice(end));
  if (lb) end += lb[0].length;

  return text.slice(0, start) + text.slice(end);
}
