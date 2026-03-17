import { describe, expect, it } from 'vitest';
import { vectorApiErrorResponse } from '../src/daemon.js';

describe('vectorApiErrorResponse', () => {
  it('maps vector index health failures to a 503 response', () => {
    const error = new Error('vector index unhealthy');
    error.name = 'VectorIndexUnhealthyError';

    expect(vectorApiErrorResponse(error)).toEqual({
      status: 503,
      error: 'vector index unhealthy',
    });
  });

  it('ignores unrelated errors', () => {
    expect(vectorApiErrorResponse(new Error('boom'))).toBeNull();
    expect(vectorApiErrorResponse('boom')).toBeNull();
  });
});
