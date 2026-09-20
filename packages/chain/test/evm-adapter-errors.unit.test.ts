import { describe, expect, it } from 'vitest';

import { isEvmBlockUnavailableError } from '../src/evm-block-unavailable-error.js';

describe('isEvmBlockUnavailableError', () => {
  it.each([
    ['top-level phrase', new Error('header not found'), true],
    ['nested shortMessage', { info: { error: { shortMessage: 'unknown block' } } }, true],
    ['nested responseBody', { response: { responseBody: 'block not found' } }, true],
    ['word-boundary near miss', new Error('unknown blocks'), false],
    ['archive/pruning failure', new Error('missing trie node: historical state pruned'), false],
  ])('%s => %s', (_label, error, expected) => {
    expect(isEvmBlockUnavailableError(error)).toBe(expected);
  });
});
