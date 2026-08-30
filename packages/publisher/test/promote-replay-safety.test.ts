import { describe, expect, it } from 'vitest';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';

import {
  classifyExactSwmGraphReplaceFailure,
  isPromoteReplaySafeError,
  PROMOTE_REPLAY_SAFE_ERROR_CODE,
  PromoteReplaySafeError,
} from '../src/promote-replay-safety.js';

describe('promote replay safety', () => {
  it('certifies only an indeterminate exact SWM graph replacement at the producer boundary', () => {
    const replaceFailure = new StoreOperationTimeoutError({
      backend: 'managed-oxigraph',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
    });

    const classified = classifyExactSwmGraphReplaceFailure(replaceFailure);
    expect(classified).toBeInstanceOf(PromoteReplaySafeError);
    expect((classified as PromoteReplaySafeError).cause).toBe(replaceFailure);
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

  it('recognizes replay-safe certification without prototype identity', () => {
    const crossRealmShape = Object.freeze({
      code: PROMOTE_REPLAY_SAFE_ERROR_CODE,
      stage: 'atomic-exact-swm-graph-replacement' as const,
      cause: new Error('indeterminate replacement'),
    });

    expect(crossRealmShape).not.toBeInstanceOf(PromoteReplaySafeError);
    expect(isPromoteReplaySafeError(crossRealmShape)).toBe(true);
  });
});
