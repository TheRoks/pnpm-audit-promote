import type { Logger } from '../logger';
import type { PnpmRunner } from '../pnpm';
import type { ConfirmFn } from '../prompt';
import type {
  AdvisorySummary,
  AuditStatus,
  CatalogChange,
  OverrideChange,
  RunSummaryData,
} from '../summary/types';

export interface RefreshOptions {
  /** Workspace root containing pnpm-workspace.yaml. */
  path: string;
  /** Skip the destructive-action confirmation prompt. */
  force?: boolean;
  /** Custom logger; defaults to a colored console logger at `normal` level. */
  logger?: Logger;
  /**
   * Inject a custom pnpm runner. Defaults to one that shells out to the real
   * `pnpm` binary on PATH. Useful for tests and advanced integrations.
   */
  pnpm?: PnpmRunner;
  /**
   * Inject a custom destructive-action confirmation function. Defaults to a
   * stdin-readline prompt; tests can pass a deterministic stub instead of
   * mutating `process.stdin.isTTY`.
   */
  confirm?: ConfirmFn;
  /** When true, plan and log changes without writing files or invoking pnpm. */
  dryRun?: boolean;
  /** Skip the audit + catalog promotion phase. */
  skipAudit?: boolean;
  /** Select pnpm's audit fix strategy; override mode is the default. */
  auditFixMode?: AuditFixMode;
  /** Skip `pnpm dedupe` calls. */
  skipDedupe?: boolean;
  /**
   * When false, the pre-audit catalog bump skips packages whose only
   * non-vulnerable upgrade crosses a major version boundary (and logs a
   * warning). Defaults to true.
   */
  allowMajor?: boolean;
  /**
   * When false, skip the post-audit release-age guard that drops overrides
   * pinning a version too fresh to satisfy the user's `minimumReleaseAge`
   * gate. Defaults to true. Disable for fully offline runs where registry
   * publish times cannot be fetched.
   */
  releaseAgeCheck?: boolean;
  /**
   * When true (default), prints a terminal-pretty summary at the end
   * describing direct/transitive package changes and resolved CVEs.
   * A plain-text (no ANSI) copy is also written to `summaryFile` when
   * provided.
   */
  summary?: boolean;
  /** Optional path to also write the plain-text summary to. */
  summaryFile?: string;
  /**
   * When true, treat `path` as the workspace root even if an enclosing
   * `pnpm-workspace.yaml` exists in a parent directory, and forward
   * `--ignore-workspace` to every pnpm invocation so pnpm does not walk up
   * to that parent. Without this flag, an enclosing workspace causes
   * `EnclosingWorkspaceError` to be thrown.
   */
  ignoreWorkspace?: boolean;
}

export type AuditFixMode = 'override' | 'update';

/**
 * Outcome of a {@link refreshDeps} invocation. Programmatic callers can
 * inspect this to decide what changed without parsing log output.
 */
export interface RefreshResult {
  /** True when the user (or the non-interactive guard) declined to proceed. */
  canceled: boolean;
  /** Total wall-clock time spent in `refreshDeps`. */
  durationMs: number;
  /** Final audit verification status. Always set on library-produced results. */
  auditStatus?: AuditStatus;
  /** Direct-dependency catalog version changes. Empty when nothing changed. */
  catalogChanges: readonly CatalogChange[];
  /** Transitive overrides added or modified by `pnpm audit --fix`. */
  overrideChanges: readonly OverrideChange[];
  /** Vulnerabilities present at the start of the run. */
  initialAdvisories: readonly AdvisorySummary[];
  /** Vulnerabilities still present after the run (best-effort). */
  finalAdvisories: readonly AdvisorySummary[];
  /** Advisories cleared during the run (initial \\ final, by id). */
  fixedAdvisories: readonly AdvisorySummary[];
  /**
   * Full computed run summary. Always populated on a successful run
   * (regardless of the `summary` rendering flag). `null` only when the
   * run was canceled before any work began.
   */
  summary: RunSummaryData | null;
}
