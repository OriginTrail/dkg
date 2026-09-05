import { describe, expect, it } from 'vitest';
import {
  StoreOperationTimeoutError,
  isStoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';

import {
  classifyExactSwmGraphReplaceFailure,
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
  isPromoteReplaySafeError,
  isPromoteRetryableFailure,
} from '../src/promote-replay-safety.js';

describe('promote replay safety', () => {
  it('makes post-commit failures terminal even when their cause carries a retry marker', () => {
    const retryableCause = createPromoteRetryableFailure(new Error('observer failed'));
    const failure = createPromotePostCommitFailure(retryableCause);

    expect(failure).toMatchObject({
      name: 'PromotePostCommitFailureError',
      code: 'PROMOTE_POST_COMMIT_FAILURE',
      cause: retryableCause,
    });
    expect(getPromoteFailureDisposition(failure)).toEqual({
      classification: 'fatal',
      retryable: false,
      diagnostic: {
        name: 'PromotePostCommitFailureError',
        code: 'PROMOTE_POST_COMMIT_FAILURE',
      },
    });
  });

  it('preserves the generic retry disposition across Error serialization', () => {
    const failure = createPromoteRetryableFailure(new Error('domain-specific secret'));

    expect(isPromoteRetryableFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      name: 'PromoteRetryableFailureError',
      code: 'PROMOTE_RETRYABLE_FAILURE',
      cause: expect.any(Error),
    });
    expect(getPromoteFailureDisposition(failure)).toEqual({
      classification: 'transient',
      retryable: true,
      diagnostic: {
        name: 'PromoteRetryableFailureError',
        code: 'PROMOTE_RETRYABLE_FAILURE',
      },
    });

    const serialized = JSON.parse(JSON.stringify(failure)) as unknown;
    expect(serialized).toEqual({
      name: 'PromoteRetryableFailureError',
      code: 'PROMOTE_RETRYABLE_FAILURE',
    });
    expect(isPromoteRetryableFailure(serialized)).toBe(true);
    expect(getPromoteFailureDisposition(serialized)).toEqual({
      classification: 'transient',
      retryable: true,
      diagnostic: {
        name: 'PromoteRetryableFailureError',
        code: 'PROMOTE_RETRYABLE_FAILURE',
      },
    });
  });

  it('fails closed for lookalike and hostile generic retry markers', () => {
    expect(isPromoteRetryableFailure({
      code: 'PROMOTE_RETRYABLE_FAILURE_LOOKALIKE',
    })).toBe(false);
    expect(isPromoteRetryableFailure(Object.defineProperty({}, 'code', {
      get: () => { throw new Error('hostile getter'); },
    }))).toBe(false);
  });

  it('certifies only an indeterminate exact SWM graph replacement at the producer boundary', () => {
    const replaceFailure = new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
    });

    expect(isPromoteReplaySafeError(replaceFailure)).toBe(false);
    const classified = classifyExactSwmGraphReplaceFailure(replaceFailure);
    expect(classified).toBe(replaceFailure);
    expect(isStoreOperationTimeoutError(classified)).toBe(true);
    expect(isPromoteReplaySafeError(classified)).toBe(true);
    expect(getPromoteFailureDisposition(classified)).toEqual({
      classification: 'transient',
      retryable: true,
      diagnostic: {
        name: 'PromoteReplaySafeError',
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      },
    });
  });

  it.each([
    ['not-started replace', 'replaceGraph', 'not_started'],
    ['indeterminate insert', 'insert', 'indeterminate'],
    ['indeterminate read', 'query', 'indeterminate'],
  ] as const)('does not certify %s', (_label, operation, outcome) => {
    const failure = new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation,
      outcome,
    });

    const classified = classifyExactSwmGraphReplaceFailure(failure);
    expect(classified).toBe(failure);
    expect(isPromoteReplaySafeError(classified)).toBe(false);
    expect(getPromoteFailureDisposition(classified)).toBeUndefined();
  });

  it('rejects a structurally identical marker that did not originate at the producer boundary', () => {
    const forgedShape = Object.freeze({
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      storeOperation: 'replaceGraph',
      outcome: 'indeterminate',
    });

    expect(isStoreOperationTimeoutError(forgedShape)).toBe(true);
    expect(isPromoteReplaySafeError(forgedShape)).toBe(false);
    expect(getPromoteFailureDisposition(forgedShape)).toBeUndefined();
  });

  it.each([
    ['plain error', new Error('replace failed')],
    ['unclassified timeout', new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
    })],
    ['wrong operation', new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'insert',
      outcome: 'indeterminate',
    })],
  ])('fails closed for an untrusted marker with %s', (_label, malformed) => {
    expect(isPromoteReplaySafeError(malformed)).toBe(false);
  });
});
