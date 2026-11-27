import { describe, expect, it } from 'vitest';
import {
  QueryAccessDeniedError,
  isQueryAccessDeniedError,
} from '../src/errors.js';

describe('query access denial across package and transport boundaries', () => {
  it('preserves the public error name, message and code', () => {
    const error = new QueryAccessDeniedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('QueryAccessDeniedError');
    expect(error.message).toBe('Context Graph read denied');
    expect(error.code).toBe('QUERY_ACCESS_DENIED');
    expect(isQueryAccessDeniedError(error)).toBe(true);
  });

  it('recognizes the code after serialization without relying on class identity', () => {
    const wireError: unknown = JSON.parse(JSON.stringify(new QueryAccessDeniedError()));
    expect(isQueryAccessDeniedError(wireError)).toBe(true);
    expect(isQueryAccessDeniedError(Object.assign(new Error('remote denial'), {
      code: 'QUERY_ACCESS_DENIED',
    }))).toBe(true);
  });

  it.each([
    null, undefined, 'QUERY_ACCESS_DENIED', 403, {},
    new Error('Context Graph read denied'),
    { code: 'QUERY_UNAVAILABLE' },
    { code: 'QUERY_ACCESS_DENIED_SUFFIX' },
  ])('does not misclassify an unrelated failure: %j', error => {
    expect(isQueryAccessDeniedError(error)).toBe(false);
  });
});
