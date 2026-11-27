import { describe, expect, it } from 'vitest';
import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { QueryResultTooLargeError, isQueryResultTooLargeError } from '../src/index.js';

describe('public query-result overflow contract', () => {
  it('recognizes a caller-result overflow and preserves its original storage error', () => {
    const cause = new StoreResponseTooLargeError(16_384, 16_385);
    const error = new QueryResultTooLargeError(cause);
    expect(isQueryResultTooLargeError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', queryPhase: 'result', cause });
  });

  it('recognizes the same discriminator across package or serialized error boundaries', () => {
    expect(isQueryResultTooLargeError({ code: 'STORE_RESPONSE_TOO_LARGE', queryPhase: 'result' })).toBe(true);
  });

  it.each([
    new StoreResponseTooLargeError(8 * 1024 * 1024, 8 * 1024 * 1024 + 1),
    { code: 'STORE_RESPONSE_TOO_LARGE', queryPhase: 'catalog' },
    { code: 'OTHER_ERROR', queryPhase: 'result' },
    { queryPhase: 'result' }, null, undefined, 'STORE_RESPONSE_TOO_LARGE',
  ])('does not classify metadata overflow or unrelated failures as document overflow: %j', (error) => {
    expect(isQueryResultTooLargeError(error)).toBe(false);
  });
});
