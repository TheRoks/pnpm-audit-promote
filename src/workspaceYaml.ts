import { parseDocument, parse as parseYaml, type Document, type ParsedNode } from 'yaml';

export type WorkspaceYamlDocument = Document.Parsed<ParsedNode, true>;

function tryParse(yaml: string): WorkspaceYamlDocument | null {
  let doc: WorkspaceYamlDocument;
  try {
    doc = parseDocument(yaml, { keepSourceTokens: false }) as WorkspaceYamlDocument;
  } catch {
    return null;
  }
  return doc.errors.length === 0 ? doc : null;
}

/**
 * Stringify `doc` while restoring the original document's EOL convention.
 * `yaml@2` always emits LF; we re-insert CRLF when the source used it.
 */
export function serializeDoc(doc: WorkspaceYamlDocument, original: string): string {
  const out = doc.toString({ lineWidth: 0 });
  if (original.includes('\r\n') && !out.includes('\r\n')) {
    return out.replace(/\n/g, '\r\n');
  }
  return out;
}
/**
 * Keep pnpm 12's intentional `audit.ignorePrune` result while discarding any
 * unrelated workspace-yaml changes made by an audit read. Only accepts a
 * reduced `audit.ignore` list whose entries all existed in the desired file.
 */
export function preservePrunedAuditIgnore(desired: string, current: string): string {
  const desiredRoot = parseWorkspaceYaml(desired);
  const desiredAudit = desiredRoot?.['audit'];
  if (
    desiredAudit === null ||
    typeof desiredAudit !== 'object' ||
    (desiredAudit as Record<string, unknown>)['ignorePrune'] !== true
  ) {
    return desired;
  }
  const desiredConfig = desiredAudit as Record<string, unknown>;
  const desiredIgnore = desiredConfig['ignore'];
  if (!Array.isArray(desiredIgnore) || !desiredIgnore.every((id) => typeof id === 'string')) {
    return desired;
  }

  const currentAudit = parseWorkspaceYaml(current)?.['audit'];
  if (
    currentAudit === null ||
    typeof currentAudit !== 'object' ||
    (currentAudit as Record<string, unknown>)['ignorePrune'] !== true
  ) {
    return desired;
  }
  const currentConfig = currentAudit as Record<string, unknown>;
  const hasCurrentIgnore = 'ignore' in currentConfig;
  const currentIgnore = hasCurrentIgnore ? currentConfig['ignore'] : [];
  if (!Array.isArray(currentIgnore) || !currentIgnore.every((id) => typeof id === 'string')) {
    return desired;
  }
  if (
    currentIgnore.length > desiredIgnore.length ||
    !currentIgnore.every((id) => desiredIgnore.includes(id))
  ) {
    return desired;
  }
  if (JSON.stringify(currentIgnore) === JSON.stringify(desiredIgnore)) return desired;

  const doc = parseWorkspaceDoc(desired);
  if (!doc) return desired;
  if (hasCurrentIgnore) doc.setIn(['audit', 'ignore'], currentIgnore);
  else doc.deleteIn(['audit', 'ignore']);
  return serializeDoc(doc, desired);
}

function parseWorkspaceYaml(yaml: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseYaml(yaml);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Re-export `parseDocument` wrapper for callers that need a parsed doc. */
export function parseWorkspaceDoc(yaml: string): WorkspaceYamlDocument | null {
  return tryParse(yaml);
}

/** Merge pnpm approve-builds decisions from `current` into `desired`. */
export function mergeApprovedBuildSettings(
  desired: string,
  current: string,
  removeMissing = true,
): string {
  const actual = tryParse(current);
  const target = tryParse(desired);
  if (!actual || !target) return desired;

  let changed = false;
  for (const key of [
    'allowBuilds',
    'permissions',
    'onlyBuiltDependencies',
    'ignoredBuiltDependencies',
    'neverBuiltDependencies',
  ]) {
    const currentValue = actual.get(key);
    if (JSON.stringify(currentValue) === JSON.stringify(target.get(key))) continue;
    if (actual.has(key)) target.set(key, currentValue);
    else if (removeMissing) target.delete(key);
    changed = true;
  }
  return changed ? serializeDoc(target, desired) : desired;
}

/** Collapse 3+ consecutive newlines down to a single blank line. */
export function collapseBlankLines(text: string): string {
  return text.replace(/(\r?\n){3,}/g, (_m) => {
    const eol = _m.includes('\r\n') ? '\r\n' : '\n';
    return eol + eol;
  });
}
