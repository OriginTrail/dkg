import { describe, expect, it } from 'vitest';
import {
  QueryMaterializationTooLargeError,
  isQueryMaterializationTooLargeError,
} from '../src/query-materialization-error.js';

describe('query materialization error contract', () => {
  it('recognizes class and structurally transported instances', () => {
    expect(isQueryMaterializationTooLargeError(
      new QueryMaterializationTooLargeError(10, 11),
    )).toBe(true);
    expect(isQueryMaterializationTooLargeError({
      code: 'QUERY_MATERIALIZATION_TOO_LARGE',
      maxBytes: 10,
      actualBytes: 11,
      message: 'too large',
    })).toBe(true);
  });

  it.each([
    null,
    { code: 'QUERY_MATERIALIZATION_TOO_LARGE' },
    { code: 'QUERY_MATERIALIZATION_TOO_LARGE', maxBytes: -1, actualBytes: 11, message: 'x' },
    { code: 'QUERY_MATERIALIZATION_TOO_LARGE', maxBytes: 10, actualBytes: -1, message: 'x' },
    { code: 'QUERY_MATERIALIZATION_TOO_LARGE', maxBytes: 10, actualBytes: 11 },
  ])('rejects malformed lookalike %j', (candidate) => {
    expect(isQueryMaterializationTooLargeError(candidate)).toBe(false);
  });
});
