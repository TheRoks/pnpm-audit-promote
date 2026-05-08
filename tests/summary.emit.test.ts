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
  it('writes summary file for valid in-workspace path', () => {
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

  it('rejects path traversal outside workspace root', () => {
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

  it('rejects directory targets', () => {
    const warn = vi.fn();

    renderRunSummary(makeSummary(), {
      logger: { ...makeLogger(), warn },
      summaryFile: tmp,
      dryRun: false,
    });

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('points to a directory');
  });

  it('does not write summary file during dry-run', () => {
    const summaryPath = path.join(tmp, 'dry-run-summary.txt');

    renderRunSummary(makeSummary(), {
      logger: makeLogger(),
      summaryFile: summaryPath,
      dryRun: true,
    });

    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it('warns and continues when summary path is invalid', () => {
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
