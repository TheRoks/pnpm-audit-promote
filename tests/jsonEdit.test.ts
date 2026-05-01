import { describe, it, expect } from 'vitest';
import { findMatchingBrace, removeJsonProperty } from '../src/jsonEdit.js';

describe('findMatchingBrace', () => {
  it('finds matching brace at top level', () => {
    const s = '{}';
    expect(findMatchingBrace(s, 0)).toBe(1);
  });

  it('handles nested braces', () => {
    const s = '{ "a": { "b": 1 } }';
    const open = s.indexOf('{');
    expect(findMatchingBrace(s, open)).toBe(s.length - 1);
  });

  it('ignores braces inside strings', () => {
    const s = '{ "a": "} not closing" }';
    expect(findMatchingBrace(s, 0)).toBe(s.length - 1);
  });

  it('handles escapes inside strings', () => {
    const s = '{ "a": "\\"}\\"" }';
    expect(findMatchingBrace(s, 0)).toBe(s.length - 1);
  });

  it('handles arrays', () => {
    const s = '[1, [2, 3], 4]';
    expect(findMatchingBrace(s, 0)).toBe(s.length - 1);
  });

  it('returns -1 on mismatch', () => {
    expect(findMatchingBrace('{ "a": 1', 0)).toBe(-1);
  });

  it('returns -1 for non-opener', () => {
    expect(findMatchingBrace('abc', 0)).toBe(-1);
  });
});

describe('removeJsonProperty', () => {
  it('removes a string property in the middle', () => {
    const before = '{\n  "a": "1",\n  "b": "2",\n  "c": "3"\n}';
    const out = removeJsonProperty(before, 'b');
    expect(JSON.parse(out)).toEqual({ a: '1', c: '3' });
  });

  it('removes the last property', () => {
    const before = '{\n  "a": "1",\n  "b": "2"\n}';
    const out = removeJsonProperty(before, 'b');
    expect(JSON.parse(out)).toEqual({ a: '1' });
  });

  it('removes the first property', () => {
    const before = '{\n  "a": "1",\n  "b": "2"\n}';
    const out = removeJsonProperty(before, 'a');
    expect(JSON.parse(out)).toEqual({ b: '2' });
  });

  it('removes an object property with nested braces', () => {
    const before = '{ "a": 1, "b": { "x": [1, 2], "y": "}" }, "c": 3 }';
    const out = removeJsonProperty(before, 'b');
    expect(JSON.parse(out)).toEqual({ a: 1, c: 3 });
  });

  it('returns input unchanged when property missing', () => {
    const text = '{ "a": 1 }';
    expect(removeJsonProperty(text, 'z')).toBe(text);
  });
});
