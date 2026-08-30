import { describe, expect, it, vi } from 'vitest';

import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import {
  captureSyncOnConnectAttempt,
  executeSyncOnConnectAttempt,
} from '../src/sync/on-connect/attempt-accounting.js';
import { SyncOnConnectPostSyncError } from '../src/sync/on-connect/sync-on-connect.js';

describe('sync-on-connect structured attempt accounting', () => {
  it('turns callback-free success into one explicit retry result', async () => {
    await expect(captureSyncOnConnectAttempt(async () => 'synced')).resolves.toEqual({
      outcome: 'synced',
      accounting: {
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: false,
      },
    });
  });

  it('carries explicit retry accounting in the terminal result', async () => {
    const result = await captureSyncOnConnectAttempt(async (recordAccounting) => {
      recordAccounting({
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: true,
      });
      return 'synced';
    });
    const recordAccounting = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => result, {
      recordAccounting,
      onBackpressure: vi.fn(),
    })).resolves.toBe('synced');
    expect(recordAccounting).toHaveBeenCalledOnce();
    expect(recordAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: true,
    });
  });

  it('normalizes local backpressure without inventing retry accounting', async () => {
    const recordAccounting = vi.fn();
    const onBackpressure = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw new SyncBackpressureBusyError('sync queue full');
    }, {
      recordAccounting,
      onBackpressure,
    })).resolves.toBe('deferred-backpressure');
    expect(recordAccounting).not.toHaveBeenCalled();
    expect(onBackpressure).toHaveBeenCalledWith('sync queue full');
  });

  it('keeps thrown post-sync retry eligibility in the structured policy', async () => {
    const nonRetryable = new SyncOnConnectPostSyncError(
      'peer-a',
      new Error('discovery failed'),
      { backoffEligible: false },
    );
    const retryable = new SyncOnConnectPostSyncError(
      'peer-a',
      new Error('shared memory failed'),
      { backoffEligible: true },
    );
    const recordNonRetryable = vi.fn();
    const recordRetryable = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw nonRetryable;
    }, {
      recordAccounting: recordNonRetryable,
      onBackpressure: vi.fn(),
    })).rejects.toBe(nonRetryable);
    expect(recordNonRetryable).not.toHaveBeenCalled();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw retryable;
    }, {
      recordAccounting: recordRetryable,
      onBackpressure: vi.fn(),
    })).rejects.toBe(retryable);
    expect(recordRetryable).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: false,
    });
  });
});
