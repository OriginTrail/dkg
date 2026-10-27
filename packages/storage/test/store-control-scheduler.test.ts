import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMetrics } from '@origintrail-official/dkg-core';
import {
  StoreSchedulerBusyError,
  StorePriorityScheduler,
  isStoreSchedulerBusyError,
  withDefaultStoreWorkPriority,
} from '../src/store-priority-scheduler.js';
import {
  STORE_CONTROL_MAX_SLOTS,
  buildStoreControlPath,
  type StoreControlSlots,
} from '../src/store-control-path.js';
import type { StoreControlQueue, StoreWorkPriority } from '../src/triple-store.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The shipped shared-scheduler reserves, stated so the process environment cannot change them. */
const SHARED_RESERVES = { ackReservedSlots: 1, healthReservedSlots: 1, normalReservedSlots: 1, backgroundReservedSlots: 1 };

function sharedScheduler(maxConcurrent: number, extra: { queueLimits?: number; queueWaitTimeoutMs?: number } = {}) {
  return new StorePriorityScheduler({
    ...SHARED_RESERVES,
    maxConcurrent,
    queueLimits: extra.queueLimits ?? 8,
    queueWaitTimeoutMs: extra.queueWaitTimeoutMs ?? 60_000,
  });
}

function controlSlots(queue: StoreControlQueue): StoreControlSlots {
  return { share: queue === 'share' ? 1 : 0, publisher: queue === 'publisher' ? 2 : 0 };
}

function controlInstance(
  queue: StoreControlQueue,
  shared: Pick<StorePriorityScheduler, 'snapshot'> = sharedScheduler(4),
): StorePriorityScheduler {
  return buildStoreControlPath(controlSlots(queue), shared)[queue]!;
}

interface Held {
  started: Promise<void>;
  release: () => void;
  settled: Promise<unknown>;
}

/** Start one operation that holds its slot until released. */
function hold(
  scheduler: StorePriorityScheduler,
  priority: StoreWorkPriority | undefined,
  operation: string,
  tally?: { active: number; most: number },
): Held {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const settled = scheduler.run(priority, operation, async () => {
    if (tally) { tally.active += 1; tally.most = Math.max(tally.most, tally.active); }
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    if (tally) tally.active -= 1;
  });
  return { started: startedPromise, release: () => release(), settled };
}

/** The most operations of one lane that ran together when `count` were submitted at once. */
async function admittedTogether(scheduler: StorePriorityScheduler, priority: StoreWorkPriority, count: number) {
  const tally = { active: 0, most: 0 };
  const held = Array.from({ length: count }, (_, i) => hold(scheduler, priority, `probe.${priority}.${i}`, tally));
  await tick();
  for (const op of held) { op.release(); await tick(); }
  await Promise.all(held.map((op) => op.settled));
  return tally.most;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('control-labelled StorePriorityScheduler', () => {
  it.each(['share', 'publisher'] as const)('reports exactly one lane, control, with real limits (%s)', async (queue) => {
    const shared = sharedScheduler(4, { queueLimits: 7 });
    const scheduler = controlInstance(queue, shared);
    const slots = STORE_CONTROL_MAX_SLOTS[queue];

    const idle = scheduler.getBackpressureSnapshot();
    expect(idle.scheduler).toBe(`store-control-${queue}`);
    expect(idle.lanes.map((lane) => lane.lane)).toEqual(['control']);
    expect(idle.lanes[0]).toMatchObject({ queueLimit: 7, inflightLimit: slots, capacityModel: 'partitioned' });
    expect(idle.totals).toMatchObject({ queueLimit: 7, inflightLimit: slots });

    // Whatever priority or ambient lane the caller names, the pressure stays in the one lane.
    const held = [
      hold(scheduler, 'ack', 'a'),
      withDefaultStoreWorkPriority('background', () => hold(scheduler, undefined, 'b')),
      hold(scheduler, 'health', 'c'),
    ];
    await tick();
    const busy = scheduler.getBackpressureSnapshot();
    expect(busy.lanes.map((lane) => lane.lane)).toEqual(['control']);
    expect(busy.lanes[0].inflight).toBe(slots);
    expect(busy.lanes[0].queued).toBe(3 - slots);
    expect(busy.lanes.every((lane) => lane.inflightLimit !== null && lane.queueLimit !== null)).toBe(true);
    for (const op of held) { op.release(); await tick(); }
    await Promise.all(held.map((op) => op.settled));
  });

  it('runs every call in the one fixed lane: no priority and no ambient default moves it', async () => {
    const scheduler = controlInstance('publisher');
    const calls: Array<[StoreWorkPriority | undefined, StoreWorkPriority | undefined]> = [
      [undefined, undefined], ['ack', undefined], ['health', undefined], ['normal', undefined], ['background', undefined],
      [undefined, 'background'], ['ack', 'background'], [undefined, 'normal'],
    ];
    for (const [priority, ambient] of calls) {
      const run = () => scheduler.run(priority, 'publisher.asyncLift.claim', async () => 'ok');
      await (ambient ? withDefaultStoreWorkPriority(ambient, run) : run());
    }
    const [report] = scheduler.stats.takeIntervalQueueWaits();
    expect(scheduler.stats.takeIntervalQueueWaits().map((w) => w.lane)).toEqual(['control']);
    expect(report).toMatchObject({ lane: 'control', queueWaitCount: calls.length });
    const snapshot = scheduler.snapshot;
    expect(snapshot).toMatchObject({ ackInflight: 0, healthInflight: 0, backgroundInflight: 0, ackQueued: 0 });
    expect(snapshot.maxConcurrent).toBe(2);
  });

  it('runs two publisher operations at once and one share operation at a time', async () => {
    // Hostile process settings: the class default ACK reserve would hold one of the publisher's two slots.
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '1');
    vi.stubEnv('DKG_STORE_ACK_RESERVED_SLOTS', '1');
    vi.stubEnv('DKG_STORE_HEALTH_RESERVED_SLOTS', '1');
    vi.stubEnv('DKG_STORE_NORMAL_RESERVED_SLOTS', '2');
    vi.stubEnv('DKG_STORE_BACKGROUND_RESERVED_SLOTS', '1');
    vi.stubEnv('DKG_STORE_QUEUE_LIMIT', '1');
    vi.stubEnv('DKG_STORE_QUEUE_WAIT_TIMEOUT_MS', '1');
    const shared = { snapshot: { normalQueueLimit: 16, queueWaitTimeoutMs: 60_000 } } as Pick<StorePriorityScheduler, 'snapshot'>;
    const path = buildStoreControlPath({ share: 1, publisher: 2 }, shared);

    expect(await admittedTogether(path.publisher!, 'normal', 6)).toBe(2);
    expect(await admittedTogether(path.share!, 'normal', 6)).toBe(1);
    expect(path.publisher!.snapshot).toMatchObject({
      maxConcurrent: 2, ackReservedSlots: 0, healthReservedSlots: 0, normalReservedSlots: 0,
      backgroundReservedSlots: 0, normalQueueLimit: 16, queueWaitTimeoutMs: 60_000,
    });
  });

  it('refuses with control-lane busy errors that the cross-package guard accepts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shared = sharedScheduler(4, { queueLimits: 2, queueWaitTimeoutMs: 15 });
    const scheduler = controlInstance('share', shared);
    const holder = hold(scheduler, undefined, 'share.holder');
    await holder.started;

    const waiting = scheduler.run('ack', 'publisher.asyncPromote.writeJob', async () => 'late');
    const waitingAgain = scheduler.run(undefined, 'publisher.asyncPromote.list', async () => 'late');
    const full = await scheduler.run('background', 'publisher.asyncPromote.stats', async () => 'x')
      .then(() => undefined, (error: unknown) => error);
    const timedOut = await waiting.then(() => undefined, (error: unknown) => error);
    await waitingAgain.catch(() => undefined);

    for (const [error, reason] of [[full, 'queue_full'], [timedOut, 'queue_wait_timeout']] as const) {
      expect(error).toBeInstanceOf(StoreSchedulerBusyError);
      expect(isStoreSchedulerBusyError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'STORE_SCHEDULER_BUSY', reason, priority: 'control', retryable: true, outcome: 'not_started',
      });
      expect((error as Error).message).toMatch(/\(control: publisher\.asyncPromote\./);
      // The shape survives a copy that lost the class, as at the HTTP and query-handler boundaries.
      const { code, reason: copiedReason, priority, operation, retryable, outcome, storeOperationOutcomeTag } = error as never;
      expect(isStoreSchedulerBusyError({ code, reason: copiedReason, priority, operation, retryable, outcome, storeOperationOutcomeTag }))
        .toBe(true);
    }
    expect(isStoreSchedulerBusyError({ ...(full as object), priority: 'bogus' })).toBe(false);

    // Rejections are counted under the control lane, in the registry snapshot and in the stats.
    expect(scheduler.stats.rejectionTotals()).toEqual([
      { lane: 'control', family: 'publisher.asyncPromote', reason: 'queue_full', count: 1 },
      { lane: 'control', family: 'publisher.asyncPromote', reason: 'queue_wait_timeout', count: 2 },
    ]);
    expect(scheduler.getBackpressureSnapshot().lanes.map((lane) => [lane.lane, lane.rejectedTotal]))
      .toEqual([['control', 3]]);
    holder.release();
    await holder.settled;
  });

  it('labels its metrics control and samples no shared ACK or sync depth', async () => {
    // The no-op meter hands every instrument out as one shared object, so give each its own recorder.
    const metrics = getMetrics() as unknown as Record<string, unknown>;
    const names = [
      'storeSchedulerRejectionsTotal', 'storeSchedulerActive', 'storeSchedulerQueueWaitMs',
      'storeSchedulerOperationDurationMs', 'storageAckPriorityQueueDepth', 'storageAckInflight',
      'syncBackgroundQueueDepth', 'storageAckQueueWaitMs', 'storageAckStoreOpDurationMs',
    ];
    const originals = new Map(names.map((name) => [name, metrics[name]]));
    const fakes = Object.fromEntries(names.map((name) => [name, { add: vi.fn(), record: vi.fn() }]));
    for (const name of names) metrics[name] = fakes[name];
    try {
      const scheduler = controlInstance('share', sharedScheduler(4, { queueLimits: 1 }));
      const holder = hold(scheduler, 'ack', 'share.holder');
      await holder.started;
      const queued = scheduler.run('ack', 'share.queued', async () => undefined);
      await scheduler.run('ack', 'share.full', async () => undefined).catch(() => undefined);
      holder.release();
      await Promise.all([holder.settled, queued]);

      const attributes = (name: string, instrument: 'add' | 'record') =>
        fakes[name][instrument].mock.calls.map((call) => call[1]);
      expect(attributes('storeSchedulerActive', 'add')).toContainEqual(expect.objectContaining({ priority: 'control' }));
      for (const [name, instrument] of [
        ['storeSchedulerActive', 'add'], ['storeSchedulerQueueWaitMs', 'record'],
        ['storeSchedulerOperationDurationMs', 'record'], ['storeSchedulerRejectionsTotal', 'add'],
      ] as const) {
        const seen = attributes(name, instrument);
        expect(seen.length, name).toBeGreaterThan(0);
        for (const attrs of seen) expect(attrs, name).toMatchObject({ priority: 'control' });
      }
      expect(attributes('storeSchedulerRejectionsTotal', 'add')).toEqual([
        { priority: 'control', reason: 'queue_full', operation_family: 'share.full' },
      ]);
      for (const name of ['storageAckPriorityQueueDepth', 'storageAckInflight', 'syncBackgroundQueueDepth',
        'storageAckQueueWaitMs', 'storageAckStoreOpDurationMs']) {
        expect(fakes[name].record, name).not.toHaveBeenCalled();
      }

      // The shared scheduler still samples them.
      await sharedScheduler(4).run('ack', 'shared.probe', async () => undefined);
      expect(fakes.storageAckPriorityQueueDepth.record).toHaveBeenCalled();
      expect(fakes.storageAckQueueWaitMs.record).toHaveBeenCalled();
    } finally {
      for (const [name, original] of originals) metrics[name] = original;
    }
  });

  it('reports only its own lane and active work in a queue-wait timeout diagnostic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shared = sharedScheduler(4, { queueWaitTimeoutMs: 15 });
    const scheduler = controlInstance('share', shared);
    const unrelated = hold(shared, 'normal', 'shared.unrelated');
    const holder = hold(scheduler, undefined, 'share.holder');
    await Promise.all([unrelated.started, holder.started]);
    await scheduler.run(undefined, 'share.waiter', async () => undefined).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[store scheduler] queue wait timeout', {
      waiting: { priority: 'control', operation: 'share.waiter' },
      activeAtTimeout: [expect.objectContaining({ priority: 'control', operation: 'share.holder', count: 1 })],
    });
    holder.release();
    unrelated.release();
    await Promise.all([holder.settled, unrelated.settled]);
  });
});

describe('control path capacity geometry (AC3)', () => {
  const cases = [2, 3, 4].flatMap((maxConcurrent) => (['share', 'publisher'] as const).map((queue) => ({ maxConcurrent, queue })));

  it.each(cases)('M = $maxConcurrent, $queue: never exceeds its cap, and ACK, health and ordinary capacity never shrink', async ({ maxConcurrent, queue }) => {
    const cap = STORE_CONTROL_MAX_SLOTS[queue];
    const shared = sharedScheduler(maxConcurrent);
    const control = controlInstance(queue, shared);
    const before = shared.snapshot;

    // What each shared lane admits at once, with the control path idle.
    const profile = async () => ({
      ack: await admittedTogether(shared, 'ack', maxConcurrent + 2),
      health: await admittedTogether(shared, 'health', maxConcurrent + 2),
      normal: await admittedTogether(shared, 'normal', maxConcurrent + 2),
      background: await admittedTogether(shared, 'background', maxConcurrent + 2),
    });
    const idleProfile = await profile();

    // Saturate the control instance: it admits exactly its cap and queues the rest.
    const tally = { active: 0, most: 0 };
    const controlOps = Array.from({ length: cap + 3 }, (_, i) => hold(control, i % 2 ? 'background' : undefined, `control.${i}`, tally));
    await tick();
    expect(control.snapshot.normalInflight).toBe(cap);
    expect(control.snapshot.normalQueued).toBe(3);
    expect(tally.most).toBe(cap);
    expect(shared.snapshot.normalInflight + shared.snapshot.healthInflight + shared.snapshot.ackInflight
      + shared.snapshot.backgroundInflight).toBe(0);

    // The shared scheduler admits exactly what it did.
    expect(await profile()).toEqual(idleProfile);
    expect(shared.snapshot).toEqual(before);

    // Non-ACK work at M - ack (health may borrow every non-ACK slot); ACK still starts, with control at its cap.
    const nonAck = Array.from({ length: maxConcurrent - 1 }, (_, i) => hold(shared, 'health', `shared.health.${i}`));
    await Promise.all(nonAck.map((op) => op.started));
    const ack = hold(shared, 'ack', 'shared.ack');
    await ack.started;
    const sharedNow = shared.snapshot;
    expect(sharedNow.healthInflight).toBe(maxConcurrent - 1);
    expect(sharedNow.ackInflight).toBe(1);
    expect(control.snapshot.normalInflight).toBe(cap);
    expect(tally.most).toBe(cap);

    for (const op of [...nonAck, ack]) op.release();
    await Promise.all([...nonAck, ack].map((op) => op.settled));
    // Draining the control backlog keeps it at its cap throughout.
    for (const op of controlOps) { op.release(); await tick(); }
    await Promise.all(controlOps.map((op) => op.settled));
    expect(tally.most).toBe(cap);
    expect(await profile()).toEqual(idleProfile);
  });

  it('keeps the two queues\' caps separate and independent of each other', async () => {
    const path = buildStoreControlPath({ share: 1, publisher: 2 }, sharedScheduler(2));
    const share = [0, 1].map((i) => hold(path.share!, undefined, `share.${i}`));
    const publisher = [0, 1, 2].map((i) => hold(path.publisher!, undefined, `publisher.${i}`));
    await tick();
    expect(path.share!.snapshot).toMatchObject({ normalInflight: 1, normalQueued: 1 });
    expect(path.publisher!.snapshot).toMatchObject({ normalInflight: 2, normalQueued: 1 });
    for (const op of [...share, ...publisher]) { op.release(); await tick(); }
    await Promise.all([...share, ...publisher].map((op) => op.settled));
  });
});
