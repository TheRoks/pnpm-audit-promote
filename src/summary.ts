/**
 * Barrel re-exports for the run-summary subsystem. New code should
 * import directly from the focused modules under `./summary/`.
 */
export type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  RunSummaryData,
  Severity,
} from './summary/types.js';
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
} from './summary/collect.js';
export { renderTerminalSummary, type RenderOptions } from './summary/render.js';
