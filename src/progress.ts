import type { Logger } from './logger.js';

/**
 * Wrap a logger so its `step()` emits numbered progress lines like
 * `Step 3/11 — Install dependencies`. All other methods pass through.
 */
export function createProgressLogger(logger: Logger, totalSteps: number): Logger {
  let current = 0;
  return {
    ...logger,
    step(message: string): void {
      current += 1;
      logger.step(`Step ${current}/${totalSteps} — ${message}`);
    },
  };
}
