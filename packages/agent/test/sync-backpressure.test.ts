import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  resolveBooleanSwitch,
  resolveNonNegativeIntegerSwitch,
  resolveSyncGlobalMaxInflight,
  resolveSyncGlobalQueueLimit,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sync global backpressure', () => {
  it('serializes concurrent sync work when global limit is 1 while non-sync work can proceed', async () => {
    const ctx = createOperationContext('sync');
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = withGlobalSyncBackpressure(
      { limit: 1, ctx, label: 'first' },
      async () => {
        events.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first-end');
      },
    );
    await tick();

    const second = withGlobalSyncBackpressure(
      { limit: 1, queueLimit: 1, ctx, label: 'second' },
      async () => {
        events.push('second-start');
      },
    );
    await tick();

    events.push('storage-ack-work');
    expect(events).toEqual(['first-start', 'storage-ack-work']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'storage-ack-work', 'first-end', 'second-start']);
  });

  it('rejects excess sync work instead of growing an unbounded queue', async () => {
    const ctx = createOperationContext('sync');
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = withGlobalSyncBackpressure(
      { limit: 1, queueLimit: 1, ctx, label: 'first' },
      async () => {
        events.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    );
    await tick();

    const second = withGlobalSyncBackpressure(
      { limit: 1, queueLimit: 1, ctx, label: 'second' },
      async () => {
        events.push('second-start');
      },
    );
    await tick();

    await expect(withGlobalSyncBackpressure(
      { limit: 1, queueLimit: 1, ctx, label: 'third' },
      async () => {
        events.push('third-start');
      },
    )).rejects.toThrow(SyncBackpressureBusyError);

    expect(events).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'second-start']);
  });

  it('defaults sync pressure limits on while preserving env/config overrides and disable switches', () => {
    const oldMaxInflight = process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
    const oldLegacyLimit = process.env.DKG_SYNC_GLOBAL_LIMIT;
    const oldQueueLimit = process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
    try {
      delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;

      expect(resolveSyncGlobalMaxInflight(undefined)).toBe(2);
      expect(resolveSyncGlobalMaxInflight(3)).toBe(3);
      expect(resolveSyncGlobalMaxInflight(undefined, 4)).toBe(4);
      expect(resolveSyncGlobalMaxInflight(0)).toBeUndefined();
      expect(resolveSyncGlobalQueueLimit(undefined, 2)).toBe(4);

      process.env.DKG_SYNC_GLOBAL_LIMIT = '5';
      expect(resolveSyncGlobalMaxInflight(undefined)).toBe(5);

      process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = '6';
      expect(resolveSyncGlobalMaxInflight(3, 4)).toBe(6);

      process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = '0';
      expect(resolveSyncGlobalQueueLimit(8, 2)).toBe(0);
    } finally {
      if (oldMaxInflight === undefined) delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      else process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = oldMaxInflight;
      if (oldLegacyLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_LIMIT = oldLegacyLimit;
      if (oldQueueLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = oldQueueLimit;
    }
  });

  it('env switches override config values for emergency controls', () => {
    const oldReconciler = process.env.DKG_SYNC_RECONCILER_ENABLED;
    const oldDeadline = process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS;
    try {
      process.env.DKG_SYNC_RECONCILER_ENABLED = '0';
      process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS = '60000';

      expect(resolveBooleanSwitch(true, 'DKG_SYNC_RECONCILER_ENABLED', true)).toBe(false);
      expect(resolveNonNegativeIntegerSwitch(15_000, 'DKG_STORAGE_ACK_HANDLER_DEADLINE_MS')).toBe(60_000);
    } finally {
      if (oldReconciler === undefined) delete process.env.DKG_SYNC_RECONCILER_ENABLED;
      else process.env.DKG_SYNC_RECONCILER_ENABLED = oldReconciler;
      if (oldDeadline === undefined) delete process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS;
      else process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS = oldDeadline;
    }
  });
});
