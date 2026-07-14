import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  getSyncBackpressureSnapshot,
  resolveBooleanSwitch,
  resolveNonNegativeIntegerSwitch,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sync global backpressure', () => {
  it('serializes concurrent sync work when global limit is 1 while non-sync work can proceed', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 2,
    });
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = withGlobalSyncBackpressure(
      { policy, ctx, label: 'first' },
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
      { policy, ctx, label: 'second' },
      async () => {
        events.push('second-start');
      },
    );
    await tick();

    const third = withGlobalSyncBackpressure(
      { policy, ctx, label: 'third' },
      async () => {
        events.push('third-start');
      },
    );
    await tick();

    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({
      inflight: 1,
      queued: 2,
      limit: 1,
      queueLimit: 2,
      queuedByPriorityClass: { elevated: 0, default: 2, deprioritized: 0 },
    });

    events.push('storage-ack-work');
    expect(events).toEqual(['first-start', 'storage-ack-work']);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(events).toEqual([
      'first-start',
      'storage-ack-work',
      'first-end',
      'second-start',
      'third-start',
    ]);
  });

  it('starts a later elevated CG before an earlier deprioritized queued CG', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 3 });
    const events: string[] = [];
    let unblock!: () => void;
    const running = withGlobalSyncBackpressure({ policy, ctx, label: 'running' }, async () => {
      events.push('running');
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await tick();
    const low = withGlobalSyncBackpressure({
      policy, ctx, label: 'low', contextGraphId: 'low', lane: 'durable',
      priority: -10, priorityClass: 'deprioritized',
    }, async () => { events.push('low'); });
    const high = withGlobalSyncBackpressure({
      policy, ctx, label: 'high', contextGraphId: 'high', lane: 'durable',
      priority: 10, priorityClass: 'elevated',
    }, async () => { events.push('high'); });
    await tick();
    expect(events).toEqual(['running']);
    unblock();
    await Promise.all([running, low, high]);
    expect(events).toEqual(['running', 'high', 'low']);
  });

  it('runs the oldest aged entry before newer elevated work', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 3 });
    const events: string[] = [];
    let now = 0;
    let unblock!: () => void;
    const running = withGlobalSyncBackpressure({ policy, ctx, label: 'running', now: () => now }, async () => {
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await tick();
    const agedLow = withGlobalSyncBackpressure({
      policy, ctx, label: 'aged-low', priority: -1, priorityClass: 'deprioritized',
      agingThresholdMs: 10, now: () => now,
    }, async () => { events.push('aged-low'); });
    now = 5;
    const high = withGlobalSyncBackpressure({
      policy, ctx, label: 'high', priority: 100, priorityClass: 'elevated',
      agingThresholdMs: 10, now: () => now,
    }, async () => { events.push('high'); });
    now = 11;
    unblock();
    await Promise.all([running, agedLow, high]);
    expect(events).toEqual(['aged-low', 'high']);
  });

  it('displaces only strictly lower-priority queued work when the queue is full', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    const events: string[] = [];
    let unblock!: () => void;
    const running = withGlobalSyncBackpressure({ policy, ctx, label: 'running' }, async () => {
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await tick();
    const displaced = withGlobalSyncBackpressure({
      policy, ctx, label: 'low', contextGraphId: 'low', priority: -1, priorityClass: 'deprioritized',
    }, async () => { events.push('low'); }).catch((error: unknown) => error);
    await tick();
    const high = withGlobalSyncBackpressure({
      policy, ctx, label: 'high', contextGraphId: 'high', priority: 1, priorityClass: 'elevated',
    }, async () => { events.push('high'); });
    const displacedError = await displaced;
    expect(displacedError).toMatchObject({ name: 'SyncBackpressureBusyError', reason: 'displaced' });
    unblock();
    await Promise.all([running, high]);
    expect(events).toEqual(['high']);
  });

  it('removes aborted queued work without starting it', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    let unblock!: () => void;
    let queuedStarted = false;
    const running = withGlobalSyncBackpressure({ policy, ctx, label: 'running' }, async () => {
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await tick();
    const controller = new AbortController();
    const queued = withGlobalSyncBackpressure({
      policy, ctx, label: 'queued', signal: controller.signal,
    }, async () => { queuedStarted = true; });
    await tick();
    controller.abort(new Error('stop'));
    await expect(queued).rejects.toThrow('stop');
    expect(getSyncBackpressureSnapshot(policy).queued).toBe(0);
    unblock();
    await running;
    expect(queuedStarted).toBe(false);
  });

  it('rejects excess sync work instead of growing an unbounded queue', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 1,
    });
    const events: string[] = [];
    const logs: string[] = [];
    let releaseFirst!: () => void;

    const first = withGlobalSyncBackpressure(
      { policy, ctx, label: 'first' },
      async () => {
        events.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    );
    await tick();

    const second = withGlobalSyncBackpressure(
      { policy, ctx, label: 'second' },
      async () => {
        events.push('second-start');
      },
    );
    await tick();

    await expect(withGlobalSyncBackpressure(
      {
        policy,
        ctx,
        label: 'third',
        logInfo: (_opCtx, message) => logs.push(message),
      },
      async () => {
        events.push('third-start');
      },
    )).rejects.toThrow(SyncBackpressureBusyError);

    expect(events).toEqual(['first-start']);
    expect(logs).toEqual([
      'Sync backpressure rejected third (global inflight=1/1, queued=1/1)',
    ]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'second-start']);
  });

  it('resolves one policy with defaults, config precedence, and legacy aliases', () => {
    const oldMaxInflight = process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
    const oldLegacyLimit = process.env.DKG_SYNC_GLOBAL_LIMIT;
    const oldQueueLimit = process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
    try {
      delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;

      expect(resolveSyncGlobalBackpressure({})).toEqual({ limit: 2, queueLimit: 4 });
      expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 3 })).toEqual({
        limit: 3,
        queueLimit: 6,
      });
      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: 3,
        syncGlobalLimit: 4,
        syncGlobalQueueLimit: 7,
      })).toEqual({ limit: 3, queueLimit: 7 });
      expect(resolveSyncGlobalBackpressure({ syncGlobalLimit: 4 })).toEqual({
        limit: 4,
        queueLimit: 8,
      });

      process.env.DKG_SYNC_GLOBAL_LIMIT = '5';
      expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 3 })).toEqual({
        limit: 5,
        queueLimit: 10,
      });

      process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = '6';
      expect(resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 3, syncGlobalLimit: 4 })).toEqual({
        limit: 6,
        queueLimit: 12,
      });

      process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = '0';
      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: 3,
        syncGlobalQueueLimit: 8,
      })).toEqual({ limit: 6, queueLimit: 0 });
    } finally {
      if (oldMaxInflight === undefined) delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      else process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = oldMaxInflight;
      if (oldLegacyLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_LIMIT = oldLegacyLimit;
      if (oldQueueLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = oldQueueLimit;
    }
  });

  it('disables the complete policy when the inflight limit is zero', () => {
    const oldMaxInflight = process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
    const oldLegacyLimit = process.env.DKG_SYNC_GLOBAL_LIMIT;
    const oldQueueLimit = process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
    try {
      delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;

      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: 0,
        syncGlobalQueueLimit: 8,
      })).toEqual({ limit: undefined, queueLimit: undefined });

      process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = '0';
      process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = '9';
      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: 3,
        syncGlobalQueueLimit: 8,
      })).toEqual({ limit: undefined, queueLimit: undefined });
    } finally {
      if (oldMaxInflight === undefined) delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      else process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = oldMaxInflight;
      if (oldLegacyLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_LIMIT = oldLegacyLimit;
      if (oldQueueLimit === undefined) delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
      else process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = oldQueueLimit;
    }
  });

  it('normalizes invalid raw limits before exposing an executable policy', () => {
    const oldMaxInflight = process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
    const oldLegacyLimit = process.env.DKG_SYNC_GLOBAL_LIMIT;
    const oldQueueLimit = process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;
    try {
      delete process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT;
      delete process.env.DKG_SYNC_GLOBAL_LIMIT;
      delete process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT;

      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: Number.NaN,
        syncGlobalLimit: 3,
        syncGlobalQueueLimit: 1.5,
      })).toEqual({ limit: 3, queueLimit: 6 });
      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: -1,
        syncGlobalLimit: 4,
        syncGlobalQueueLimit: -2,
      })).toEqual({ limit: 4, queueLimit: 8 });

      process.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT = '1.5';
      process.env.DKG_SYNC_GLOBAL_LIMIT = '5';
      process.env.DKG_SYNC_GLOBAL_QUEUE_LIMIT = '-1';
      expect(resolveSyncGlobalBackpressure({
        syncGlobalMaxInflight: 3,
        syncGlobalQueueLimit: 7,
      })).toEqual({ limit: 5, queueLimit: 7 });
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
