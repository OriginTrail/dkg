import { describe, it, expect } from 'vitest';
import { hexToBytes } from '../src/api/session-routes.js';

describe('session-routes hexToBytes validation', () => {
  it('accepts valid hex string', () => {
    expect(hexToBytes('aabbcc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('accepts 0x-prefixed hex', () => {
    expect(hexToBytes('0xaabbcc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow('invalid hex string');
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytes('gghhii')).toThrow('invalid hex string');
  });

  it('rejects hex with spaces', () => {
    expect(() => hexToBytes('aa bb cc')).toThrow('invalid hex string');
  });

  it('handles empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('handles 0x prefix alone (empty payload)', () => {
    expect(hexToBytes('0x')).toEqual(new Uint8Array(0));
  });

  it('handles uppercase hex', () => {
    expect(hexToBytes('0xAABBCC')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });

  it('handles mixed case hex', () => {
    expect(hexToBytes('0xAaBbCc')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });
});
