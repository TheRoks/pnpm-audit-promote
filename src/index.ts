export { refreshDeps, type RefreshOptions } from './refresh.js';
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
