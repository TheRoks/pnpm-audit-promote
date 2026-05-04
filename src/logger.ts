import pc from 'picocolors';

export type LogLevel = 'silent' | 'quiet' | 'normal' | 'verbose';

export interface Logger {
  step(message: string): void;
  detail(message: string): void;
  /** True when detail/progress messages should be visible. */
  showsDetails?(): boolean;
  /** Verbose-only diagnostic line (for subprocess command tracing, etc.). */
  trace?(message: string): void;
  /** True when verbose diagnostics are enabled. */
  isVerbose?(): boolean;
  /** A bullet under a `detail` group. Quiet-suppressed like `detail`. */
  bullet(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  success(message: string): void;
  raw(message: string): void;
}

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  /** Defaults to `console.log`. Override to capture output in tests. */
  out?: (line: string) => void;
  /** Defaults to `console.error`. Override to capture output in tests. */
  err?: (line: string) => void;
  /** Disable ANSI colors. */
  color?: boolean;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  quiet: 1,
  normal: 2,
  verbose: 3,
};

export function createLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'normal';
  const out = options.out ?? ((line: string): void => console.log(line));
  const err = options.err ?? ((line: string): void => console.error(line));
  const rank = LEVEL_RANK[level];
  const color = options.color ?? true;
  const c = (fn: (s: string) => string, s: string): string => (color ? fn(s) : s);

  return {
    step(message): void {
      if (rank < LEVEL_RANK.normal) return;
      out('');
      out(c(pc.cyan, `==> ${message}`));
    },
    detail(message): void {
      if (rank < LEVEL_RANK.normal) return;
      out(c(pc.gray, `    ${message}`));
    },
    showsDetails(): boolean {
      return rank >= LEVEL_RANK.normal;
    },
    trace(message): void {
      if (rank < LEVEL_RANK.verbose) return;
      out(c(pc.gray, `      ${message}`));
    },
    isVerbose(): boolean {
      return rank >= LEVEL_RANK.verbose;
    },
    bullet(message): void {
      if (rank < LEVEL_RANK.normal) return;
      out(c(pc.gray, `      ${message}`));
    },
    warn(message): void {
      if (rank < LEVEL_RANK.quiet) return;
      err(c(pc.yellow, `    Warning: ${message}`));
    },
    info(message): void {
      if (rank < LEVEL_RANK.quiet) return;
      out(c(pc.yellow, message));
    },
    success(message): void {
      if (rank < LEVEL_RANK.quiet) return;
      out(c(pc.green, message));
    },
    raw(message): void {
      if (rank < LEVEL_RANK.normal) return;
      out(message);
    },
  };
}

/** Returns true when a logger should emit verbose diagnostics. */
export function isVerboseLoggingEnabled(logger: Logger): boolean {
  return logger.isVerbose?.() ?? false;
}

/** Returns true when detail/progress logging should be emitted. */
export function isDetailLoggingEnabled(logger: Logger): boolean {
  return logger.showsDetails?.() ?? true;
}

/** Default logger instance at `normal` level. Kept for backwards compatibility. */
export const consoleLogger: Logger = createLogger();

/** A logger that discards all output. Useful for tests and programmatic use. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
