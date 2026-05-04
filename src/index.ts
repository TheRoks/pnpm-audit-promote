export { refreshDeps, type RefreshOptions, type RefreshResult } from './refresh.js';
export type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  RunSummaryData,
  Severity,
} from './summary/types.js';
export { renderTerminalSummary, type RenderOptions } from './summary/render.js';
export type { ConfirmContext, ConfirmFn } from './prompt.js';
export {
  NonInteractiveConfirmationError,
  PnpmCommandFailedError,
  PnpmNotInstalledError,
  WorkspaceNotFoundError,
} from './errors.js';
export type { Logger, LogLevel, ConsoleLoggerOptions } from './logger.js';
export { consoleLogger, silentLogger, createLogger } from './logger.js';
export { WorkspaceState } from './workspace.js';
export {
  createPnpmRunner,
  ensurePnpmAvailable,
  type PnpmRunner,
  type PnpmOptions,
} from './pnpm.js';
import pkg from '../package.json' with { type: 'json' };
export const PKG_VERSION: string = pkg.version;
