/**
 * `pnpm-workspace.yaml` manipulation via the `yaml` AST. Reads and writes
 * both go through `parseDocument`; comments, ordering, and quoting style
 * are preserved by mutating `Scalar` nodes in place and serializing via
 * `Document.toString()`.
 */
import {
  parseDocument,
  isMap,
  isScalar,
  isAlias,
  Scalar,
  type Document,
  type YAMLMap,
  type ParsedNode,
} from 'yaml';

const CATALOG_KEY = 'catalog';
const CATALOGS_KEY = 'catalogs';

type Doc = Document.Parsed<ParsedNode, true>;

function tryParse(yaml: string): Doc | null {
  let doc: Doc;
  try {
    doc = parseDocument(yaml, { keepSourceTokens: false }) as Doc;
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  return doc;
}

/**
 * Return every catalog mapping in the document: the top-level `catalog:` map,
 * plus every named map inside `catalogs:` (pnpm 10 supports multiple named
 * catalogs).
 */
function getCatalogMaps(doc: Doc): YAMLMap[] {
  const out: YAMLMap[] = [];
  const top = doc.get(CATALOG_KEY, true);
  if (isMap(top)) out.push(top);
  const named = doc.get(CATALOGS_KEY, true);
  if (isMap(named)) {
    for (const item of named.items) {
      if (isMap(item.value)) out.push(item.value);
    }
  }
  return out;
}

function readCatalogMapFromDoc(doc: Doc): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const map of getCatalogMaps(doc)) {
    for (const item of map.items) {
      const k = isScalar(item.key) ? String(item.key.value) : null;
      if (k === null) continue;
      let value: string | null = null;
      let node: unknown = item.value;
      if (isAlias(node)) {
        const resolved = node.resolve(doc);
        if (resolved !== undefined) node = resolved;
      }
      if (isScalar(node)) {
        const v = node.value;
        if (typeof v === 'string') value = v;
        else if (typeof v === 'number') value = String(v);
      }
      result.set(k, value);
    }
  }
  return result;
}

function readCatalogMap(yaml: string): Map<string, string | null> {
  const doc = tryParse(yaml);
  if (!doc) return new Map();
  return readCatalogMapFromDoc(doc);
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
  return extractConcreteVersions(readCatalogMap(yaml));
}

/**
 * Parse the catalog block once and return both names and versions together.
 * Avoids calling `parseDocument` twice when both are needed in the same call site.
 */
export function readCatalog(yaml: string): { names: Set<string>; versions: Map<string, string> } {
  const raw = readCatalogMap(yaml);
  return { names: new Set(raw.keys()), versions: extractConcreteVersions(raw) };
}

function extractConcreteVersions(raw: Map<string, string | null>): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [name, value] of raw) {
    if (!value) continue;
    if (value.startsWith('$')) continue;
    const concrete = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(value)?.[1];
    if (concrete) versions.set(name, concrete);
  }
  return versions;
}

/**
 * Apply catalog version updates in-place on the parsed document. Returns
 * `true` when any scalar was modified. Preserves the original quoting style
 * because each scalar's `type` (PLAIN / QUOTE_SINGLE / QUOTE_DOUBLE) is left
 * untouched.
 *
 * Internal helper — exported so callers that already have a parsed document
 * (e.g. the overrides promoter) can reuse it without re-parsing.
 */
export function applyCatalogUpdatesToDoc(doc: Doc, updates: ReadonlyMap<string, string>): boolean {
  if (updates.size === 0) return false;
  let modified = false;
  for (const map of getCatalogMaps(doc)) {
    for (const item of map.items) {
      const k = isScalar(item.key) ? String(item.key.value) : null;
      if (k === null) continue;
      const next = updates.get(k);
      if (next === undefined) continue;
      if (isScalar(item.value)) {
        const existing = item.value.value;
        const existingStr = typeof existing === 'string' ? existing : String(existing ?? '');
        const nextValue = preserveRangePrefix(existingStr, next);
        if (existing !== nextValue) {
          item.value.value = nextValue;
          modified = true;
        }
      } else if (item.value == null) {
        // Promote a key with no value (rare, but legal) to a plain scalar.
        item.value = new Scalar(next) as unknown as typeof item.value;
        modified = true;
      }
      // Non-scalar values (nested maps/sequences) are left alone — outside scope.
    }
  }
  return modified;
}

/**
 * Re-apply the leading `^` or `~` range prefix from `existing` to `next` when
 * `next` is a bare concrete semver. This preserves the existing range style
 * of a catalog entry across version bumps (e.g. `^1.2.3` bumped to `1.2.4`
 * is written back as `^1.2.4`, not pinned to `1.2.4`).
 *
 * Pass-through cases:
 * - `next` already starts with a range operator (`^`, `~`, `>`, `<`, `=`).
 * - `existing` has no recognized `^`/`~` prefix.
 */
function preserveRangePrefix(existing: string, next: string): string {
  if (!next) return next;
  const first = next[0];
  if (first === '^' || first === '~' || first === '>' || first === '<' || first === '=') {
    return next;
  }
  const existingPrefix = existing[0];
  if (existingPrefix !== '^' && existingPrefix !== '~') return next;
  return `${existingPrefix}${next}`;
}

/**
 * Apply catalog version updates to the workspace yaml text.
 * `updates` maps package name -> concrete version.
 */
export function applyCatalogUpdates(yaml: string, updates: ReadonlyMap<string, string>): string {
  if (updates.size === 0) return yaml;
  const doc = tryParse(yaml);
  if (!doc) return yaml;
  if (!applyCatalogUpdatesToDoc(doc, updates)) return yaml;
  return serializeDoc(doc, yaml);
}

/**
 * Stringify `doc` while restoring the original document's EOL convention.
 * `yaml@2` always emits LF; we re-insert CRLF when the source used it.
 */
export function serializeDoc(doc: Doc, original: string): string {
  const out = doc.toString({ lineWidth: 0 });
  if (original.includes('\r\n') && !out.includes('\r\n')) {
    return out.replace(/\n/g, '\r\n');
  }
  return out;
}

/** Re-export `parseDocument` wrapper for callers that need a parsed doc. */
export function parseWorkspaceDoc(yaml: string): Doc | null {
  return tryParse(yaml);
}

/** Collapse 3+ consecutive newlines down to a single blank line. */
export function collapseBlankLines(text: string): string {
  return text.replace(/(\r?\n){3,}/g, (_m) => {
    const eol = _m.includes('\r\n') ? '\r\n' : '\n';
    return eol + eol;
  });
}
