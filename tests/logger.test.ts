import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

describe('createLogger verbosity behavior', () => {
  it('REQ-LOGGING-003: suppresses trace output at normal level', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = createLogger({
      level: 'normal',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      color: false,
    });

    logger.step('Install dependencies');
    logger.detail('Running install phase');
    logger.trace('pnpm install');
    logger.warn('Heads up');

    expect(out).toContain('');
    expect(out).toContain('==> Install dependencies');
    expect(out).toContain('    Running install phase');
    expect(out.some((line) => line.includes('pnpm install'))).toBe(false);
    expect(err).toContain('    Warning: Heads up');
    expect(logger.isVerbose()).toBe(false);
  });

  it('REQ-LOGGING-004: emits trace output at verbose level', () => {
    const out: string[] = [];
    const logger = createLogger({ level: 'verbose', out: (line) => out.push(line), color: false });

    logger.trace('pnpm install');

    expect(out).toContain('      pnpm install');
    expect(logger.isVerbose()).toBe(true);
  });

  it('REQ-LOGGING-002: suppresses normal output at quiet level but keeps warnings/info/success', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = createLogger({
      level: 'quiet',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      color: false,
    });

    logger.step('Hidden step');
    logger.detail('Hidden detail');
    logger.bullet('Hidden bullet');
    logger.raw('Hidden raw');
    logger.info('Visible info');
    logger.success('Visible success');
    logger.warn('Visible warning');

    expect(out).toContain('Visible info');
    expect(out).toContain('Visible success');
    expect(out.some((l) => /Hidden/.test(l))).toBe(false);
    expect(err).toContain('    Warning: Visible warning');
    expect(logger.showsDetails()).toBe(false);
  });

  it('REQ-LOGGING-001: suppresses all output at silent level', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = createLogger({
      level: 'silent',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      color: false,
    });

    logger.step('x');
    logger.detail('x');
    logger.trace('x');
    logger.bullet('x');
    logger.info('x');
    logger.success('x');
    logger.warn('x');
    logger.raw('x');

    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(logger.showsDetails()).toBe(false);
  });
});
