import { describe, expect, it } from 'vitest';
import {
  backpressureRegistry,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import {
  getSyncBackpressureSnapshot,
  notifyGlobalSyncBackpressureCapacityChanged,
  resolveBooleanSwitch,
  resolveNonNegativeIntegerSwitch,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { PriorityAdmissionQueue } from '../src/sync/priority-admission-queue.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sync global backpressure', () => {
  it('preserves the original FIFO sequence across a running-to-queued handoff', async () => {
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });
    const options = (payload: string, reserveForHandoff = false) => ({
      payload,
      ownerKey: payload,
      lane: 'responder' as const,
      priority: 1,
      priorityClass: 'elevated' as const,
      queueLimit: 2,
      agingThresholdMs: 30_000,
      reserveForHandoff,
      createBusyError: () => new Error('full'),
      createDisplacedError: () => new Error('displaced'),
    });

    const first = queue.acquire(options('first', true));
    const releaseFirst = await first.release;
    const later = queue.acquire(options('later'));
    const handoff = first.handoff!({
      payload: 'handoff',
      lane: 'responder',
      priority: 1,
      priorityClass: 'elevated',
      agingThresholdMs: 30_000,
      createBusyError: () => new Error('full'),
      createDisplacedError: () => new Error('displaced'),
    });

    releaseFirst();
    const releaseHandoff = await handoff.release;
    expect(starts).toEqual(['first', 'handoff']);
    releaseHandoff();
    const releaseLater = await later.release;
    expect(starts).toEqual(['first', 'handoff', 'later']);
    releaseLater();
  });

  it('keeps handoff reservations within global and per-owner caps without stranding another owner', async () => {
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });
    const options = (payload: string, ownerKey: string, priority = 0, reserveForHandoff = false) => ({
      payload,
      ownerKey,
      lane: 'responder' as const,
      priority,
      priorityClass: (priority > 0 ? 'elevated' : 'default') as 'elevated' | 'default',
      queueLimit: 5,
      ownerQueueLimit: 4,
      agingThresholdMs: 30_000,
      reserveForHandoff,
      createBusyError: (reason: string) => new Error(reason),
      createDisplacedError: () => new Error('displaced'),
    });

    const first = queue.acquire(options('a-running', 'peer-a', 0, true));
    const releaseFirst = await first.release;
    const a2 = queue.acquire(options('a-2', 'peer-a'));
    const a3 = queue.acquire(options('a-3', 'peer-a'));
    const a4 = queue.acquire(options('a-4', 'peer-a'));
    expect(() => queue.acquire(options('a-5', 'peer-a'))).toThrow('owner_queue_full');
    const b = queue.acquire(options('b-elevated', 'peer-b', 10));
    const handoff = first.handoff!({
      payload: 'a-handoff',
      lane: 'responder',
      priority: 0,
      priorityClass: 'default',
      agingThresholdMs: 30_000,
      createBusyError: (reason) => new Error(reason),
      createDisplacedError: () => new Error('displaced'),
    });
    expect(queue.length).toBe(5);

    releaseFirst();
    const releaseB = await b.release;
    expect(starts).toEqual(['a-running', 'b-elevated']);
    releaseB();
    const releaseHandoff = await handoff.release;
    expect(starts).toEqual(['a-running', 'b-elevated', 'a-handoff']);
    releaseHandoff();
    for (const queued of [a2, a3, a4]) {
      const release = await queued.release;
      release();
    }
  });

  it('cleans a displaced entry once so its timeout cannot corrupt later admissions', async () => {
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });
    const acquire = (payload: string, priority: number) => queue.acquire({
      payload,
      ownerKey: payload,
      lane: 'responder',
      priority,
      priorityClass: priority > 0 ? 'elevated' : 'deprioritized',
      queueLimit: 1,
      timeoutMs: payload === 'low' ? 10 : 100,
      agingThresholdMs: 30_000,
      createBusyError: () => new Error('full'),
      createDisplacedError: () => new Error('displaced'),
      createTimeoutError: () => new Error('timed out'),
    });

    const first = acquire('first', 0);
    const releaseFirst = await first.release;
    const low = acquire('low', -1);
    const high = acquire('high', 1);
    await expect(low.release).rejects.toThrow('displaced');
    await new Promise((resolve) => setTimeout(resolve, 20));

    releaseFirst();
    const releaseHigh = await high.release;
    releaseHigh();
    expect(starts).toEqual(['first', 'high']);
    expect(queue.length).toBe(0);
  });

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

  it('preserves the static admission API and configured concurrency when no resolver is supplied', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 1,
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    const first = withGlobalSyncBackpressure({ policy, ctx, label: 'static-first' }, async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const second = withGlobalSyncBackpressure({ policy, ctx, label: 'static-second' }, async () => {
      events.push('second-start');
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    });
    await tick();

    expect(events).toEqual(['first-start', 'second-start']);
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({
      inflight: 2,
      queued: 0,
      limit: 2,
      queueLimit: 1,
    });

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
  });

  it('lets a lower effective limit drain without cancelling already-running work', async () => {
    const ctx = createOperationContext('sync');
    let currentLimit = 2;
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 1,
    }, () => currentLimit);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const options = (label: string) => ({ policy, ctx, label });

    const first = withGlobalSyncBackpressure(options('dynamic-first'), async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push('first-end');
    });
    const second = withGlobalSyncBackpressure(options('dynamic-second'), async () => {
      events.push('second-start');
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
      events.push('second-end');
    });
    await tick();
    expect(events).toEqual(['first-start', 'second-start']);

    currentLimit = 1;
    notifyGlobalSyncBackpressureCapacityChanged();
    const third = withGlobalSyncBackpressure(options('dynamic-third'), async () => {
      events.push('third-start');
    });
    await tick();
    expect(events).toEqual(['first-start', 'second-start']);

    releaseFirst();
    await first;
    await tick();
    expect(events).toEqual(['first-start', 'second-start', 'first-end']);

    releaseSecond();
    await Promise.all([second, third]);
    expect(events).toEqual([
      'first-start',
      'second-start',
      'first-end',
      'second-end',
      'third-start',
    ]);
  });

  it('pumps already-queued work immediately when the effective limit increases', async () => {
    const ctx = createOperationContext('sync');
    let currentLimit = 1;
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 1,
    }, () => currentLimit);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const options = (label: string) => ({ policy, ctx, label });

    const first = withGlobalSyncBackpressure(options('dynamic-first'), async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await tick();
    const second = withGlobalSyncBackpressure(options('dynamic-second'), async () => {
      events.push('second-start');
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    });
    await tick();
    expect(events).toEqual(['first-start']);
    expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 1, limit: 1 });

    currentLimit = 2;
    notifyGlobalSyncBackpressureCapacityChanged();
    await tick();
    expect(events).toEqual(['first-start', 'second-start']);
    expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 2, queued: 0, limit: 2 });

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
  });

  it('retains the last valid shared capacity when the policy resolver fails', async () => {
    const ctx = createOperationContext('sync');
    let currentLimit = 1;
    let resolverFails = false;
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 1,
    }, () => {
      if (resolverFails) throw new Error('capacity sample unavailable');
      return currentLimit;
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    const first = withGlobalSyncBackpressure({ policy, ctx, label: 'dynamic-first' }, async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await tick();
    const second = withGlobalSyncBackpressure({ policy, ctx, label: 'dynamic-second' }, async () => {
      events.push('second-start');
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    });
    await tick();
    expect(events).toEqual(['first-start']);

    currentLimit = 2;
    resolverFails = true;
    notifyGlobalSyncBackpressureCapacityChanged();
    await tick();
    expect(events).toEqual(['first-start']);
    expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 1, limit: 1 });

    resolverFails = false;
    currentLimit = 0;
    notifyGlobalSyncBackpressureCapacityChanged();
    await tick();
    expect(events).toEqual(['first-start']);
    expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 1, limit: 1 });

    currentLimit = 2;
    notifyGlobalSyncBackpressureCapacityChanged();
    await tick();
    expect(events).toEqual(['first-start', 'second-start']);

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
  });

  it('carries the admission source from the production helper through to the scheduler', async () => {
    // The two halves of this contract were covered separately: the call sites
    // were proven to SUPPLY a source, and `withGlobalSyncBackpressure` was proven
    // to RENDER it as `<work class>:<source>`. Nothing covered the line between
    // them — the `source,` handed to `withGlobalSyncBackpressure` inside
    // `runContextGraphSyncWithBackpressure`. Dropping it leaves both groups green
    // while every real admission reports `durable:unspecified` on
    // /api/diagnostics/backpressure, which is the attribution issue #2006 had to
    // reconstruct from daemon logs.
    const config = { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 };
    const agentLike = {
      config,
      node: { stopSignal: undefined },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      syncCapacityRuntime: {
        getAdmissionOptions: () => ({ policy: resolveSyncGlobalBackpressure(config) }),
      },
    };

    let releaseWork!: () => void;
    const admitted = LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure.call(
      agentLike as never,
      createOperationContext('sync'),
      'urn:cg:private:e2e',
      'durable' as never,
      'durable:urn:cg:private:e2e',
      () => new Promise<void>((resolve) => { releaseWork = resolve; }),
      { source: 'catchup-foreground' },
    );
    await tick();

    // Release in `finally`: this admission is registered in the SHARED
    // backpressureRegistry, so a failed assertion that skipped the release would
    // leave it active and cascade into every later test in this file.
    try {
      const snapshot = backpressureRegistry.capture().schedulers.find(
        (scheduler) => scheduler.scheduler === 'sync-global',
      );
      expect(snapshot).toMatchObject({
        lanes: [expect.objectContaining({
          activeOperations: [expect.objectContaining({ operation: 'durable:catchup-foreground' })],
        })],
      });
      // …and the Context Graph id still never reaches node-wide diagnostics.
      expect(JSON.stringify(snapshot)).not.toContain('urn:cg:private');
    } finally {
      releaseWork();
      await admitted;
    }
  });

  it('removes CG and peer correlation identifiers from node-wide pressure diagnostics', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 1,
    });
    let releaseRunning!: () => void;
    const running = withGlobalSyncBackpressure(
      {
        policy,
        ctx,
        label: 'durable:urn:cg:private:peer-a',
        source: 'catchup-foreground',
      },
      async () => new Promise<void>((resolve) => {
        releaseRunning = resolve;
      }),
    );
    await tick();
    const queued = withGlobalSyncBackpressure(
      {
        policy,
        ctx,
        label: 'swm-recovery:urn:cg:private:peer-b',
        source: 'reconcile',
      },
      async () => undefined,
    );
    await tick();

    const snapshot = backpressureRegistry.capture().schedulers.find(
      (scheduler) => scheduler.scheduler === 'sync-global',
    );
    // The operation dimension pairs the collapsed work class with the bounded
    // admission origin, so a saturated queue can be attributed to a trigger
    // (issue #2006 had to reconstruct that from daemon logs) without any
    // Context Graph or peer identifier reaching node-wide diagnostics.
    expect(snapshot).toMatchObject({
      lanes: [expect.objectContaining({
        activeOperations: [expect.objectContaining({ operation: 'durable:catchup-foreground' })],
        queuedOperations: [expect.objectContaining({ operation: 'swm-recovery:reconcile' })],
      })],
    });
    expect(JSON.stringify(snapshot)).not.toContain('urn:cg:private');
    expect(JSON.stringify(snapshot)).not.toContain('peer-a');
    expect(JSON.stringify(snapshot)).not.toContain('peer-b');

    releaseRunning();
    await Promise.all([running, queued]);
  });

  it('clamps an unknown admission origin instead of widening the diagnostic label space', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 1,
    });
    let releaseRunning!: () => void;
    // The union is compile-time only; a value crossing the worker RPC boundary
    // (or an outright cast) must not be able to smuggle an identifier into a
    // metric/log dimension or blow up its cardinality.
    const running = withGlobalSyncBackpressure(
      {
        policy,
        ctx,
        label: 'durable:cg-x:peer-x',
        // The option is typed `SyncAdmissionSource`; the cast is the point —
        // the scheduler clamp is defence in depth for exactly this.
        source: 'leak-urn:cg:private:xyz' as never,
      },
      async () => new Promise<void>((resolve) => {
        releaseRunning = resolve;
      }),
    );
    await tick();

    const snapshot = backpressureRegistry.capture().schedulers.find(
      (scheduler) => scheduler.scheduler === 'sync-global',
    );
    expect(snapshot).toMatchObject({
      lanes: [expect.objectContaining({
        activeOperations: [expect.objectContaining({ operation: 'durable:unspecified' })],
      })],
    });
    expect(JSON.stringify(snapshot)).not.toContain('leak-');
    expect(JSON.stringify(snapshot)).not.toContain('urn:cg:private');

    releaseRunning();
    await running;
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

  it('projects priority admission through the generic pressure snapshot', async () => {
    let running = 0;
    let now = 1_000;
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: () => {
        running += 1;
        return () => { running -= 1; };
      },
      observability: {
        scheduler: 'test-sync',
        operation: (entry) => entry.payload,
        inflightLimit: () => 1,
        thresholds: { degradedQueueAgeMs: 5_000 },
        now: () => now,
      },
    });
    const options = (payload: string) => ({
      payload,
      lane: 'durable' as const,
      priority: 0,
      priorityClass: 'default' as const,
      queueLimit: 2,
      agingThresholdMs: 30_000,
      now: () => now,
      createBusyError: () => new Error('full'),
      createDisplacedError: () => new Error('displaced'),
    });

    const first = queue.acquire(options('first'));
    const releaseFirst = await first.release;
    const second = queue.acquire(options('second'));
    now += 6_000;

    expect(queue.getBackpressureSnapshot()).toMatchObject({
      scheduler: 'test-sync',
      state: 'degraded',
      totals: {
        queued: 1,
        queueLimit: 2,
        inflight: 1,
        inflightLimit: 1,
      },
      lanes: [{
        lane: 'durable',
        queuedOperations: [{
          operation: 'second',
          count: 1,
          oldestAgeMs: 6_000,
        }],
      }],
    });

    releaseFirst();
    const releaseSecond = await second.release;
    releaseSecond();
    expect(queue.getBackpressureSnapshot()).toMatchObject({
      state: 'healthy',
      totals: { queued: 0, inflight: 0 },
    });
  });
});
