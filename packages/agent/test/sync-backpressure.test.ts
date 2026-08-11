import { describe, expect, it } from 'vitest';
import {
  backpressureRegistry,
  createOperationContext,
  getMetrics,
} from '@origintrail-official/dkg-core';
import {
  getSyncBackpressureSnapshot,
  resolveBooleanSwitch,
  resolveNonNegativeIntegerSwitch,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import {
  PriorityAdmissionQueue,
  type PriorityAdmissionAcquireOptions,
} from '../src/sync/priority-admission-queue.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function queueOptions(
  payload: string,
  priority: number,
  overrides: Partial<PriorityAdmissionAcquireOptions<string>> = {},
): PriorityAdmissionAcquireOptions<string> {
  return {
    payload,
    ownerKey: payload,
    lane: 'durable',
    priority,
    priorityClass: priority >= 2_000 ? 'elevated' : 'default',
    queueLimit: 8,
    agingThresholdMs: 10,
    createBusyError: (reason) => new Error(reason),
    createDisplacedError: () => new Error('displaced'),
    ...overrides,
  };
}

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

  it('starts foreground on the next release without preempting two active VM recoveries', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 4,
    });
    const events: string[] = [];
    let releaseVmA!: () => void;
    let releaseVmB!: () => void;
    let releaseForeground!: () => void;
    const blockingWork = (label: string, setRelease: (release: () => void) => void) =>
      async () => {
        events.push(`${label}-start`);
        await new Promise<void>((resolve) => setRelease(resolve));
        events.push(`${label}-end`);
      };

    const vmA = withGlobalSyncBackpressure({
      policy, ctx, label: 'durable:vm-a', priority: 1_000, source: 'vm-recovery',
    }, blockingWork('vm-a', (release) => { releaseVmA = release; }));
    const vmB = withGlobalSyncBackpressure({
      policy, ctx, label: 'durable:vm-b', priority: 1_000, source: 'vm-recovery',
    }, blockingWork('vm-b', (release) => { releaseVmB = release; }));
    await tick();

    const queuedVm = withGlobalSyncBackpressure({
      policy, ctx, label: 'durable:vm-c', priority: 1_000, source: 'vm-recovery',
    }, async () => { events.push('vm-c-start'); });
    const foreground = withGlobalSyncBackpressure({
      policy, ctx, label: 'durable:foreground', priority: 2_000,
      source: 'catchup-foreground',
    }, blockingWork('foreground', (release) => { releaseForeground = release; }));
    await tick();

    expect(events).toEqual(['vm-a-start', 'vm-b-start']);
    releaseVmA();
    await tick();
    expect(events).toEqual(['vm-a-start', 'vm-b-start', 'vm-a-end', 'foreground-start']);

    releaseForeground();
    await foreground;
    await tick();
    expect(events).toContain('vm-c-start');
    releaseVmB();
    await Promise.all([vmA, vmB, queuedVm]);
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
    const agentLike = {
      config: { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 },
      node: { stopSignal: undefined },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
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

  it('bounds an aged lower-priority entry behind one raw-priority overtake', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 3 });
    const events: string[] = [];
    let unblock!: () => void;
    const running = withGlobalSyncBackpressure({ policy, ctx, label: 'running' }, async () => {
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await tick();
    const agedLow = withGlobalSyncBackpressure({
      policy, ctx, label: 'aged-low', priority: -1, priorityClass: 'deprioritized',
      agingThresholdMs: 0,
    }, async () => { events.push('aged-low'); });
    const high = withGlobalSyncBackpressure({
      policy, ctx, label: 'high', priority: 100, priorityClass: 'elevated',
      agingThresholdMs: 0,
    }, async () => { events.push('high'); });
    unblock();
    await Promise.all([running, agedLow, high]);
    expect(events).toEqual(['high', 'aged-low']);
  });

  it('uses raw numeric priority and pays one aged-service debt after an overtake', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const low = queue.acquire(queueOptions('low-1000', 1_000, {
      priorityClass: 'elevated',
    }));
    const high = queue.acquire(queueOptions('high-2000', 2_000, {
      priorityClass: 'deprioritized',
    }));
    now = 20;
    enabled = true;
    queue.pump();

    const releaseHigh = await high.release;
    expect(starts).toEqual(['high-2000']);
    releaseHigh();
    const releaseLow = await low.release;
    expect(starts).toEqual(['high-2000', 'low-1000']);
    releaseLow();
  });

  it('does not let a newly arriving higher maximum rearm an existing debt', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const low = queue.acquire(queueOptions('aged-1000', 1_000));
    const firstHigh = queue.acquire(queueOptions('high-2000', 2_000));
    now = 20;
    enabled = true;
    queue.pump();
    const releaseFirstHigh = await firstHigh.release;
    const laterMaximum = queue.acquire(queueOptions('later-3000', 3_000));

    releaseFirstHigh();
    const releaseLow = await low.release;
    expect(starts).toEqual(['high-2000', 'aged-1000']);
    releaseLow();
    const releaseLaterMaximum = await laterMaximum.release;
    expect(starts).toEqual(['high-2000', 'aged-1000', 'later-3000']);
    releaseLaterMaximum();
  });

  it('keeps debt while its aged recipient is temporarily not runnable', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    let lowBlocked = true;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: (entry) => (
        enabled
        && running < 1
        && (entry.payload !== 'aged-low' || !lowBlocked)
      ),
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const low = queue.acquire(queueOptions('aged-low', 1_000));
    const firstHigh = queue.acquire(queueOptions('high-1', 2_000));
    now = 20;
    enabled = true;
    queue.pump();
    const releaseFirstHigh = await firstHigh.release;
    const secondHigh = queue.acquire(queueOptions('high-2', 2_000));

    releaseFirstHigh();
    const releaseSecondHigh = await secondHigh.release;
    expect(starts).toEqual(['high-1', 'high-2']);
    releaseSecondHigh();
    lowBlocked = false;
    queue.pump();
    const releaseLow = await low.release;
    expect(starts).toEqual(['high-1', 'high-2', 'aged-low']);
    releaseLow();
  });

  it('fills two free slots with one high overtake and the owed aged turn', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 2,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const low1 = queue.acquire(queueOptions('low-1', 1_000));
    const low2 = queue.acquire(queueOptions('low-2', 1_000));
    const high = queue.acquire(queueOptions('high', 2_000));
    now = 20;
    enabled = true;
    queue.pump();

    const releaseHigh = await high.release;
    const releaseLow1 = await low1.release;
    expect(running).toBe(2);
    expect(starts).toEqual(['high', 'low-1']);
    releaseHigh();
    const releaseLow2 = await low2.release;
    expect(starts).toEqual(['high', 'low-1', 'low-2']);
    releaseLow1();
    releaseLow2();
  });

  it('protects one oldest aged lower-priority entry from a displacement flood', async () => {
    let now = 0;
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });
    const atCapacity = { queueLimit: 4 };

    const blocker = queue.acquire(queueOptions('blocker', 0, atCapacity));
    const releaseBlocker = await blocker.release;
    const oldest = queue.acquire(queueOptions('oldest-aged', 0, atCapacity));
    const replaceable = queue.acquire(queueOptions('replaceable-aged', 0, atCapacity));
    const medium = queue.acquire(queueOptions('medium', 5, atCapacity));
    const upper = queue.acquire(queueOptions('upper', 6, atCapacity));
    const displaced = replaceable.release.catch((error: unknown) => error);
    now = 20;
    const high = queue.acquire(queueOptions('high', 10, atCapacity));

    expect(await displaced).toMatchObject({ message: 'displaced' });
    expect(queue.entries().map((entry) => entry.payload)).toContain('oldest-aged');
    expect(queue.entries().map((entry) => entry.payload)).not.toContain('replaceable-aged');

    releaseBlocker();
    const releaseHigh = await high.release;
    releaseHigh();
    const releaseOldest = await oldest.release;
    releaseOldest();
    const releaseUpper = await upper.release;
    releaseUpper();
    const releaseMedium = await medium.release;
    releaseMedium();
    expect(starts).toEqual(['blocker', 'high', 'oldest-aged', 'upper', 'medium']);
  });

  it('protects the sole aged entry when the queue limit is one', async () => {
    let now = 0;
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });
    const oneSlot = { queueLimit: 1 };

    const blocker = queue.acquire(queueOptions('blocker', 0, oneSlot));
    const releaseBlocker = await blocker.release;
    const aged = queue.acquire(queueOptions('aged', 0, oneSlot));
    now = 20;

    expect(() => queue.acquire(queueOptions('high', 10, oneSlot))).toThrow('global_queue_full');
    expect(queue.entries().map((entry) => entry.payload)).toEqual(['aged']);

    releaseBlocker();
    const releaseAged = await aged.release;
    releaseAged();
    expect(starts).toEqual(['blocker', 'aged']);
  });

  it('clears debt when its last aged recipient is cancelled', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const controller = new AbortController();
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const cancelled = queue.acquire(queueOptions('cancelled-low', 1_000, {
      signal: controller.signal,
    }));
    const firstHigh = queue.acquire(queueOptions('first-high', 2_000));
    now = 20;
    enabled = true;
    queue.pump();
    const releaseFirstHigh = await firstHigh.release;
    controller.abort(new Error('cancelled'));
    await expect(cancelled.release).rejects.toThrow('cancelled');

    const nextLow = queue.acquire(queueOptions('next-low', 1_000));
    const nextHigh = queue.acquire(queueOptions('next-high', 2_000));
    now = 40;
    releaseFirstHigh();
    const releaseNextHigh = await nextHigh.release;
    expect(starts).toEqual(['first-high', 'next-high']);
    releaseNextHigh();
    const releaseNextLow = await nextLow.release;
    releaseNextLow();
  });

  it('clears debt when its last aged recipient times out', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const timedOut = queue.acquire(queueOptions('timed-out-low', 1_000, {
      timeoutMs: 5,
      createTimeoutError: () => new Error('timed out'),
    }));
    const timeoutResult = timedOut.release.catch((error: unknown) => error);
    const firstHigh = queue.acquire(queueOptions('first-high', 2_000));
    now = 20;
    enabled = true;
    queue.pump();
    const releaseFirstHigh = await firstHigh.release;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await timeoutResult).toMatchObject({ message: 'timed out' });

    const nextLow = queue.acquire(queueOptions('next-low', 1_000));
    const nextHigh = queue.acquire(queueOptions('next-high', 2_000));
    now = 40;
    releaseFirstHigh();
    const releaseNextHigh = await nextHigh.release;
    expect(starts).toEqual(['first-high', 'next-high']);
    releaseNextHigh();
    const releaseNextLow = await nextLow.release;
    releaseNextLow();
  });

  it('records a queued timeout as a rejected scheduler decision', async () => {
    let running = 0;
    const decisionCounter = getMetrics().syncSchedulerDecisionsTotal as unknown as {
      add(value: number, attributes: Record<string, unknown>): void;
    };
    const originalAdd = decisionCounter.add;
    const decisions: Array<Record<string, unknown>> = [];
    decisionCounter.add = (_value, attributes) => { decisions.push(attributes); };
    try {
      const queue = new PriorityAdmissionQueue<string>({
        canRun: () => running < 1,
        onStart: () => {
          running += 1;
          return () => { running -= 1; };
        },
      });
      const active = queue.acquire(queueOptions('active', 0));
      const releaseActive = await active.release;
      const timedOut = queue.acquire(queueOptions('timed-out', 0, {
        timeoutMs: 5,
        createTimeoutError: () => new Error('timed out'),
      }));

      await expect(timedOut.release).rejects.toThrow('timed out');
      expect(decisions).toContainEqual({
        lane: 'durable', priority_class: 'default', outcome: 'rejected',
      });
      releaseActive();
    } finally {
      decisionCounter.add = originalAdd;
    }
  });

  it('preserves debt across a running-to-queued responder handoff', async () => {
    let now = 0;
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const first = queue.acquire(queueOptions('first-stage', 0, {
      ownerKey: 'peer-a',
      queueLimit: 4,
      ownerQueueLimit: 4,
      reserveForHandoff: true,
    }));
    const releaseFirst = await first.release;
    const low = queue.acquire(queueOptions('aged-low', 1_000, {
      ownerKey: 'peer-b',
      queueLimit: 4,
      ownerQueueLimit: 4,
    }));
    now = 20;
    const high = queue.acquire(queueOptions('high-2000', 2_000, {
      ownerKey: 'peer-c',
      queueLimit: 4,
      ownerQueueLimit: 4,
    }));
    const handoff = first.handoff!({
      payload: 'handoff-3000',
      lane: 'responder',
      priority: 3_000,
      priorityClass: 'deprioritized',
      agingThresholdMs: 10,
      createBusyError: (reason) => new Error(reason),
      createDisplacedError: () => new Error('displaced'),
    });

    releaseFirst();
    const releaseHandoff = await handoff.release;
    releaseHandoff();
    const releaseLow = await low.release;
    expect(starts).toEqual(['first-stage', 'handoff-3000', 'aged-low']);
    releaseLow();
    const releaseHigh = await high.release;
    releaseHigh();
  });

  it('creates fairness debt only after onStart succeeds', async () => {
    let now = 0;
    let running = 0;
    let enabled = false;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => enabled && running < 1,
      onStart: (entry) => {
        if (entry.payload === 'failing-3000') throw new Error('start failed');
        running += 1;
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
    });

    const low = queue.acquire(queueOptions('aged-1000', 1_000));
    const medium = queue.acquire(queueOptions('medium-2000', 2_000));
    const failing = queue.acquire(queueOptions('failing-3000', 3_000));
    const failed = failing.release.catch((error: unknown) => error);
    now = 20;
    enabled = true;
    queue.pump();

    expect(await failed).toMatchObject({ message: 'start failed' });
    const releaseMedium = await medium.release;
    expect(starts).toEqual(['medium-2000']);
    releaseMedium();
    const releaseLow = await low.release;
    releaseLow();
  });

  it('uses genuinely free capacity when older work is blocked by its own lower limit', async () => {
    type MixedPolicyPayload = { name: string; inflightLimit: number };
    let now = 0;
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<MixedPolicyPayload>({
      now: () => now,
      canRun: (entry) => running < entry.payload.inflightLimit,
      onStart: (entry) => {
        running += 1;
        starts.push(entry.payload.name);
        return () => { running -= 1; };
      },
    });
    const options = (name: string, inflightLimit: number, priority: number) => ({
      payload: { name, inflightLimit },
      ownerKey: name,
      lane: 'durable' as const,
      priority,
      priorityClass: priority > 0 ? 'elevated' as const : 'default' as const,
      queueLimit: 1,
      agingThresholdMs: 10,
      createBusyError: (reason: string) => new Error(reason),
      createDisplacedError: () => new Error('displaced'),
    });

    const blocker = queue.acquire(options('limit-one-blocker', 1, 0));
    const releaseBlocker = await blocker.release;
    const aged = queue.acquire(options('aged-limit-one', 1, 0));
    now = 20;

    const higherCapacity = queue.acquire(options('limit-two-foreground', 2, 1));
    expect(higherCapacity.status).toBe('running');
    const releaseHigherCapacity = await higherCapacity.release;
    expect(starts).toEqual(['limit-one-blocker', 'limit-two-foreground']);
    expect(aged.status).toBe('queued');

    releaseHigherCapacity();
    releaseBlocker();
    const releaseAged = await aged.release;
    expect(starts).toEqual([
      'limit-one-blocker',
      'limit-two-foreground',
      'aged-limit-one',
    ]);
    releaseAged();
  });

  it('rolls back direct-start capacity when onStart throws after claiming it', async () => {
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        if (entry.payload === 'failing') throw new Error('start failed after claim');
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
      onStartFailureRollback: () => { running -= 1; },
    });

    expect(() => queue.acquire(queueOptions('failing', 0))).toThrow(
      'start failed after claim',
    );
    expect(running).toBe(0);

    const subsequent = queue.acquire(queueOptions('subsequent', 0));
    const releaseSubsequent = await subsequent.release;
    expect(subsequent.status).toBe('running');
    expect(starts).toEqual(['subsequent']);
    expect(running).toBe(1);
    releaseSubsequent();
    expect(running).toBe(0);
  });

  it('rolls back queued-start capacity and starts the next waiter in the same pump', async () => {
    let running = 0;
    const starts: string[] = [];
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: (entry) => {
        running += 1;
        if (entry.payload === 'failing') throw new Error('queued start failed after claim');
        starts.push(entry.payload);
        return () => { running -= 1; };
      },
      onStartFailureRollback: () => { running -= 1; },
    });

    const blocker = queue.acquire(queueOptions('blocker', 0));
    const releaseBlocker = await blocker.release;
    const failing = queue.acquire(queueOptions('failing', 10));
    const failingResult = failing.release.catch((error: unknown) => error);
    const subsequent = queue.acquire(queueOptions('subsequent', 0));

    releaseBlocker();

    expect(await failingResult).toMatchObject({ message: 'queued start failed after claim' });
    const releaseSubsequent = await subsequent.release;
    expect(starts).toEqual(['blocker', 'subsequent']);
    expect(running).toBe(1);
    expect(queue.length).toBe(0);
    releaseSubsequent();
    expect(running).toBe(0);
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
      now: () => now,
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
      },
    });
    const options = (payload: string) => ({
      payload,
      lane: 'durable' as const,
      priority: 0,
      priorityClass: 'default' as const,
      queueLimit: 2,
      agingThresholdMs: 30_000,
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
    expect(queue.oldestAgeMs()).toBe(6_000);

    releaseFirst();
    const releaseSecond = await second.release;
    releaseSecond();
    expect(queue.getBackpressureSnapshot()).toMatchObject({
      state: 'healthy',
      totals: { queued: 0, inflight: 0 },
    });
  });

  it('reports every lane holding work as saturated the moment the shared queue fills', async () => {
    // The clock is frozen for the whole test and the queue is filled to exactly
    // its limit, never past it — so every age is 0 and nothing is ever
    // rejected. Queue depth is the only signal left that can move a lane off
    // `healthy`; without the freeze this would pass on `degradedQueueAgeMs` and
    // prove nothing about the depth branch.
    let running = 0;
    const now = 1_000;
    const queue = new PriorityAdmissionQueue<string>({
      now: () => now,
      canRun: () => running < 1,
      onStart: () => {
        running += 1;
        return () => { running -= 1; };
      },
      observability: {
        scheduler: 'test-shared-pool',
        operation: (entry) => entry.payload,
        inflightLimit: () => 1,
      },
    });
    const options = (
      payload: string,
      lane: PriorityAdmissionAcquireOptions<string>['lane'],
    ): PriorityAdmissionAcquireOptions<string> => ({
      payload,
      lane,
      priority: 0,
      priorityClass: 'default',
      queueLimit: 2,
      agingThresholdMs: 30_000,
      createBusyError: () => new Error('full'),
      createDisplacedError: () => new Error('displaced'),
    });

    // One admitted, then both queue slots taken by DIFFERENT lanes. The spread
    // is the point: neither lane holds more than half the queue, so a lane
    // judged on its own depth reads 1/2 and stays `healthy` while the pool it
    // draws on is full and the next admission in either lane is rejected.
    const admitted = queue.acquire(options('running', 'swm_recovery'));
    const release = await admitted.release;
    const queuedDurable = queue.acquire(options('durable-wait', 'durable'));
    const queuedChangelog = queue.acquire(options('changelog-wait', 'changelog'));

    try {
      const snapshot = queue.getBackpressureSnapshot();
      expect(snapshot).toMatchObject({
        state: 'saturated',
        totals: { queued: 2, queueLimit: 2, inflight: 1, inflightLimit: 1 },
        lanes: [
          // `queued` attributes the work; `pressureQueued` is the depth the
          // state was judged against, so `pressureQueued / queueLimit` reads as
          // utilization without a consumer having to know the model.
          { lane: 'changelog', state: 'saturated', capacityModel: 'shared', queued: 1, pressureQueued: 2, queueLimit: 2 },
          { lane: 'durable', state: 'saturated', capacityModel: 'shared', queued: 1, pressureQueued: 2, queueLimit: 2 },
          // Admitted work, nothing waiting: a full queue is not evidence that
          // this lane is being held back, and it publishes no pressure depth
          // either — a `healthy` lane must not read as 100% utilized.
          {
            lane: 'swm_recovery',
            state: 'healthy',
            capacityModel: 'shared',
            queued: 0,
            pressureQueued: 0,
            inflight: 1,
          },
        ],
      });
      for (const lane of snapshot.lanes) {
        expect(lane).toMatchObject({
          oldestQueuedAgeMs: 0,
          oldestActiveAgeMs: 0,
          rejectedTotal: 0,
          lastRejectedAgeMs: null,
        });
      }
    } finally {
      // Serially: only one may run at a time, so waiting on both releases at
      // once would deadlock — the second cannot start until the first has been
      // released, and the first is not released until the wait returns.
      release();
      (await queuedDurable.release)();
      (await queuedChangelog.release)();
    }
  });

  it('declares the shared pool from registration, before any admission', async () => {
    // Every other snapshot in this file is taken post-acquire, so the model
    // declared in the constructor was pinned by nothing: deleting it left the
    // whole suite green while a freshly booted daemon advertised `partitioned`
    // on the field documented as authoritative — permanently so with
    // DKG_SYNC_GLOBAL_MAX_INFLIGHT=0, where no acquire ever runs.
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => true,
      onStart: () => () => {},
      observability: {
        scheduler: 'test-pre-acquire',
        operation: (entry) => entry.payload,
      },
    });

    expect(queue.getBackpressureSnapshot()).toMatchObject({
      capacityModel: 'shared',
      // …and no ceiling is fabricated ahead of the first acquire, which is what
      // actually carries the limits.
      totals: { queueLimit: null, inflightLimit: null },
    });
  });

  it('publishes the shared-pool capacity model from the production sync-global queue', async () => {
    // The seam the core classifier cannot see. `sync-global` is a module
    // singleton built in `backpressure.ts`, and the capacity IT publishes is
    // what decides whether its lanes can be classified on depth at all.
    // Asserting the published model rather than a resulting state keeps this
    // witness independent of the rejection counters that earlier tests in this
    // file leave behind on the shared singleton.
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 2,
    });
    let releaseRunning!: () => void;
    const running = withGlobalSyncBackpressure(
      { policy, ctx, label: 'durable:urn:cg:private:pool', source: 'catchup-foreground' },
      async () => new Promise<void>((resolve) => { releaseRunning = resolve; }),
    );
    await tick();

    try {
      const snapshot = backpressureRegistry.capture().schedulers.find(
        (scheduler) => scheduler.scheduler === 'sync-global',
      );
      // The scheduler-level ceilings are what a shared lane's ceiling resolves
      // to, so dropping either one from the publish would silently take the
      // depth branches back out of service.
      expect(snapshot).toMatchObject({
        capacityModel: 'shared',
        totals: { queueLimit: 2, inflightLimit: 1 },
      });
      // Scoping this to one lane would be decorative: under `shared` every
      // field below resolves from scheduler-level capacity, so it is identical
      // on every row — and `this.lanes` is never pruned, so a `find` can match
      // a stale row an earlier test left on the module singleton. Assert the
      // property over ALL rows instead, plus the one genuinely lane-scoped
      // fact: the admission just made is active in the lane it was sent to.
      expect(snapshot!.lanes.length).toBeGreaterThan(0);
      for (const lane of snapshot!.lanes) {
        expect(lane).toMatchObject({ capacityModel: 'shared', queueLimit: 2, inflightLimit: 1 });
      }
      const durable = snapshot!.lanes.find((lane) => lane.lane === 'durable');
      expect(durable).toMatchObject({
        inflight: 1,
        activeOperations: [expect.objectContaining({ operation: 'durable:catchup-foreground' })],
      });
    } finally {
      releaseRunning();
      await running;
    }
  });

  it('reserves one selected-provider slot from every automatic background source', async () => {
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 4,
      selectedRecoveryContextGraphIds: ['urn:cg:selected'],
    });
    const events: string[] = [];
    let releaseRoutine!: () => void;
    let releaseShared!: () => void;

    const changelogA = withGlobalSyncBackpressure({
      policy,
      ctx,
      label: 'changelog:core-a',
      lane: 'changelog',
      source: 'on-connect',
    }, async () => new Promise<void>((resolve) => {
      events.push('changelog-a-start');
      releaseRoutine = resolve;
    }));
    await tick();
    const vmRecovery = withGlobalSyncBackpressure({
      policy,
      ctx,
      label: 'durable:vm-recovery',
      lane: 'durable',
      priority: 1_000,
      source: 'vm-recovery',
    }, async () => {
      events.push('vm-recovery-start');
    });
    await tick();
    const ordinaryShared = withGlobalSyncBackpressure({
      policy,
      ctx,
      label: 'shared-memory:ordinary-provider',
      lane: 'shared_memory',
      source: 'on-connect',
    }, async () => {
      events.push('ordinary-shared-start');
    });
    await tick();
    const shared = withGlobalSyncBackpressure({
      policy,
      ctx,
      label: 'shared-memory:selected-provider',
      lane: 'shared_memory',
      priority: 2_000,
      source: 'on-connect',
      selectedSwmPriority: true,
    }, async () => new Promise<void>((resolve) => {
      events.push('shared-start');
      releaseShared = resolve;
    }));
    await tick();

    expect(events).toEqual(['changelog-a-start', 'shared-start']);
    releaseShared();
    await shared;
    expect(events).toEqual(['changelog-a-start', 'shared-start']);
    releaseRoutine();
    await Promise.all([changelogA, vmRecovery, ordinaryShared]);
    expect(events).toEqual([
      'changelog-a-start',
      'shared-start',
      'vm-recovery-start',
      'ordinary-shared-start',
    ]);
  });

  it('keeps one selected-scope slot available while foreground catch-up fans out', async () => {
    const ctx = createOperationContext('sync');
    const selectedCg = 'urn:cg:selected';
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 6,
      selectedRecoveryContextGraphIds: [selectedCg],
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseRecovery!: () => void;

    const first = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'durable:selected-a',
      lane: 'durable',
      source: 'catchup-foreground',
    }, async () => new Promise<void>((resolve) => {
      events.push('first-catchup-start');
      releaseFirst = resolve;
    }));
    await tick();
    const duplicate = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'durable:selected-b',
      lane: 'durable',
      source: 'catchup-foreground',
    }, async () => {
      events.push('duplicate-catchup-start');
    });
    await tick();
    expect(events).toEqual(['first-catchup-start']);

    const recovery = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'durable:selected-recovery',
      lane: 'durable',
      priority: 1_000,
      source: 'vm-recovery',
    }, async () => new Promise<void>((resolve) => {
      events.push('recovery-start');
      releaseRecovery = resolve;
    }));
    await tick();
    expect(events).toEqual(['first-catchup-start', 'recovery-start']);

    releaseRecovery();
    await recovery;
    expect(events).toEqual(['first-catchup-start', 'recovery-start']);
    releaseFirst();
    await Promise.all([first, duplicate]);
    expect(events).toEqual([
      'first-catchup-start',
      'recovery-start',
      'duplicate-catchup-start',
    ]);
  });

  it('admits selected SWM recovery before queued same-scope foreground fanout', async () => {
    const ctx = createOperationContext('sync');
    const selectedCg = 'urn:cg:selected-swm';
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 6,
      selectedRecoveryContextGraphIds: [selectedCg],
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSelectedSwm!: () => void;

    const first = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'durable:selected-first',
      lane: 'durable',
      source: 'catchup-foreground',
    }, async () => new Promise<void>((resolve) => {
      events.push('first-catchup-start');
      releaseFirst = resolve;
    }));
    await tick();
    const duplicate = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'durable:selected-duplicate',
      lane: 'durable',
      source: 'catchup-foreground',
    }, async () => {
      events.push('duplicate-catchup-start');
    });
    await tick();

    const selectedSwm = withGlobalSyncBackpressure({
      policy,
      ctx,
      contextGraphId: selectedCg,
      label: 'shared-memory:selected-recovery',
      lane: 'shared_memory',
      priority: 2_000,
      source: 'on-connect',
      selectedSwmPriority: true,
    }, async () => new Promise<void>((resolve) => {
      events.push('selected-swm-start');
      releaseSelectedSwm = resolve;
    }));
    await tick();

    expect(events).toEqual(['first-catchup-start', 'selected-swm-start']);
    releaseSelectedSwm();
    await selectedSwm;
    releaseFirst();
    await Promise.all([first, duplicate]);
    expect(events).toEqual([
      'first-catchup-start',
      'selected-swm-start',
      'duplicate-catchup-start',
    ]);
  });

  it('does not reserve capacity for unrelated foreground catch-up', async () => {
    const ctx = createOperationContext('sync');
    const selectedCg = 'urn:cg:selected';
    const policy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: 2,
      syncGlobalQueueLimit: 4,
      selectedRecoveryContextGraphIds: [selectedCg],
    });
    const events: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const run = (label: string, onRelease: (release: () => void) => void) => (
      withGlobalSyncBackpressure({
        policy,
        ctx,
        contextGraphId: 'urn:cg:ordinary',
        label,
        lane: 'durable',
        source: 'catchup-foreground',
      }, async () => new Promise<void>((resolve) => {
        events.push(label);
        onRelease(resolve);
      }))
    );
    const first = run('ordinary-a', (release) => { releaseA = release; });
    await tick();
    const second = run('ordinary-b', (release) => { releaseB = release; });
    await tick();
    expect(events).toEqual(['ordinary-a', 'ordinary-b']);
    releaseA();
    releaseB();
    await Promise.all([first, second]);
  });
});
