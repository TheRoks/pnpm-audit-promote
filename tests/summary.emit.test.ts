import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger';
import { renderRunSummary } from '../src/summary/emit';
import type { RunSummaryData } from '../src/summary';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-summary-emit-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeLogger(): Logger {
  return {
    step() {},
    detail() {},
    trace() {},
    bullet() {},
    warn() {},
    info() {},
    success() {},
    raw() {},
    isVerbose() {
      return false;
    },
    showsDetails() {
      return true;
    },
  };
}

function makeSummary(overrides: Partial<RunSummaryData> = {}): RunSummaryData {
  return {
    workspaceRoot: tmp,
    workspaceName: 'fixture',
    toolVersion: '1.0.0',
    durationMs: 1_000,
    dryRun: false,
    auditSkipped: false,
    originalCatalog: new Map(),
    finalCatalog: new Map(),
    originalOverrides: new Map(),
    finalOverrides: new Map(),
    initialAdvisories: [],
    finalAdvisories: [],
    pkgJsonDepChanges: [],
    ...overrides,
  };
}

describe('renderRunSummary summary file writes', () => {
  it('REQ-SUMMARY-003: writes summary file for valid in-workspace path', () => {
    const summaryPath = path.join(tmp, 'reports', 'run-summary.txt');
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

    const detail = vi.fn();
    renderRunSummary(makeSummary(), {
      logger: { ...makeLogger(), detail },
      summaryFile: summaryPath,
      dryRun: false,
    });

    expect(fs.existsSync(summaryPath)).toBe(true);
    expect(detail).toHaveBeenCalledWith(`Wrote run summary to ${summaryPath}.`);
  });

  it('REQ-SUMMARY-004: rejects path traversal outside workspace root', () => {
    const outside = path.resolve(tmp, '..', 'outside-summary.txt');
    const warn = vi.fn();

    renderRunSummary(makeSummary(), {
      logger: { ...makeLogger(), warn },
      summaryFile: outside,
      dryRun: false,
    });

    expect(fs.existsSync(outside)).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('outside workspace root');
  });

  it('REQ-SUMMARY-004: rejects directory targets', () => {
    const warn = vi.fn();

    renderRunSummary(makeSummary(), {
      logger: { ...makeLogger(), warn },
      summaryFile: tmp,
      dryRun: false,
    });

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('points to a directory');
  });

  it('REQ-SUMMARY-005: does not write summary file during dry-run', () => {
    const summaryPath = path.join(tmp, 'dry-run-summary.txt');

    renderRunSummary(makeSummary(), {
      logger: makeLogger(),
      summaryFile: summaryPath,
      dryRun: true,
    });

    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it('REQ-SUMMARY-007: warns and continues when summary path is invalid', () => {
    const outside = path.resolve(tmp, '..', 'invalid-summary.txt');
    const warn = vi.fn();

    expect(() => {
      renderRunSummary(makeSummary(), {
        logger: { ...makeLogger(), warn },
        summaryFile: outside,
        dryRun: false,
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalled();
  });
});

describe('REQ-LOGGING-005: terminal color follows TTY detection', () => {
  // Match ANSI escape sequences via a dynamically built RegExp to avoid the
  // no-control-regex lint rule (which also checks RegExp constructor strings).
  const ansiPattern = new RegExp(String.fromCharCode(27) + '\\[');

  it('REQ-LOGGING-005: colored terminal output is suppressed when stdout is not a TTY', () => {
    const raw = vi.fn();
    // Simulate non-TTY environment (e.g. CI pipe)
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      renderRunSummary(makeSummary(), { logger: { ...makeLogger(), raw }, dryRun: false });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
    const output = raw.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    // No ANSI escape sequences should be present when not a TTY
    expect(output).not.toMatch(ansiPattern);
  });

  it('REQ-LOGGING-005: colored terminal output is emitted when stdout is a TTY', () => {
    const raw = vi.fn();
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      renderRunSummary(makeSummary({ initialAdvisories: [], finalAdvisories: [] }), {
        logger: { ...makeLogger(), raw },
        dryRun: false,
      });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
    const output = raw.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    // ANSI escape sequences should be present when a TTY is attached
    expect(output).toMatch(ansiPattern);
  });
});
