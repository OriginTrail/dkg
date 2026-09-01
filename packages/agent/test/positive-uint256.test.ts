import { describe, expect, it } from 'vitest';
import { parsePositiveUint256 } from '../src/positive-uint256.js';

describe('parsePositiveUint256', () => {
  it.each([
    [1n, 1n],
    [1, 1n],
    ['1', 1n],
    [(1n << 256n) - 1n, (1n << 256n) - 1n],
    [((1n << 256n) - 1n).toString(), (1n << 256n) - 1n],
  ])('accepts %s', (input, expected) => {
    expect(parsePositiveUint256(input, 'accountId')).toBe(expected);
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
    expect(() => parsePositiveUint256(input, 'accountId'))
      .toThrow('accountId must be a positive integer within uint256 range.');
  });
});
