import { describe, expect, it } from 'vitest';
import {
  STORE_OPERATION_OUTCOME_TAG,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  UnsupportedTripleStoreCapabilityError,
  hasStoreOperationOutcome,
  isReadOnlyStoreOperation,
  isStoreOperation,
  isStoreOperationNotStarted,
  isStoreOperationTimeoutError,
} from '../src/index.js';

describe('store operation outcome protocol', () => {
  it('owns the canonical read-only operation taxonomy', () => {
    expect(isReadOnlyStoreOperation('query')).toBe(true);
    expect(isReadOnlyStoreOperation('listGraphsByPrefix')).toBe(true);
    expect(isReadOnlyStoreOperation('replaceGraph')).toBe(false);
    expect(isReadOnlyStoreOperation('update')).toBe(false);
  });

  it('recognizes the timeout, scheduler, and capability producers', () => {
    const failures = [
      new StoreOperationTimeoutError({
        backend: 'test',
        operation: 'replaceGraph',
        outcome: 'not_started',
      }),
      new StoreSchedulerBusyError('queue_full', 'normal', 'adapter.replaceGraph', {
        storeOperation: 'replaceGraph',
      }),
      new UnsupportedTripleStoreCapabilityError('replaceGraph', 'TestStore'),
    ];

    for (const failure of failures) {
      expect(hasStoreOperationOutcome(failure, 'replaceGraph', 'not_started')).toBe(true);
      expect(isStoreOperationNotStarted(failure, 'replaceGraph')).toBe(true);
      expect(failure).toMatchObject({
        storeOperationOutcomeTag: STORE_OPERATION_OUTCOME_TAG,
        storeOperation: 'replaceGraph',
        outcome: 'not_started',
      });
    }

    const rfcRefusal = new UnsupportedTripleStoreCapabilityError(
      'rfc64AuthorCommitCasV1',
      'TestStore',
    );
    expect(isStoreOperationNotStarted(rfcRefusal, 'rfc64AuthorCommitCasV1')).toBe(true);
    expect(isStoreOperationNotStarted(rfcRefusal, 'replaceGraph')).toBe(false);
  });

  it('rejects incidental matching properties without the stable protocol tag', () => {
    const incidental = Object.assign(new Error('unrelated failure'), {
      storeOperation: 'replaceGraph',
      outcome: 'not_started',
    });

    expect(hasStoreOperationOutcome(incidental, 'replaceGraph', 'not_started')).toBe(false);
  });

  it('preserves arbitrary legacy timeout labels without inventing a canonical operation', () => {
    const timeout = new StoreOperationTimeoutError({
      backend: 'test',
      operation: 'publish',
    });

    expect(timeout.operation).toBe('publish');
    expect(timeout.storeOperation).toBeUndefined();
    expect(isStoreOperationTimeoutError(timeout)).toBe(true);
  });

  it('validates canonical operation metadata rather than narrowing arbitrary strings', () => {
    expect(isStoreOperation('replaceGraph')).toBe(true);
    expect(isStoreOperation('replaceGrahp')).toBe(false);
    expect(isStoreOperationTimeoutError({
      code: 'STORE_OPERATION_TIMEOUT',
      storeOperation: 'replaceGrahp',
    })).toBe(false);
    expect(isStoreOperationTimeoutError({
      code: 'STORE_OPERATION_TIMEOUT',
      operation: 'legacy-route-label',
    })).toBe(true);
  });
});
