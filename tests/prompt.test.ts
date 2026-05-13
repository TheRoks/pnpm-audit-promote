import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReadlineModule from 'node:readline';

// `defaultConfirmDestructive` reads `process.stdin.isTTY` at call-time and
// uses `readline.createInterface(...).question(...)`. We exercise both code
// paths by toggling `isTTY` and mocking `node:readline` at module scope
// (vi.spyOn cannot patch ESM module namespaces).
let nextAnswer = '';
const closeMock = vi.fn();
const createInterfaceMock = vi.fn();

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof ReadlineModule>();
  createInterfaceMock.mockImplementation(() => {
    return {
      question: (_q: string, cb: (a: string) => void) => cb(nextAnswer),
      close: closeMock,
    } as unknown as ReadlineModule.Interface;
  });
  return {
    ...actual,
    createInterface: createInterfaceMock,
  };
});

const { defaultConfirmDestructive } = await import('../src/prompt');
const { NonInteractiveConfirmationError } = await import('../src/errors');

let originalIsTTY: PropertyDescriptor | undefined;

function setIsTTY(value: boolean): void {
  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
}

function restoreIsTTY(): void {
  if (originalIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    originalIsTTY = undefined;
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
}

beforeEach(() => {
  nextAnswer = '';
  closeMock.mockClear();
  createInterfaceMock.mockClear();
});

afterEach(() => {
  restoreIsTTY();
});

describe('defaultConfirmDestructive', () => {
  describe('REQ-SAFETY-003: bypass flags', () => {
    it('REQ-SAFETY-003: returns true when force is set, without prompting', async () => {
      setIsTTY(true);
      await expect(defaultConfirmDestructive({ force: true, dryRun: false })).resolves.toBe(true);
      expect(createInterfaceMock).not.toHaveBeenCalled();
    });

    it('REQ-SAFETY-003: returns true when dryRun is set, without prompting', async () => {
      setIsTTY(true);
      await expect(defaultConfirmDestructive({ force: false, dryRun: true })).resolves.toBe(true);
      expect(createInterfaceMock).not.toHaveBeenCalled();
    });

    it('REQ-SAFETY-003: returns true when both force and dryRun are set', async () => {
      setIsTTY(true);
      await expect(defaultConfirmDestructive({ force: true, dryRun: true })).resolves.toBe(true);
      expect(createInterfaceMock).not.toHaveBeenCalled();
    });
  });

  describe('REQ-SAFETY-002: non-interactive rejection', () => {
    beforeEach(() => setIsTTY(false));

    it('REQ-SAFETY-002: throws NonInteractiveConfirmationError when stdin is not a TTY and no force', async () => {
      await expect(
        defaultConfirmDestructive({ force: false, dryRun: false }),
      ).rejects.toBeInstanceOf(NonInteractiveConfirmationError);
    });
  });

  describe('REQ-SAFETY-001: interactive prompt', () => {
    beforeEach(() => setIsTTY(true));

    it("REQ-SAFETY-001: prompts the user and accepts 'y' as confirmation", async () => {
      nextAnswer = 'y';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(true);
      expect(createInterfaceMock).toHaveBeenCalledOnce();
      expect(closeMock).toHaveBeenCalledOnce();
    });

    it("REQ-SAFETY-001: prompts the user and accepts 'yes' (case-insensitive)", async () => {
      nextAnswer = 'YES';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(true);
    });

    it('REQ-SAFETY-001: trims whitespace around the answer', async () => {
      nextAnswer = '  y  ';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(true);
    });

    it("REQ-SAFETY-001: rejects 'n'", async () => {
      nextAnswer = 'n';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(false);
    });

    it('REQ-SAFETY-001: rejects an empty answer (default = no)', async () => {
      nextAnswer = '';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(false);
    });

    it('REQ-SAFETY-001: rejects an arbitrary non-affirmative answer', async () => {
      nextAnswer = 'maybe';
      await expect(defaultConfirmDestructive({ force: false, dryRun: false })).resolves.toBe(false);
    });

    it('REQ-SAFETY-001: closes the readline interface after prompting', async () => {
      nextAnswer = 'n';
      await defaultConfirmDestructive({ force: false, dryRun: false });
      expect(closeMock).toHaveBeenCalledOnce();
    });
  });
});
