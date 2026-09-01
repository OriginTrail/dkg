import { describe, expect, it } from 'vitest';
import {
  normalizePositiveUint256,
  serializePositiveUint256,
} from '../src/positive-uint256.js';

describe('positive uint256 boundaries', () => {
  it.each([
    [1n, 1n],
    [1, 1n],
    ['1', 1n],
    [(1n << 256n) - 1n, (1n << 256n) - 1n],
    [((1n << 256n) - 1n).toString(), (1n << 256n) - 1n],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePositiveUint256(input, 'accountId')).toBe(expected);
  });

  it.each([
    0n,
    -1n,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    '0',
    '-1',
    '1.0',
    ' 1',
    1n << 256n,
    (1n << 256n).toString(),
    null,
    undefined,
  ])('rejects %s', (input) => {
    expect(() => normalizePositiveUint256(input, 'accountId'))
      .toThrow('accountId must be a positive integer within uint256 range.');
  });

  it.each([
    [17n, '17'],
    [17, '17'],
    ['17', '17'],
  ])('serializes %s as canonical decimal', (input, expected) => {
    expect(serializePositiveUint256(input, 'accountId')).toBe(expected);
  });
});
