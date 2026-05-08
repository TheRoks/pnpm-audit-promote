export { refreshDeps, type RefreshOptions, type RefreshResult } from './refresh';
export type {
  AdvisorySummary,
  CatalogChange,
  OverrideChange,
  RunSummaryData,
  Severity,
} from './summary/types';
export { renderTerminalSummary, type RenderOptions } from './summary/render';
export type { ConfirmContext, ConfirmFn } from './prompt';
export {
  EnclosingWorkspaceError,
  NonInteractiveConfirmationError,
  PnpmCommandFailedError,
  PnpmNotInstalledError,
  WorkspaceNotFoundError,
} from './errors';
export type { Logger, LogLevel, ConsoleLoggerOptions } from './logger';
export { consoleLogger, silentLogger, createLogger } from './logger';
export { WorkspaceState } from './workspace';
export { createPnpmRunner, ensurePnpmAvailable, type PnpmRunner, type PnpmOptions } from './pnpm';
import pkg from '../package.json' with { type: 'json' };
export const PKG_VERSION: string = pkg.version;
