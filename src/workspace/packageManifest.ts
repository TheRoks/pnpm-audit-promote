import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import {
  isMap,
  parseDocument,
  parse as parseYaml,
  stringify as stringifyYaml,
  type Document,
  type ParsedNode,
} from 'yaml';
import { findWorkspaceFiles } from '../fsWalk';
import { removeJsonProperty, setJsonProperty } from '../jsonEdit';
import { serializeDoc } from '../workspaceYaml';

export type PackageManifestFormat = 'json' | 'json5' | 'yaml';

export interface PackageManifest {
  path: string;
  format: PackageManifestFormat;
}

const MANIFEST_NAMES = ['package.json', 'package.json5', 'package.yaml'] as const;

/** pnpm chooses the first existing manifest in this order. */
export function findPackageManifest(packageDir: string): PackageManifest | null {
  for (const name of MANIFEST_NAMES) {
    const manifestPath = path.join(packageDir, name);
    if (!fs.existsSync(manifestPath)) continue;
    return { path: manifestPath, format: formatForPath(manifestPath) };
  }
  return null;
}

/** Find one effective package manifest per selected workspace package. */
export function findWorkspacePackageManifests(
  workspaceRoot: string,
  packageDirs: ReadonlySet<string> | null,
): PackageManifest[] {
  const dirs = new Set<string>();
  for (const name of MANIFEST_NAMES) {
    for (const filePath of findWorkspaceFiles(workspaceRoot, name))
      dirs.add(path.dirname(filePath));
  }
  const selected: PackageManifest[] = [];
  for (const dir of dirs) {
    if (packageDirs && !packageDirs.has(dir)) continue;
    const manifest = findPackageManifest(dir);
    if (manifest) selected.push(manifest);
  }
  selected.sort((a, b) => a.path.localeCompare(b.path));
  return selected;
}

export function formatForPath(filePath: string): PackageManifestFormat {
  if (filePath.endsWith('.json5')) return 'json5';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  return 'json';
}

export function readPackageManifest(text: string, format: PackageManifestFormat): unknown {
  if (format === 'json') return JSON.parse(text) as unknown;
  if (format === 'json5') return JSON5.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

export function serializePackageManifest(
  value: unknown,
  format: PackageManifestFormat,
  original = '',
): string {
  if (format === 'yaml') return stringifyYaml(value, { lineWidth: 0 });
  let serialized =
    format === 'json5' ? JSON5.stringify(value, null, 2) : JSON.stringify(value, null, 2);
  if (original.includes('\r\n')) serialized = serialized.replace(/\n/g, '\r\n');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  return `${serialized}${original.endsWith('\n') ? newline : ''}`;
}

/** Return a manifest object's fields without making parse errors fatal to discovery. */
export function readPackageManifestFile(manifestPath: string): Record<string, unknown> | null {
  try {
    const manifest = findPackageManifest(path.dirname(manifestPath));
    if (!manifest || manifest.path !== manifestPath) return null;
    const parsed = readPackageManifest(fs.readFileSync(manifestPath, 'utf8'), manifest.format);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function setManifestProperty(
  text: string,
  format: PackageManifestFormat,
  value: unknown,
  ...propertyPath: string[]
): string {
  if (propertyPath.length === 0) return text;
  if (format === 'json') return setJsonProperty(text, value, ...propertyPath);
  if (format === 'json5') {
    const parsed = JSON5.parse(text) as unknown;
    if (!isRecord(parsed)) return text;
    setNestedProperty(parsed, propertyPath, value);
    return serializePackageManifest(parsed, format, text);
  }

  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return text;
  doc.setIn(propertyPath, value);
  return serializeDoc(doc as Document.Parsed<ParsedNode, true>, text);
}

export function removeManifestProperty(
  text: string,
  format: PackageManifestFormat,
  ...propertyPath: string[]
): string {
  if (propertyPath.length === 0) return text;
  if (format === 'json') return removeJsonProperty(text, ...propertyPath);
  if (format === 'json5') {
    const parsed = JSON5.parse(text) as unknown;
    if (!isRecord(parsed) || !deleteNestedProperty(parsed, propertyPath)) return text;
    return serializePackageManifest(parsed, format, text);
  }

  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return text;
  if (!doc.hasIn(propertyPath)) return text;
  doc.deleteIn(propertyPath);
  return serializeDoc(doc as Document.Parsed<ParsedNode, true>, text);
}

export function ensureManifestNewline(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.replace(/[\s]+$/, '') + eol;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setNestedProperty(
  root: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
): void {
  let target = root;
  for (const key of keys.slice(0, -1)) {
    const current = target[key];
    if (!isRecord(current)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys[keys.length - 1]!] = value;
}

function deleteNestedProperty(root: Record<string, unknown>, keys: readonly string[]): boolean {
  let target = root;
  for (const key of keys.slice(0, -1)) {
    const current = target[key];
    if (!isRecord(current)) return false;
    target = current;
  }
  return delete target[keys[keys.length - 1]!];
}
