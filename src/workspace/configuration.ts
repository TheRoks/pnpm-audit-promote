import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Logger } from '../logger';
import type { PnpmCapabilities } from '../pnpmCapabilities';
import { WorkspaceReadError } from '../errors';
import { applyCatalogUpdates, readCatalog } from '../catalog';
import type { WorkspaceMutations } from './mutations';
import { WorkspaceYamlSnapshot } from './yamlSnapshot';
import { getBarePackageName, normalizeRange } from '../semverUtil';

type ConfigMap = Record<string, unknown>;
type OwnerKind = 'root' | 'local' | 'configDependency';

interface ConfigSource {
  name: string;
  kind: OwnerKind;
  snapshot?: WorkspaceYamlSnapshot;
  content: string;
  config?: ConfigMap;
  settings: '*' | string[];
}

/**
 * Resolves pnpm 12.15 workspace setting ownership and keeps local YAML
 * sources in the same per-run snapshot/recovery lifecycle as the root file.
 * Callers ask for an owner or an effective read; writes remain explicit and
 * are routed to that owner's snapshot.
 */
export class WorkspaceConfiguration {
  readonly root: string;
  readonly rootYaml: WorkspaceYamlSnapshot;
  readonly mutations: WorkspaceMutations;
  private sources: ConfigSource[] = [];
  private enabled = false;

  constructor(root: string, rootYaml: WorkspaceYamlSnapshot, mutations: WorkspaceMutations) {
    this.root = path.resolve(root);
    this.rootYaml = rootYaml;
    this.mutations = mutations;
    this.sources = [
      {
        name: 'pnpm-workspace.yaml',
        kind: 'root',
        snapshot: rootYaml,
        content: rootYaml.desiredWorkspaceYaml,
        settings: [],
      },
    ];
  }

  initialize(capabilities: PnpmCapabilities): void {
    this.sources = [
      {
        name: 'pnpm-workspace.yaml',
        kind: 'root',
        snapshot: this.rootYaml,
        content: this.rootYaml.desiredWorkspaceYaml,
        settings: [],
      },
    ];
    if (!capabilities.supportsWorkspaceSettingsInclude || !this.rootYaml.hasWorkspaceYaml) return;

    let rootConfig: ConfigMap;
    try {
      rootConfig = parseConfig(this.rootYaml.readWorkspaceYaml(), this.rootYaml.path);
    } catch (error) {
      if (hasIncludeKey(this.rootYaml.readWorkspaceYaml())) throw error;
      return;
    }
    const include = rootConfig['include'];
    if (include === undefined) return;
    if (!isRecord(include)) {
      throw new Error(
        'Invalid pnpm-workspace.yaml include: expected a mapping of sources to settings.',
      );
    }

    this.enabled = true;
    const rootSource = this.sources[0]!;
    rootSource.content = this.rootYaml.readWorkspaceYaml();
    rootSource.config = rootConfig;

    for (const [sourceName, delegated] of Object.entries(include)) {
      const settings = parseDelegatedSettings(sourceName, delegated);
      if (sourceName.startsWith('./') || sourceName.startsWith('../')) {
        const sourcePath = resolveIncludedFile(this.root, sourceName);
        this.mutations.authorizeIncludedFile(sourcePath);
        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Included pnpm configuration '${sourceName}' does not exist.`);
        }
        const snapshot = new WorkspaceYamlSnapshot(sourcePath, this.mutations);
        snapshot.initialize(true, this.mutations.dryRun);
        const content = snapshot.readWorkspaceYaml();
        const config = parseConfig(content, sourcePath);
        if ('include' in config) {
          throw new Error(`Included pnpm configuration '${sourceName}' cannot define 'include'.`);
        }
        this.sources.push({ name: sourceName, kind: 'local', snapshot, content, config, settings });
      } else {
        this.sources.push({
          name: sourceName,
          kind: 'configDependency',
          content: readConfigDependency(this.root, rootConfig, sourceName),
          config: undefined,
          settings,
        });
        const dependency = this.sources[this.sources.length - 1]!;
        dependency.config = parseConfig(dependency.content, sourceName);
      }
    }

    this.validateDuplicateOwners();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  getSnapshots(): WorkspaceYamlSnapshot[] {
    return this.sources.flatMap((source) => (source.snapshot ? [source.snapshot] : []));
  }

  getIncludedFilePaths(): string[] {
    return this.sources.flatMap((source) =>
      source.kind === 'local' && source.snapshot ? [source.snapshot.path] : [],
    );
  }

  readEffectiveYaml(): string {
    if (!this.enabled)
      return this.rootYaml.desiredWorkspaceYaml || this.rootYaml.readWorkspaceYaml();
    const effective: ConfigMap = {};
    const catalogs: ConfigMap = {};
    for (const source of this.sources) {
      if (source.snapshot) source.content = source.snapshot.readWorkspaceYaml();
      source.config = parseConfig(source.content, source.name);
      const config = source.config;
      for (const [key, value] of Object.entries(config)) {
        if (key === 'include' || key === 'catalog' || key === 'catalogs') continue;
        effective[key] =
          key === 'packages'
            ? normalizePackageGlobs(
                value,
                source.snapshot ? path.dirname(source.snapshot.path) : this.root,
                this.root,
              )
            : value;
      }
      const defaultCatalog = asRecord(config['catalog']);
      if (defaultCatalog) {
        const current = asRecord(catalogs['default']) ?? {};
        Object.assign(current, defaultCatalog);
        catalogs['default'] = current;
      }
      const named = asRecord(config['catalogs']);
      if (named) {
        for (const [name, entries] of Object.entries(named)) {
          const current = asRecord(catalogs[name]) ?? {};
          Object.assign(current, asRecord(entries) ?? {});
          catalogs[name] = current;
        }
      }
    }

    if (Object.hasOwn(catalogs, 'default')) {
      effective['catalog'] = catalogs['default'];
      delete catalogs['default'];
    }
    if (Object.keys(catalogs).length > 0) effective['catalogs'] = catalogs;
    return stringifyYaml(effective, { lineWidth: 0 });
  }

  /** Compatibility with consumers that treat configuration as one YAML view. */
  readWorkspaceYaml(): string {
    return this.readEffectiveYaml();
  }

  readEffectiveSetting(setting: string): unknown {
    return this.readEffectiveConfig()[setting];
  }

  readCatalog(): ReturnType<typeof readCatalog> {
    return readCatalog(this.readEffectiveYaml());
  }

  getOwnerSnapshot(setting: string): WorkspaceYamlSnapshot | null {
    const owner = this.findSettingOwner(setting);
    if (owner.kind === 'configDependency') return null;
    return owner.snapshot ?? this.rootYaml;
  }

  getOwnerKind(setting: string): OwnerKind {
    return this.findSettingOwner(setting).kind;
  }

  getConfigDependencyOwnedSettings(): string[] {
    return this.sources.flatMap((source) => {
      if (source.kind !== 'configDependency') return [];
      return source.settings === '*' ? Object.keys(source.config ?? {}) : source.settings;
    });
  }

  updateCatalogs(updates: ReadonlyMap<string, string>): void {
    if (updates.size === 0) return;
    const bySource = new Map<ConfigSource, Map<string, string>>();
    const catalogSources = this.sources.filter((source) => {
      if (source.snapshot) source.content = source.snapshot.readWorkspaceYaml();
      source.config = parseConfig(source.content, source.name);
      return true;
    });
    const existingNames = new Set<string>();
    for (const source of catalogSources) {
      const catalogs = readCatalog(source.content);
      for (const name of catalogs.names) existingNames.add(name);
    }

    for (const [name, version] of updates) {
      if (!existingNames.has(name)) continue;
      for (const source of catalogSources) {
        const content = source.snapshot?.readWorkspaceYaml() ?? source.content;
        const names = readCatalog(content).names;
        if (!names.has(name)) continue;
        const owner = this.findCatalogOwner(name, source);
        if (owner.kind === 'configDependency') {
          throw new Error(
            `Cannot update catalog entry '${name}': pnpm setting owner '${owner.name}' is a config dependency and is read-only. Move the catalog to a local YAML file or update the config dependency.`,
          );
        }
        const grouped = bySource.get(owner) ?? new Map<string, string>();
        grouped.set(name, version);
        bySource.set(owner, grouped);
      }
    }

    for (const [source, sourceUpdates] of bySource) {
      const snapshot = source.snapshot ?? this.rootYaml;
      const current = snapshot.readWorkspaceYaml();
      snapshot.writeDesiredWorkspaceYaml(applyCatalogUpdates(current, sourceUpdates));
    }
  }

  reconcileAfterAuditRead(capabilities: PnpmCapabilities, logger: Logger): void {
    for (const snapshot of this.getSnapshots()) {
      if (snapshot !== this.rootYaml && snapshot.refreshHasWorkspaceYaml()) {
        logger.detail(`Detected included pnpm configuration updated by pnpm: ${snapshot.path}.`);
      }
      snapshot.preserveAuditIgnorePrune(capabilities, logger);
      snapshot.restoreWorkspaceYaml(logger);
    }
  }

  preserveApprovedBuilds(logger: Logger): void {
    for (const snapshot of this.getSnapshots()) snapshot.preserveApprovedBuilds(logger);
  }

  resetMinimumReleaseAgeExclude(logger: Logger): void {
    for (const snapshot of this.getSnapshots()) snapshot.resetMinimumReleaseAgeExclude(logger);
  }

  refreshRootWorkspaceYaml(logger: Logger, command: string): boolean {
    const refreshed = this.rootYaml.refreshHasWorkspaceYaml();
    if (refreshed) logger.detail(`Detected pnpm-workspace.yaml created by ${command}.`);
    return refreshed;
  }

  restoreWorkspaceYaml(logger: Logger): boolean {
    let restored = false;
    for (const snapshot of this.getSnapshots())
      restored = snapshot.restoreWorkspaceYaml(logger) || restored;
    return restored;
  }

  restoreInitialFiles(
    snapshot: ReadonlyMap<string, string | null>,
    logger: Logger,
  ): { restored: string[]; failed: Array<{ path: string; error: unknown }> } {
    const restored: string[] = [];
    const failed: Array<{ path: string; error: unknown }> = [];
    for (const yamlSnapshot of this.getSnapshots()) {
      if (!snapshot.has(yamlSnapshot.path)) continue;
      try {
        yamlSnapshot.restoreInitialWorkspaceYaml(snapshot.get(yamlSnapshot.path) ?? null, logger);
        restored.push(yamlSnapshot.path);
      } catch (error) {
        failed.push({ path: yamlSnapshot.path, error });
      }
    }
    return { restored, failed };
  }

  assertAuditSettingsWritable(
    advisories: readonly { module_name?: string; vulnerable_versions?: string }[],
    originalCatalog: ReadonlyMap<string, string>,
    auditKnown: boolean,
    originalOverrides: ReadonlyMap<
      string,
      { value: string; source: 'workspace' | 'package.json' }
    > = new Map(),
  ): void {
    if (!this.enabled) return;
    const owned = new Map<string, string>();
    for (const source of this.sources) {
      if (source.kind !== 'configDependency') continue;
      if (source.settings === '*') {
        for (const key of Object.keys(source.config ?? {})) owned.set(key, source.name);
      } else {
        for (const key of source.settings) owned.set(key, source.name);
      }
    }
    if (owned.has('overrides') && (!auditKnown || advisories.length > 0)) {
      throw new Error(
        `Cannot run audit fixes: pnpm setting 'overrides' is owned by config dependency '${owned.get('overrides')}' and cannot be changed. Move 'overrides' to a local YAML file or update the config dependency before running this tool.`,
      );
    }
    const catalogModules = new Set(
      advisories
        .filter((advisory) =>
          catalogVersionIsAffected(
            originalCatalog.get(advisory.module_name ?? ''),
            advisory.vulnerable_versions,
          ),
        )
        .map((advisory) => advisory.module_name ?? '')
        .filter((name) => originalCatalog.has(name)),
    );
    // Cleanup removes all existing overrides after this check. If an override
    // permits versions outside a catalog's range, it may be the only reason a
    // vulnerable catalog version is absent from the initial audit.
    for (const [selector, override] of originalOverrides) {
      const packageName = getBarePackageName(selector);
      const catalogVersion = originalCatalog.get(packageName);
      if (
        catalogVersion === undefined ||
        catalogRangeContainsOverride(catalogVersion, override.value)
      )
        continue;
      catalogModules.add(packageName);
    }
    if (catalogModules.size > 0 || !auditKnown) {
      const configDependencyCatalog = this.sources.find(
        (source) =>
          source.kind === 'configDependency' &&
          allowsCatalogSetting(source.settings) &&
          (!auditKnown ||
            [...readCatalog(source.content).names].some((name) => catalogModules.has(name))),
      );
      if (configDependencyCatalog) {
        throw new Error(
          `Cannot run audit fixes: pnpm catalog settings are owned by config dependency '${configDependencyCatalog.name}' and a catalog entry may need updating. Move the catalog to a local YAML file or update the config dependency before running this tool.`,
        );
      }
    }
  }

  private readEffectiveConfig(): ConfigMap {
    let parsed: unknown;
    try {
      parsed = parseYaml(this.readEffectiveYaml());
    } catch {
      return {};
    }
    return asRecord(parsed) ?? {};
  }

  private findSettingOwner(setting: string): ConfigSource {
    const matches = this.sources.filter((source) =>
      source.settings === '*'
        ? Object.hasOwn(source.config ?? {}, setting)
        : source.settings.includes(setting),
    );
    if (matches.length > 1) {
      throw new Error(
        `pnpm setting '${setting}' has multiple owners in the workspace include map.`,
      );
    }
    return matches[0] ?? this.sources[0]!;
  }

  private findCatalogOwner(name: string, fallback: ConfigSource): ConfigSource {
    const catalogName = findCatalogName(fallback.config ?? {}, name);
    const key = catalogName === 'default' ? 'catalog' : `catalogs.${catalogName}`;
    const matches = this.sources.filter((source) => {
      if (source.settings === '*') return hasCatalog(source.config ?? {}, catalogName);
      return (
        source.settings.includes('catalogs') ||
        source.settings.includes(key) ||
        (catalogName === 'default' && source.settings.includes('catalogs.default'))
      );
    });
    if (matches.length > 1) {
      throw new Error(
        `pnpm catalog '${catalogName}' has multiple owners in the workspace include map.`,
      );
    }
    return matches[0] ?? this.sources[0]!;
  }

  private validateDuplicateOwners(): void {
    const rootConfig = this.sources[0]?.config ?? {};
    const rootClaims = new Set(getDefinedSettings(rootConfig));
    const claimed: Array<{ setting: string; source: string }> = [];
    for (const source of this.sources.slice(1)) {
      const settings =
        source.settings === '*'
          ? getDefinedSettings(source.config ?? {})
          : source.settings.map(normalizeCatalogSetting);
      for (const setting of settings) {
        if ([...rootClaims].some((rootSetting) => settingClaimOverlaps(setting, rootSetting))) {
          throw new Error(
            `pnpm setting '${setting}' is defined in pnpm-workspace.yaml and delegated to '${source.name}'.`,
          );
        }
        const previous = claimed.find((claim) => settingClaimOverlaps(setting, claim.setting));
        if (previous) {
          throw new Error(
            `pnpm setting '${setting}' is delegated to both '${previous.source}' and '${source.name}'.`,
          );
        }
        claimed.push({ setting, source: source.name });
      }
    }
  }
}

function catalogRangeContainsOverride(catalogSpec: string, overrideSpec: string): boolean {
  if (catalogSpec === overrideSpec) return true;
  const catalogRange = semver.validRange(catalogSpec);
  const overrideRange = semver.validRange(overrideSpec);
  return (
    catalogRange !== null && overrideRange !== null && semver.subset(overrideRange, catalogRange)
  );
}

function normalizeCatalogSetting(setting: string): string {
  return setting === 'catalog'
    ? 'catalogs.default'
    : setting === 'catalogs'
      ? 'catalogs.*'
      : setting;
}

function getDefinedSettings(config: ConfigMap): string[] {
  const settings = Object.keys(config).filter(
    (setting) => setting !== 'catalog' && setting !== 'catalogs',
  );
  if (asRecord(config['catalog'])) settings.push('catalogs.default');
  const catalogs = asRecord(config['catalogs']);
  if (catalogs) settings.push(...Object.keys(catalogs).map((name) => `catalogs.${name}`));
  return settings;
}

function settingClaimOverlaps(left: string, right: string): boolean {
  return (
    left === right ||
    (left === 'catalogs.*' && right.startsWith('catalogs.')) ||
    (right === 'catalogs.*' && left.startsWith('catalogs.'))
  );
}

function parseDelegatedSettings(source: string, value: unknown): '*' | string[] {
  if (value === '*' && (source.startsWith('./') || source.startsWith('../'))) return '*';
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid pnpm include entry '${source}': expected '*' or a list of settings.`);
  }
  return value as string[];
}

function resolveIncludedFile(root: string, source: string): string {
  if (!source.startsWith('./') && !source.startsWith('../')) {
    throw new Error(
      `Invalid included pnpm configuration path '${source}': expected './' or '../'.`,
    );
  }
  if (
    ['?', '*', '{', '}', '[', ']'].some((character) => source.includes(character)) ||
    source.includes('\\') ||
    path.isAbsolute(source)
  ) {
    throw new Error(
      `Invalid included pnpm configuration path '${source}': expected a literal relative file path.`,
    );
  }
  if (!/\.ya?ml$/i.test(source)) {
    throw new Error(
      `Invalid included pnpm configuration path '${source}': expected a .yaml or .yml file.`,
    );
  }
  return path.resolve(root, source);
}

function readConfigDependency(root: string, rootConfig: ConfigMap, name: string): string {
  const dependencies = asRecord(rootConfig['configDependencies']);
  if (!dependencies || !Object.hasOwn(dependencies, name)) {
    throw new Error(`pnpm include source '${name}' is not declared in configDependencies.`);
  }
  const packagePath = path.join(root, 'node_modules', ...name.split('/'));
  const packageJson = path.join(packagePath, 'package.json');
  let packageConfig: unknown;
  try {
    packageConfig = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read included config dependency '${name}' at '${packageJson}'.`, {
      cause: error,
    });
  }
  const configPath = asRecord(asRecord(packageConfig)?.['pnpm'])?.['config'];
  if (typeof configPath !== 'string' || !configPath.trim()) {
    throw new Error(`Config dependency '${name}' does not declare a pnpm.config YAML path.`);
  }
  const packageRoot = fs.realpathSync(packagePath);
  const resolvedConfigPath = path.resolve(packagePath, configPath);
  let realConfigPath: string;
  try {
    realConfigPath = fs.realpathSync(resolvedConfigPath);
  } catch (error) {
    throw new Error(`Could not read config file for dependency '${name}'.`, { cause: error });
  }
  const relative = path.relative(packageRoot, realConfigPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Config dependency '${name}' points outside its package directory.`);
  }
  try {
    return fs.readFileSync(realConfigPath, 'utf8');
  } catch (error) {
    throw new WorkspaceReadError(realConfigPath, error);
  }
}

function parseConfig(text: string, name: string): ConfigMap {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(`Could not parse pnpm configuration '${name}'.`, { cause: error });
  }
  if (parsed === null) return {};
  if (!isRecord(parsed))
    throw new Error(`pnpm configuration '${name}' must contain a YAML mapping.`);
  return parsed;
}

function hasIncludeKey(text: string): boolean {
  try {
    return Object.hasOwn(asRecord(parseYaml(text)) ?? {}, 'include');
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is ConfigMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): ConfigMap | null {
  return isRecord(value) ? value : null;
}

function findCatalogName(config: ConfigMap, packageName: string): string {
  const defaultCatalog = asRecord(config['catalog']);
  if (defaultCatalog && Object.hasOwn(defaultCatalog, packageName)) return 'default';
  const catalogs = asRecord(config['catalogs']);
  if (catalogs) {
    for (const [name, entries] of Object.entries(catalogs)) {
      if (Object.hasOwn(asRecord(entries) ?? {}, packageName)) return name;
    }
  }
  return 'default';
}

function hasCatalog(config: ConfigMap, name: string): boolean {
  if (name === 'default') {
    return (
      asRecord(config['catalog']) !== null ||
      Object.hasOwn(asRecord(config['catalogs']) ?? {}, 'default')
    );
  }
  return Object.hasOwn(asRecord(config['catalogs']) ?? {}, name);
}

function allowsCatalogSetting(settings: '*' | string[]): boolean {
  return (
    settings === '*' ||
    settings.some((setting) => setting === 'catalog' || setting.startsWith('catalogs'))
  );
}

function normalizePackageGlobs(value: unknown, baseDir: string, workspaceRoot: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const negated = entry.startsWith('!');
    const pattern = negated ? entry.slice(1) : entry;
    const absolute = path.resolve(baseDir, pattern);
    let relative = path.relative(workspaceRoot, absolute).split(path.sep).join('/');
    if (!relative) relative = '.';
    return `${negated ? '!' : ''}${relative}`;
  });
}

function catalogVersionIsAffected(
  current: string | undefined,
  vulnerableRange: string | undefined,
): boolean {
  if (!current || !vulnerableRange?.trim()) return true;
  const currentVersion = semver.coerce(current)?.version;
  const range = normalizeRange(vulnerableRange);
  return !currentVersion || !range || semver.satisfies(currentVersion, range);
}
