import { describe, expect, it } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import {
  StoreOperationTimeoutError,
  isStoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';

import {
  classifyExactSwmGraphReplaceFailure,
  classifyPreCommitChainRpcFailure,
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
  PromoteReplaySafeError,
} from '../src/promote-replay-safety.js';

describe('promote replay safety', () => {
  it.each([
    'RPC_ENDPOINTS_EXHAUSTED',
    'RPC_RECEIPT_LOOKUP_FAILED',
    'RPC_TIMEOUT',
  ] as const)('certifies %s only at the pre-commit producer boundary', (code) => {
    const transportFailure = new ChainRpcTransportError(code, 'chain transport unavailable');

    expect(isPromoteReplaySafeError(transportFailure)).toBe(false);
    const classified = classifyPreCommitChainRpcFailure(transportFailure);
    expect(classified).toBeInstanceOf(PromoteReplaySafeError);
    expect(classified).toMatchObject({
      boundary: 'agent-preflight-chain',
      cause: transportFailure,
    });
    expect(isPromoteReplaySafeError(classified)).toBe(true);
  });

  it('does not let the public error contract certify a non-chain failure', () => {
    expect(() => new PromoteReplaySafeError(new Error('arbitrary failure'))).toThrow(TypeError);
  });

  it.each([
    ['generic timeout', Object.assign(new Error('timed out'), { code: 'TIMEOUT' })],
    ['on-chain revert', Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })],
  ])('does not certify %s', (_label, failure) => {
    expect(classifyPreCommitChainRpcFailure(failure)).toBe(failure);
    expect(isPromoteReplaySafeError(failure)).toBe(false);
  });

  it('certifies only an indeterminate exact SWM graph replacement at the producer boundary', () => {
    const replaceFailure = new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
    });

    expect(isPromoteReplaySafeError(replaceFailure)).toBe(false);
    const classified = classifyExactSwmGraphReplaceFailure(replaceFailure);
    expect(classified).toMatchObject({
      boundary: 'exact-swm-graph-replace',
      cause: replaceFailure,
    });
    expect(isStoreOperationTimeoutError((classified as Error).cause)).toBe(true);
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
