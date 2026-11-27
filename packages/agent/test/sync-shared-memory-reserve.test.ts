import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backpressureRegistry,
  createOperationContext,
  getMetrics,
} from '@origintrail-official/dkg-core';
import {
  DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT,
  DEFAULT_SYNC_SHARED_MEMORY_QUEUE_TIMEOUT_MS,
} from '../src/sync/shared-memory-reserve.js';
import {
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  syncAdmissionWouldBeRefused,
  withGlobalSyncBackpressure,
  type SyncGlobalBackpressurePolicy,
} from '../src/sync/backpressure.js';
import { PriorityAdmissionQueue } from '../src/sync/priority-admission-queue.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { SyncAdmissionSource, SyncSchedulerLane } from '../src/sync/policy.js';

// Issue #3251, member B: a node configured with one sync slot and no queue
// (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`) spent minutes on a
// large Verified Memory transfer of another graph, and every pull of a small
// graph's shared memory was refused at once with
// "Sync backpressure rejected shared-memory:<G>:<peer> (global inflight=1/1, queued=0/0)".

const RESERVE_ENV = 'DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT';
const ctx = createOperationContext('sync');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Admission {
  policy: SyncGlobalBackpressurePolicy;
  ctx: typeof ctx;
  label: string;
  contextGraphId?: string;
  lane: SyncSchedulerLane;
  source: SyncAdmissionSource;
  priority?: number;
  reservedSlotOnly?: boolean;
  logInfo?: (opCtx: unknown, message: string) => void;
}

function largeTransfer(policy: SyncGlobalBackpressurePolicy, contextGraphId = 'urn:cg:large'): Admission {
  return {
    policy,
    ctx,
    contextGraphId,
    label: `durable:${contextGraphId}:peer`,
    lane: 'durable',
    source: 'vm-recovery',
  };
}

function sharedMemoryPull(
  policy: SyncGlobalBackpressurePolicy,
  contextGraphId: string,
  lane: 'shared_memory' | 'swm_recovery' = 'shared_memory',
): Admission {
  return {
    policy,
    ctx,
    contextGraphId,
    label: `shared-memory:${contextGraphId}:peer`,
    lane,
    source: 'on-connect',
  };
}

/** The Edge safety-net pull of a public graph in use, which asks for a reserved slot only. */
function safetyNetPull(policy: SyncGlobalBackpressurePolicy, contextGraphId: string): Admission {
  return { ...sharedMemoryPull(policy, contextGraphId), source: 'reconcile', reservedSlotOnly: true };
}

/**
 * Admit work that keeps its slot until `release()`; `started` resolves when it
 * runs. Work released while still queued ends as soon as it starts, so a test
 * that fails early leaves no slot held for the tests after it.
 */
function hold(admission: Admission) {
  let release: (() => void) | undefined;
  let released = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const done = withGlobalSyncBackpressure(admission, () => new Promise<void>((resolve) => {
    release = resolve;
    markStarted();
    if (released) resolve();
  }));
  return {
    started,
    done,
    release: () => {
      released = true;
      release?.();
    },
    isRunning: () => release !== undefined,
  };
}

function oneSlotNoQueue(): SyncGlobalBackpressurePolicy {
  return resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
}

afterEach(() => {
  delete process.env[RESERVE_ENV];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reserved shared-memory slot (#3251)', () => {
  it('runs a small graph\'s shared-memory pull while a large transfer of another graph holds the only slot', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(largeTransfer(policy));
    await transfer.started;
    const messages: string[] = [];

    try {
      let pulled = false;
      await withGlobalSyncBackpressure({
        ...sharedMemoryPull(policy, 'urn:cg:small'),
        logInfo: (_ctx, message) => { messages.push(message); },
      }, async () => { pulled = true; });

      expect(pulled).toBe(true);
      expect(transfer.isRunning()).toBe(true);
      expect(messages).toEqual([expect.stringMatching(
        /^Sync backpressure running shared-memory:urn:cg:small:peer in a reserved shared-memory slot \(global inflight=1\/1, queued=0\/0, reserved shared-memory inflight=1\/1, queued=0\/16\)$/,
      )]);

      // Large transfers stay bounded exactly as before: the reserve is not theirs.
      await expect(withGlobalSyncBackpressure(
        largeTransfer(policy, 'urn:cg:second-large'),
        async () => undefined,
      )).rejects.toMatchObject({
        reason: 'queue_full',
        message: 'Sync backpressure rejected durable:urn:cg:second-large:peer (global inflight=1/1, queued=0/0)',
      });
      await expect(withGlobalSyncBackpressure(
        { policy, ctx, label: 'changelog:urn:cg:small', lane: 'changelog', source: 'reconcile' },
        async () => undefined,
      )).rejects.toMatchObject({ reason: 'queue_full' });
    } finally {
      transfer.release();
      await transfer.done;
    }
  });

  it('reproduces member B through the agent admission path, and the reserve switch restores the refusal', async () => {
    const agentLike = {
      config: { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
      node: { stopSignal: undefined },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    const admit = <T>(
      contextGraphId: string,
      lane: 'durable' | 'shared_memory',
      label: string,
      work: () => Promise<T>,
      admission: Record<string, unknown>,
    ) => LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure.call(
      agentLike as never,
      ctx,
      contextGraphId,
      lane as never,
      label,
      work,
      admission,
    ) as Promise<T>;
    const selectedPull = (label: string) => admit(
      'urn:cg:public-unregistered',
      'shared_memory',
      label,
      async () => 'pulled',
      { source: 'on-connect', priorityOverride: 2_000, selectedSwmPriority: true },
    );

    let releaseTransfer!: () => void;
    const transfer = admit(
      'urn:cg:other-verified',
      'durable',
      'durable:urn:cg:other-verified:peer',
      () => new Promise<void>((resolve) => { releaseTransfer = resolve; }),
      { source: 'vm-recovery' },
    );
    await tick();

    try {
      process.env[RESERVE_ENV] = '0';
      await expect(selectedPull('shared-memory:urn:cg:public-unregistered:peer-1'))
        .rejects.toMatchObject({
          message: 'Sync backpressure rejected shared-memory:urn:cg:public-unregistered:peer-1 '
            + '(global inflight=1/1, queued=0/0)',
        });

      delete process.env[RESERVE_ENV];
      await expect(selectedPull('shared-memory:urn:cg:public-unregistered:peer-2'))
        .resolves.toBe('pulled');
    } finally {
      releaseTransfer();
      await transfer;
    }
  });

  it('carries a reserved-slot-only request through the agent admission path', async () => {
    const messages: string[] = [];
    const agentLike = {
      config: { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
      node: { stopSignal: undefined },
      log: {
        info: (_ctx: unknown, message: string) => { messages.push(message); },
        warn: () => {},
        debug: () => {},
      },
    };
    const pulled = await LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure.call(
      agentLike as never,
      ctx,
      'urn:cg:in-use',
      'shared_memory',
      'shared-memory:urn:cg:in-use:peer',
      async () => 'pulled',
      { source: 'reconcile', reservedSlotOnly: true },
    );
    expect(pulled).toBe('pulled');
    expect(messages).toEqual([
      'Sync backpressure running shared-memory:urn:cg:in-use:peer in a reserved shared-memory slot '
        + '(global inflight=0/1, queued=0/0, reserved shared-memory inflight=1/1, queued=0/16)',
    ]);
  });

  it('queues a shared-memory pull behind a busy reserved slot instead of refusing it', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(largeTransfer(policy));
    await transfer.started;
    const first = hold(sharedMemoryPull(policy, 'urn:cg:first'));
    await first.started;
    const messages: string[] = [];

    try {
      const second = hold({
        ...sharedMemoryPull(policy, 'urn:cg:second'),
        logInfo: (_ctx, message) => { messages.push(message); },
      });
      await tick();
      expect(second.isRunning()).toBe(false);
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 1 });
      expect(messages).toEqual([
        'Sync backpressure queued shared-memory:urn:cg:second:peer (global inflight=1/1, queued=0/0, '
          + 'reserved shared-memory inflight=1/1, queued=1/16)',
      ]);
      expect(syncAdmissionWouldBeRefused(policy, sharedMemoryPull(policy, 'urn:cg:third'))).toBe(false);

      first.release();
      await first.done;
      await second.started;
      expect(transfer.isRunning()).toBe(true);
      second.release();
      await second.done;
    } finally {
      first.release();
      transfer.release();
      await Promise.all([first.done, transfer.done]);
    }
  });

  it('defers a queued shared-memory pull once it has waited the bounded time', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(largeTransfer(policy));
    await transfer.started;
    const first = hold(sharedMemoryPull(policy, 'urn:cg:first'));
    await first.started;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let started = false;
      const outcome = expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:waiting', 'swm_recovery'),
        async () => { started = true; },
      )).rejects.toSatisfy((error: unknown) => (
        error instanceof SyncBackpressureBusyError
        && error.reason === 'queue_timeout'
        && error.message === 'Sync backpressure timed out shared-memory:urn:cg:waiting:peer after 60000 ms '
          + 'waiting for a shared-memory slot (global inflight=1/1, reserved shared-memory inflight=1/1, '
          + 'queued=0/16)'
      ));
      await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_SHARED_MEMORY_QUEUE_TIMEOUT_MS - 1);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(started).toBe(false);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(0);
    } finally {
      vi.useRealTimers();
      first.release();
      transfer.release();
      await Promise.all([first.done, transfer.done]);
    }
  });

  it('uses a general slot first and the reserve only under pressure, without narrowing general capacity', async () => {
    const policy = oneSlotNoQueue();
    const messages: string[] = [];
    const generalPull = hold({
      ...sharedMemoryPull(policy, 'urn:cg:general'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });
    await generalPull.started;
    expect(messages).toEqual([
      'Sync backpressure running shared-memory:urn:cg:general:peer (global inflight=1/1, queued=0/0, '
        + 'reserved shared-memory inflight=0/1, queued=0/16)',
    ]);
    // Unchanged: a durable transfer still waits for the general slot.
    await expect(withGlobalSyncBackpressure(largeTransfer(policy), async () => undefined))
      .rejects.toMatchObject({ reason: 'queue_full' });

    const reservedPull = hold(sharedMemoryPull(policy, 'urn:cg:reserved'));
    await reservedPull.started;
    generalPull.release();
    await generalPull.done;

    // The reserved pull is outside the general count: the freed general slot
    // takes a durable transfer while that pull still runs.
    const transfer = hold(largeTransfer(policy));
    try {
      await transfer.started;
      expect(reservedPull.isRunning()).toBe(true);
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      reservedPull.release();
      transfer.release();
      await Promise.all([reservedPull.done, transfer.done]);
    }
  });

  it('runs a reserved-slot-only pull in the reserved slot and leaves the free general slot to a transfer', async () => {
    // A node that keeps its one sync slot for large transfers (no queue): a
    // pull that took the free general slot would refuse the transfer for as
    // long as the pull reads the graph's shared memory.
    const policy = oneSlotNoQueue();
    const messages: string[] = [];
    const pull = hold({
      ...safetyNetPull(policy, 'urn:cg:in-use'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });
    await pull.started;
    expect(messages).toEqual([
      'Sync backpressure running shared-memory:urn:cg:in-use:peer in a reserved shared-memory slot '
        + '(global inflight=0/1, queued=0/0, reserved shared-memory inflight=1/1, queued=0/16)',
    ]);

    const transfer = hold(largeTransfer(policy));
    try {
      // A refusal rejects `done` at once; `started` never resolves then.
      await Promise.race([transfer.started, transfer.done]);
      expect(pull.isRunning()).toBe(true);
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      pull.release();
      transfer.release();
      await Promise.all([pull.done, transfer.done]);
    }
  });

  it('queues a reserved-slot-only pull for the reserved slot while the general slot is free, holding up no one', async () => {
    const policy = oneSlotNoQueue();
    const first = hold(safetyNetPull(policy, 'urn:cg:first'));
    await first.started;
    const messages: string[] = [];
    const second = hold({
      ...safetyNetPull(policy, 'urn:cg:second'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });
    const held = [first, second];

    try {
      await tick();
      expect(second.isRunning()).toBe(false);
      expect(messages).toEqual([
        'Sync backpressure queued shared-memory:urn:cg:second:peer for a reserved shared-memory slot '
          + '(global inflight=0/1, queued=0/0, reserved shared-memory inflight=1/1, queued=1/16)',
      ]);

      // The waiting pull holds up nothing that the free general slot can run.
      const transfer = hold(largeTransfer(policy));
      held.push(transfer);
      await Promise.race([transfer.started, transfer.done]);
      first.release();
      await first.done;
      await second.started;
      expect(transfer.isRunning()).toBe(true);
    } finally {
      for (const work of held) work.release();
      await Promise.all(held.map((work) => work.done));
    }
  });

  it('admits a reserved-slot-only pull like any other shared-memory pull where no reserve applies', async () => {
    process.env[RESERVE_ENV] = '0';
    const policy = oneSlotNoQueue();
    const messages: string[] = [];
    const pull = hold({
      ...safetyNetPull(policy, 'urn:cg:in-use'),
      logInfo: (_ctx, message) => { messages.push(message); },
    });
    try {
      await Promise.race([pull.started, pull.done]);
      expect(messages).toEqual([
        'Sync backpressure running shared-memory:urn:cg:in-use:peer (global inflight=1/1, queued=0/0)',
      ]);
      await expect(withGlobalSyncBackpressure(largeTransfer(policy), async () => undefined))
        .rejects.toMatchObject({ reason: 'queue_full' });
    } finally {
      pull.release();
      await pull.done;
    }
  });

  it('keeps its own queue: shared-memory waiters neither fill the general queue nor are displaced from it', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    const transfer = hold(largeTransfer(policy));
    await transfer.started;
    const reserved = hold(sharedMemoryPull(policy, 'urn:cg:reserved'));
    await reserved.started;
    const waiting = Array.from(
      { length: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT },
      (_, index) => hold(sharedMemoryPull(policy, `urn:cg:waiting-${index}`)),
    );
    const queuedDurable = hold(largeTransfer(policy, 'urn:cg:queued-durable'));
    let urgent: ReturnType<typeof hold> | undefined;
    await tick();

    try {
      // The general queue still has its one slot for durable work…
      expect(queuedDurable.isRunning()).toBe(false);
      expect(getSyncBackpressureSnapshot(policy).queued).toBe(DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT + 1);
      // …and a higher-priority durable admission displaces only that entry.
      urgent = hold({ ...largeTransfer(policy, 'urn:cg:urgent'), priority: 5_000 });
      await expect(queuedDurable.done).rejects.toMatchObject({ reason: 'displaced' });

      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:one-too-many'),
        async () => undefined,
      )).rejects.toMatchObject({
        reason: 'queue_full',
        message: `Sync backpressure rejected shared-memory:urn:cg:one-too-many:peer (global inflight=1/1, `
          + `queued=${DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT + 1}/1, reserved shared-memory inflight=1/1, `
          + `queued=${DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT}/${DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT})`,
      });

      // Waiters drain through the reserved slot while the transfer still runs.
      reserved.release();
      for (const waiter of waiting) {
        await waiter.started;
        expect(transfer.isRunning()).toBe(true);
        waiter.release();
        await waiter.done;
      }
      transfer.release();
      await urgent.started;
      urgent.release();
      await urgent.done;
    } finally {
      reserved.release();
      for (const waiter of waiting) waiter.release();
      transfer.release();
      await Promise.allSettled([
        reserved.done,
        transfer.done,
        queuedDurable.done,
        ...waiting.map((waiter) => waiter.done),
      ]);
      if (urgent) {
        await urgent.started;
        urgent.release();
        await urgent.done;
      }
    }
  });

  it('admits an on-connect pull beside a background transfer in the partitioned slow lane', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncAdmission: {} });
    const background = hold({ ...largeTransfer(policy), source: 'on-connect' });
    await background.started;

    try {
      await expect(withGlobalSyncBackpressure(
        { ...largeTransfer(policy, 'urn:cg:second-background'), source: 'on-connect' },
        async () => undefined,
      )).rejects.toMatchObject({ reason: 'queue_full' });
      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:small'),
        async () => 'pulled',
      )).resolves.toBe('pulled');
    } finally {
      background.release();
      await background.done;
    }
  });

  it('gives a reserved slot back when the start fails', async () => {
    const policy = oneSlotNoQueue();
    const transfer = hold(largeTransfer(policy));
    await transfer.started;
    const record = vi.spyOn(getMetrics().syncGlobalInflight, 'record')
      .mockImplementationOnce(() => { throw new Error('metrics unavailable'); });

    try {
      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:first'),
        async () => undefined,
      )).rejects.toThrow('metrics unavailable');
      record.mockRestore();
      await expect(withGlobalSyncBackpressure(
        sharedMemoryPull(policy, 'urn:cg:second'),
        async () => 'pulled',
      )).resolves.toBe('pulled');
    } finally {
      transfer.release();
      await transfer.done;
    }
  });

  it('gives a general slot back when the start fails', async () => {
    const policy = oneSlotNoQueue();
    const record = vi.spyOn(getMetrics().syncGlobalInflight, 'record')
      .mockImplementationOnce(() => { throw new Error('metrics unavailable'); });
    await expect(withGlobalSyncBackpressure(largeTransfer(policy), async () => undefined))
      .rejects.toThrow('metrics unavailable');
    record.mockRestore();
    expect(getSyncBackpressureSnapshot(policy).inflight).toBe(0);
    await expect(withGlobalSyncBackpressure(largeTransfer(policy), async () => 'transferred'))
      .resolves.toBe('transferred');
  });

  it('counts the reserve in the scheduler capacity it publishes', () => {
    const published = () => backpressureRegistry.capture().schedulers.find(
      (scheduler) => scheduler.scheduler === 'sync-global',
    );
    // Beside the reserved control-plane slot, which has no queue (#3280).
    resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({
      capacityModel: 'shared',
      totals: { inflightLimit: 3, queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT },
    });

    process.env[RESERVE_ENV] = '0';
    const off = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    expect(published()).toMatchObject({ totals: { inflightLimit: 2, queueLimit: 0 } });
    const transfer = hold(largeTransfer(off));
    return transfer.started.then(async () => {
      expect(syncAdmissionWouldBeRefused(off, sharedMemoryPull(off, 'urn:cg:a'))).toBe(true);
      transfer.release();
      await transfer.done;
    });
  });
});

describe('priority admission queue pools', () => {
  function queueWithoutCapacity() {
    return new PriorityAdmissionQueue<string>({
      canRun: () => false,
      onStart: () => () => {},
    });
  }

  const options = (payload: string, queuePool: string | undefined, priority = 0, queueLimit = 1) => ({
    payload,
    ownerKey: queuePool ?? 'shared',
    queuePool,
    lane: 'durable' as const,
    priority,
    priorityClass: 'default' as const,
    queueLimit,
    agingThresholdMs: 30_000,
    createBusyError: (reason: string) => new Error(reason),
    createDisplacedError: () => new Error('displaced'),
  });

  it('counts each pool against its own queue limit', () => {
    const queue = queueWithoutCapacity();
    queue.acquire(options('shared-a', undefined)).release.catch(() => {});
    expect(() => queue.acquire(options('shared-b', undefined))).toThrow('global_queue_full');
    expect(queue.wouldRefuse(options('pool-probe', 'pool'))).toBe(false);
    queue.acquire(options('pool-a', 'pool')).release.catch(() => {});
    expect(queue.wouldRefuse(options('pool-probe', 'pool'))).toBe(true);
    expect(queue.length).toBe(2);
  });

  it('never displaces an entry of another pool', async () => {
    const queue = queueWithoutCapacity();
    // Were pools ignored, the newest lowest-priority entry (pool-low) would go.
    const shared = queue.acquire(options('shared-low', undefined, 0));
    const pooled = queue.acquire(options('pool-low', 'pool', 0));
    const errors = new Map<string, string>();
    shared.release.catch((error: Error) => { errors.set('shared-low', error.message); });
    pooled.release.catch((error: Error) => { errors.set('pool-low', error.message); });

    queue.acquire(options('shared-high', undefined, 10)).release.catch(() => {});
    await tick();
    expect([...errors]).toEqual([['shared-low', 'displaced']]);
    expect(queue.entries().map((entry) => entry.payload).sort()).toEqual(['pool-low', 'shared-high']);
  });

  it('keeps a handoff reservation in the pool of the running stage', async () => {
    let running = 0;
    const queue = new PriorityAdmissionQueue<string>({
      canRun: () => running < 1,
      onStart: () => {
        running += 1;
        return () => { running -= 1; };
      },
    });
    const stage = queue.acquire({ ...options('stage', 'pool'), reserveForHandoff: true });
    const releaseStage = await stage.release;

    expect(queue.wouldRefuse(options('pool-probe', 'pool'))).toBe(true);
    expect(queue.wouldRefuse(options('shared-probe', undefined))).toBe(false);
    const next = stage.handoff!({
      payload: 'next',
      lane: 'durable',
      priority: 0,
      priorityClass: 'default',
      agingThresholdMs: 30_000,
      createBusyError: (reason: string) => new Error(reason),
      createDisplacedError: () => new Error('displaced'),
    });
    expect(queue.entries().map((entry) => entry.queuePool)).toEqual(['pool']);
    releaseStage();
    const releaseNext = await next.release;
    releaseNext();
  });
});
