import { describe, expect, it } from 'vitest';
import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import {
  QueryResultTooLargeError,
  asQueryResultTooLargeError,
  isQueryResultTooLargeError,
} from '../src/query-result-too-large-error.js';

describe('public query result-size error boundary', () => {
  it.each([
    new StoreResponseTooLargeError(10, 11),
    Object.assign(new Error('materialization limit'), {
      code: 'QUERY_MATERIALIZATION_TOO_LARGE',
      maxBytes: 10,
      actualBytes: 12,
    }),
  ])('normalizes lower-layer overflow %s', (cause) => {
    const normalized = asQueryResultTooLargeError(cause);
    expect(normalized).toBeInstanceOf(QueryResultTooLargeError);
    expect(normalized).toMatchObject({
      code: 'QUERY_RESULT_TOO_LARGE',
      maxBytes: 10,
      actualBytes: expect.any(Number),
      cause,
    });
  });

  it('recognizes a worker-deserialized public error structurally', () => {
    expect(isQueryResultTooLargeError({
      code: 'QUERY_RESULT_TOO_LARGE',
      maxBytes: 10,
      actualBytes: 11,
      message: 'too large',
    })).toBe(true);
  });

  it('does not promote code-only lookalikes', () => {
    expect(asQueryResultTooLargeError({ code: 'STORE_RESPONSE_TOO_LARGE' }))
      .toBeUndefined();
    expect(asQueryResultTooLargeError({ code: 'QUERY_MATERIALIZATION_TOO_LARGE' }))
      .toBeUndefined();
  });
});
