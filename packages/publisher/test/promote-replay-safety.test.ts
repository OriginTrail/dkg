import { describe, expect, it } from 'vitest';
import {
  StoreOperationTimeoutError,
  isStoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';

import {
  classifyExactSwmGraphReplaceFailure,
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
} from '../src/promote-replay-safety.js';

describe('promote replay safety', () => {
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
    expect(getPromoteReplaySafeErrorDiagnostic(classified)).toEqual({
      name: 'PromoteReplaySafeError',
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
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
    expect(getPromoteReplaySafeErrorDiagnostic(classified)).toBeUndefined();
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
    expect(getPromoteReplaySafeErrorDiagnostic(forgedShape)).toBeUndefined();
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
