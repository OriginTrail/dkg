import { describe, expect, it } from 'vitest';
import {
  STORE_OPERATION_OUTCOME_TAG,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  UnsupportedTripleStoreCapabilityError,
  hasStoreOperationOutcome,
  isStoreOperation,
  isStoreOperationTimeoutError,
} from '../src/index.js';

describe('store operation outcome protocol', () => {
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
      expect(failure).toMatchObject({
        storeOperationOutcomeTag: STORE_OPERATION_OUTCOME_TAG,
        storeOperation: 'replaceGraph',
        outcome: 'not_started',
      });
    }
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
