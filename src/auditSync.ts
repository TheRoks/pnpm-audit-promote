/**
 * @module auditSync
 *
 * Backwards-compatible barrel that re-exports the audit-promotion API from
 * the focused modules under `./audit/`. New code should import directly from
 * the submodules.
 */
export {
  getDirectDepCatalogBumps,
  type DirectDepBumpOptions,
  type DirectDepBumpResult,
} from './audit/parseAdvisories.js';
export { syncAuditOverridesIntoCatalog } from './audit/promoteWorkspaceOverrides.js';
export { syncPackageJsonOverridesIntoCatalog } from './audit/promotePackageJsonOverrides.js';
