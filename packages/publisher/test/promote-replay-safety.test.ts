import { describe, expect, it } from 'vitest';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';

import {
  classifyExactSwmGraphReplaceFailure,
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
  unwrapPromoteReplaySafeError,
} from '../src/promote-replay-safety.js';

describe('promote replay safety', () => {
  it('certifies only an indeterminate exact SWM graph replacement at the producer boundary', () => {
    const replaceFailure = new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
    });

    const classified = classifyExactSwmGraphReplaceFailure(replaceFailure);
    expect(isPromoteReplaySafeError(classified)).toBe(true);
    expect(getPromoteReplaySafeErrorDiagnostic(classified)).toEqual({
      name: 'PromoteReplaySafeError',
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
    });
    expect(unwrapPromoteReplaySafeError(classified)).toBe(replaceFailure);
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

    expect(classifyExactSwmGraphReplaceFailure(failure)).toBe(failure);
  });

  it('rejects a structurally identical marker that did not originate at the producer boundary', () => {
    const forgedShape = Object.freeze({
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'atomic-exact-swm-graph-replacement' as const,
      cause: new Error('indeterminate replacement'),
    });

    expect(isPromoteReplaySafeError(forgedShape)).toBe(false);
    expect(getPromoteReplaySafeErrorDiagnostic(forgedShape)).toBeUndefined();
    expect(unwrapPromoteReplaySafeError(forgedShape)).toBe(forgedShape);
  });

  it.each([
    ['missing stage', { code: 'PROMOTE_REPLAY_SAFE_FAILURE' }],
    ['missing cause', {
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'atomic-exact-swm-graph-replacement',
    }],
    ['unknown stage', {
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'other',
    }],
    ['misspelled stage', {
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'atomic-exact-swm-graph-replacment',
    }],
  ])('fails closed for an untrusted marker with %s', (_label, malformed) => {
    expect(isPromoteReplaySafeError(malformed)).toBe(false);
  });
});
