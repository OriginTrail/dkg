import { describe, it, expect } from 'vitest';
import { toErrorMessage, hasErrorCode } from '../src/errors.js';

describe('toErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns string values as-is', () => {
    expect(toErrorMessage('raw string')).toBe('raw string');
  });

  it('stringifies non-Error objects', () => {
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('handles Error subclasses', () => {
    expect(toErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });
});

describe('hasErrorCode', () => {
  it('returns true for matching error code', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(hasErrorCode(err, 'ENOENT')).toBe(true);
  });

  it('returns false for non-matching code', () => {
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(hasErrorCode(err, 'ENOENT')).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(hasErrorCode('string', 'ENOENT')).toBe(false);
    expect(hasErrorCode(null, 'ENOENT')).toBe(false);
  });
});
