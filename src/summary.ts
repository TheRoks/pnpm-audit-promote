/**
 * Barrel re-exports for the run-summary subsystem. New code should
 * import directly from the focused modules under `./summary/`.
 */
export type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  PackageJsonDepChange,
  RunSummaryData,
  Severity,
} from './summary/types';
export {
  bumpTier,
  diffAdvisories,
  diffCatalog,
  diffOverrides,
  extractAdvisories,
  readAllOverrides,
  readCatalogSnapshot,
  readPackageJsonOverrides,
  readWorkspaceOverrides,
  safeReadFile,
} from './summary/collect';
export { renderTerminalSummary, type RenderOptions } from './summary/render';
