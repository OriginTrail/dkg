import { describe, it, expect } from 'vitest';
import { parseDotenvValue } from '../src/dotenv.js';

describe('parseDotenvValue', () => {
  it('returns a plain unquoted value unchanged', () => {
    expect(parseDotenvValue('secret')).toBe('secret');
    expect(parseDotenvValue('  secret  ')).toBe('secret');
  });

  it('strips a whitespace-preceded inline comment from unquoted values', () => {
    expect(parseDotenvValue('secret # local dev')).toBe('secret');
    expect(parseDotenvValue('true # on')).toBe('true');
  });

  it('keeps a `#` with no preceding whitespace as literal', () => {
    expect(parseDotenvValue('a#b')).toBe('a#b');
  });

  it('preserves inner `#` inside quoted values', () => {
    expect(parseDotenvValue('"se#cret value"')).toBe('se#cret value');
    expect(parseDotenvValue("'se#cret'")).toBe('se#cret');
  });

  it('handles backslash escapes in double-quoted values', () => {
    expect(parseDotenvValue('"abc\\"def"')).toBe('abc"def');
    expect(parseDotenvValue('"a\\\\b"')).toBe('a\\b');
  });

  it('treats backslash literally in single-quoted values', () => {
    expect(parseDotenvValue("'a\\b'")).toBe('a\\b');
  });

  it('ignores anything after a closing quote', () => {
    expect(parseDotenvValue('"secret" # trailing comment')).toBe('secret');
  });
});
