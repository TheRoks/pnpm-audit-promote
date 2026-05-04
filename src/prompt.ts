import * as readline from 'node:readline';
import { NonInteractiveConfirmationError } from './errors.js';

export interface ConfirmContext {
  /** When true, the prompt should auto-resolve to true. */
  force: boolean;
  /** When true (dry-run), no destructive action will run; auto-resolve to true. */
  dryRun: boolean;
}

export type ConfirmFn = (ctx: ConfirmContext) => Promise<boolean>;

/**
 * Default implementation: returns true when `--force` or `--dry-run` is set,
 * throws when stdin is not a TTY (non-interactive without `--force`),
 * otherwise prompts on stdin with a y/N question.
 */
export const defaultConfirmDestructive: ConfirmFn = async ({ force, dryRun }) => {
  if (force || dryRun) return true;

  if (!process.stdin.isTTY) {
    throw new NonInteractiveConfirmationError();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      'This will delete pnpm-lock.yaml, every node_modules, and all overrides in pnpm-workspace.yaml. Continue? [y/N] ',
      (a) => resolve(a),
    );
  });
  rl.close();
  return /^(y|yes)$/i.test(answer.trim());
};
