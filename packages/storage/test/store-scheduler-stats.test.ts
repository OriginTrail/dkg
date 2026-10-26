import { describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import {
  StorePriorityScheduler,
  externalStorePriorityScheduler,
} from '../src/store-priority-scheduler.js';
import {
  STORE_QUEUE_WAIT_BUCKET_UPPER_MS,
  StoreSchedulerStats,
  estimateQueueWaitPercentileMs,
  registerStoreSchedulerStats,
  storeOperationFamily,
  takeStoreSchedulerStatsReports,
} from '../src/store-scheduler-stats.js';
import { STORE_WORK_PRIORITIES } from '../src/triple-store.js';

const LANES = [...STORE_WORK_PRIORITIES];
const waits = (stats: StoreSchedulerStats) =>
  Object.fromEntries(stats.takeIntervalMaxQueueWaitMs().map((w) => [w.lane, w.maxQueueWaitMs]));
const OVERFLOW = STORE_QUEUE_WAIT_BUCKET_UPPER_MS.length;
const BUCKETS = OVERFLOW + 1;
/** Bucket counts of one lane's interval, as `{ bucketIndex: count }` so a test names only the non-empty ones. */
const sparse = (buckets: number[]) =>
  Object.fromEntries(buckets.flatMap((count, index) => (count ? [[index, count]] : [])));
const laneWait = (stats: StoreSchedulerStats, lane: string) => {
  const taken = stats.takeIntervalMaxQueueWaitMs().find((w) => w.lane === lane)!;
  return { ...taken, queueWaitBuckets: sparse(taken.queueWaitBuckets) };
};
const laneP95 = (stats: StoreSchedulerStats, lane: string) => {
  const taken = stats.takeIntervalMaxQueueWaitMs().find((w) => w.lane === lane)!;
  return estimateQueueWaitPercentileMs(taken.queueWaitBuckets, 0.95, taken.maxQueueWaitMs);
};

describe('storeOperationFamily', () => {
  it.each([
    ['publisher.asyncLift.claimCandidates', 'publisher.asyncLift'],
    ['publisher.asyncPromote.findActiveConflict', 'publisher.asyncPromote'],
    ['agent.query.select', 'agent.query'],
    ['blazegraph.insert', 'blazegraph.insert'],
    ['rfc64-finalized-vm-materialization', 'rfc64-finalized-vm-materialization'],
    ['has space.and/slash.third', 'has_space.and/slash'],
    ['', 'unknown'],
    ['   ', 'unknown'],
  ])('maps %j to %j', (operation, family) => {
    expect(storeOperationFamily(operation)).toBe(family);
  });

  it('never throws, whatever a JavaScript caller passes', () => {
    expect(storeOperationFamily(undefined as unknown as string)).toBe('unknown');
    expect(storeOperationFamily(null as unknown as string)).toBe('unknown');
    expect(storeOperationFamily(`${'x'.repeat(200)}.y`)).toHaveLength(80);
  });
});

describe('StoreSchedulerStats', () => {
  it('reports the longest wait of every declared lane and starts a new interval on each take', () => {
    const stats = new StoreSchedulerStats(LANES);
    stats.recordQueueWait('ack', 3);
    stats.recordQueueWait('normal', 40);
    stats.recordQueueWait('normal', 25);
    stats.recordQueueWait('normal', -5);
    stats.recordQueueWait('normal', Number.NaN);
    expect(stats.takeIntervalMaxQueueWaitMs().map(({ lane, maxQueueWaitMs, queueWaitCount }) => ({ lane, maxQueueWaitMs, queueWaitCount }))).toEqual([
      { lane: 'ack', maxQueueWaitMs: 3, queueWaitCount: 1 },
      { lane: 'health', maxQueueWaitMs: 0, queueWaitCount: 0 },
      { lane: 'normal', maxQueueWaitMs: 40, queueWaitCount: 3 },
      { lane: 'background', maxQueueWaitMs: 0, queueWaitCount: 0 },
    ]);
    expect(waits(stats)).toEqual({ ack: 0, health: 0, normal: 0, background: 0 });
  });

  it('counts each wait in the first bucket whose upper bound it does not exceed, and the rest as overflow', () => {
    const stats = new StoreSchedulerStats(LANES);
    expect(STORE_QUEUE_WAIT_BUCKET_UPPER_MS).toEqual([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    for (const wait of [0, 10, 11, 50, 51, 100, 250, 251, 500, 1000, 2500, 5000, 5001, 10000, 10001, 600000]) {
      stats.recordQueueWait('ack', wait);
    }
    const ack = laneWait(stats, 'ack');
    expect(ack.queueWaitBuckets).toEqual({ 0: 2, 1: 2, 2: 2, 3: 1, 4: 2, 5: 1, 6: 1, 7: 1, 8: 2, [OVERFLOW]: 2 });
    expect(ack).toMatchObject({ queueWaitCount: 16, maxQueueWaitMs: 600000 });
    expect(stats.takeIntervalMaxQueueWaitMs().every((w) => w.queueWaitBuckets.length === BUCKETS)).toBe(true);
  });

  it('ignores a non-finite wait, counts a negative one as zero, and keeps lanes apart', () => {
    const stats = new StoreSchedulerStats(LANES);
    for (const wait of [Number.NaN, Infinity, -Infinity]) stats.recordQueueWait('ack', wait);
    stats.recordQueueWait('ack', -5);
    stats.recordQueueWait('normal', 300);
    expect(laneWait(stats, 'ack')).toMatchObject({ queueWaitCount: 1, maxQueueWaitMs: 0, queueWaitBuckets: { 0: 1 } });
    expect(laneWait(stats, 'normal')).toMatchObject({ queueWaitCount: 0 });
    stats.recordQueueWait('normal', 300);
    expect(laneWait(stats, 'normal')).toMatchObject({ queueWaitCount: 1, queueWaitBuckets: { 4: 1 } });
  });

  it('starts every lane\'s buckets again on each take, and hands out arrays the stats no longer use', () => {
    const stats = new StoreSchedulerStats(LANES);
    stats.recordQueueWait('background', 70);
    const [first] = stats.takeIntervalMaxQueueWaitMs().filter((w) => w.lane === 'background');
    first.queueWaitBuckets.fill(99);
    stats.recordQueueWait('background', 2_000);
    expect(laneWait(stats, 'background')).toMatchObject({ queueWaitCount: 1, queueWaitBuckets: { 6: 1 } });
    expect(laneWait(stats, 'background')).toMatchObject({ queueWaitCount: 0, queueWaitBuckets: {} });
  });

  it('estimates the P95 of a lane from its bucket counts', () => {
    const stats = new StoreSchedulerStats(LANES);
    expect(laneP95(stats, 'ack')).toBe(0);
    for (let n = 0; n < 19; n++) stats.recordQueueWait('ack', 3);
    stats.recordQueueWait('ack', 400);
    expect(laneP95(stats, 'ack')).toBe(10);
    for (let n = 0; n < 18; n++) stats.recordQueueWait('ack', 3);
    stats.recordQueueWait('ack', 400);
    stats.recordQueueWait('ack', 400);
    expect(laneP95(stats, 'ack')).toBe(500);
  });

  it('keeps a lane it was not told about once it is recorded', () => {
    const stats = new StoreSchedulerStats(['control']);
    stats.recordQueueWait('other-lane', 7);
    expect(waits(stats)).toEqual({ control: 0, 'other-lane': 7 });
  });

  it('counts rejections by lane, family and reason, cumulatively and in a stable order', () => {
    const stats = new StoreSchedulerStats(LANES);
    expect(stats.recordRejection('normal', 'publisher.asyncLift.writeJob', 'queue_full')).toBe('publisher.asyncLift');
    stats.recordRejection('normal', 'publisher.asyncLift.list', 'queue_full');
    stats.recordRejection('ack', 'agent.storageAck.read', 'queue_wait_timeout', 9_000);
    stats.recordRejection('normal', 'publisher.asyncLift.list', 'queue_wait_timeout', 10_000);
    const expected = [
      { lane: 'ack', family: 'agent.storageAck', reason: 'queue_wait_timeout', count: 1 },
      { lane: 'normal', family: 'publisher.asyncLift', reason: 'queue_full', count: 2 },
      { lane: 'normal', family: 'publisher.asyncLift', reason: 'queue_wait_timeout', count: 1 },
    ];
    expect(stats.rejectionTotals()).toEqual(expected);
    // Only the timeouts queued: the full-queue rejections are not zero-length waits.
    const taken = stats.takeIntervalMaxQueueWaitMs();
    expect(taken.map((w) => [w.lane, w.maxQueueWaitMs, w.queueWaitCount])).toEqual([
      ['ack', 9_000, 1], ['health', 0, 0], ['normal', 10_000, 1], ['background', 0, 0],
    ]);
    // Cumulative: taking the interval does not reset the totals, and the copy is detached.
    stats.rejectionTotals()[0].count = 99;
    expect(stats.rejectionTotals()).toEqual(expected);
  });

  it('bounds the families it names; later ones count as other', () => {
    const stats = new StoreSchedulerStats(LANES);
    for (let n = 0; n < 64; n++) expect(stats.recordRejection('normal', `family${n}.op`, 'queue_full')).toBe(`family${n}.op`);
    expect(stats.recordRejection('normal', 'family64.op', 'queue_full')).toBe('other');
    expect(stats.recordRejection('normal', 'family65.op', 'queue_full')).toBe('other');
    expect(stats.recordRejection('normal', 'family3.op', 'queue_full')).toBe('family3.op');
    expect(stats.rejectionTotals().find((total) => total.family === 'other')?.count).toBe(2);
    expect(stats.rejectionTotals()).toHaveLength(65);
  });
});

describe('estimateQueueWaitPercentileMs', () => {
  const counts = (byIndex: Record<number, number>) =>
    Array.from({ length: BUCKETS }, (_, index) => byIndex[index] ?? 0);

  it('is 0 when no wait was counted, whatever the overflow fallback', () => {
    expect(estimateQueueWaitPercentileMs([])).toBe(0);
    expect(estimateQueueWaitPercentileMs(counts({}))).toBe(0);
    expect(estimateQueueWaitPercentileMs(counts({}), 0.95, 1234)).toBe(0);
  });

  it('is the upper bound of the only occupied bucket, not the waits inside it', () => {
    expect(estimateQueueWaitPercentileMs(counts({ 0: 1 }))).toBe(10);
    expect(estimateQueueWaitPercentileMs(counts({ 3: 40 }))).toBe(250);
    expect(estimateQueueWaitPercentileMs(counts({ 8: 7 }))).toBe(10_000);
  });

  it('takes the bucket holding the rank ceil(total * percentile), at and either side of the boundary', () => {
    // 20 waits: rank 19 of the 95th percentile.
    expect(estimateQueueWaitPercentileMs(counts({ 0: 19, 4: 1 }))).toBe(10);
    expect(estimateQueueWaitPercentileMs(counts({ 0: 18, 4: 2 }))).toBe(500);
    // 100 waits: rank 95.
    expect(estimateQueueWaitPercentileMs(counts({ 1: 95, 5: 5 }))).toBe(50);
    expect(estimateQueueWaitPercentileMs(counts({ 1: 94, 5: 6 }))).toBe(1_000);
    // A single wait is every percentile; 1 and 0.5 pick the last and middle waits.
    expect(estimateQueueWaitPercentileMs(counts({ 2: 1 }))).toBe(100);
    expect(estimateQueueWaitPercentileMs(counts({ 0: 1, 8: 1 }), 0.5)).toBe(10);
    expect(estimateQueueWaitPercentileMs(counts({ 0: 1, 8: 1 }), 1)).toBe(10_000);
  });

  it('answers with the overflow fallback when the rank falls past the last bound', () => {
    const overflowing = counts({ 0: 18, [OVERFLOW]: 2 });
    expect(estimateQueueWaitPercentileMs(overflowing)).toBe(Infinity);
    expect(estimateQueueWaitPercentileMs(overflowing, 0.95, 42_000)).toBe(42_000);
    // One overflow wait in 20 sits above the 95th percentile.
    expect(estimateQueueWaitPercentileMs(counts({ 0: 19, [OVERFLOW]: 1 }), 0.95, 42_000)).toBe(10);
    expect(estimateQueueWaitPercentileMs(counts({ [OVERFLOW]: 1 }), 0.95, 42_000)).toBe(42_000);
  });
});

describe('store scheduler stats registry', () => {
  it('registers the shared scheduler under its id with the four lanes', () => {
    const report = takeStoreSchedulerStatsReports().find((entry) => entry.scheduler === 'store');
    expect(report?.maxQueueWaitMs.map((wait) => wait.lane)).toEqual(LANES);
    expect(externalStorePriorityScheduler.stats).toBeInstanceOf(StoreSchedulerStats);
  });

  it('refuses a second source under a taken id, accepts the same one again, and unregisters', () => {
    const first = { backpressureId: 'test-stats-a', stats: new StoreSchedulerStats(['control']) };
    const second = { backpressureId: 'test-stats-b', stats: new StoreSchedulerStats(['control']) };
    const unregisterFirst = registerStoreSchedulerStats(first);
    const unregisterSecond = registerStoreSchedulerStats(second);
    expect(() => registerStoreSchedulerStats({ backpressureId: 'test-stats-a', stats: new StoreSchedulerStats([]) }))
      .toThrow('already registered');
    registerStoreSchedulerStats(first);
    first.stats.recordRejection('control', 'publisher.asyncPromote.writeJob', 'queue_full');
    first.stats.recordQueueWait('control', 12);
    const ids = takeStoreSchedulerStatsReports().map((entry) => entry.scheduler);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(['store', 'test-stats-a', 'test-stats-b']));
    unregisterFirst();
    unregisterSecond();
    unregisterFirst();
    expect(takeStoreSchedulerStatsReports().map((entry) => entry.scheduler)).toEqual(['store']);
  });

  it('ends the max-wait interval for every registered scheduler when reports are taken', () => {
    const source = { backpressureId: 'test-stats-interval', stats: new StoreSchedulerStats(['control']) };
    const unregister = registerStoreSchedulerStats(source);
    try {
      source.stats.recordQueueWait('control', 31);
      const taken = () => takeStoreSchedulerStatsReports().find((entry) => entry.scheduler === 'test-stats-interval');
      const buckets = (index: number | null) =>
        Array.from({ length: BUCKETS }, (_, n) => (n === index ? 1 : 0));
      expect(taken()?.maxQueueWaitMs).toEqual([
        { lane: 'control', maxQueueWaitMs: 31, queueWaitCount: 1, queueWaitBuckets: buckets(1) },
      ]);
      expect(taken()?.maxQueueWaitMs).toEqual([
        { lane: 'control', maxQueueWaitMs: 0, queueWaitCount: 0, queueWaitBuckets: buckets(null) },
      ]);
    } finally {
      unregister();
    }
  });
});

function scheduler(now: () => number, queueWaitTimeoutMs = 1_000) {
  return new StorePriorityScheduler({
    maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0,
    normalReservedSlots: 0, backgroundReservedSlots: 0,
    queueLimits: 1, queueWaitTimeoutMs, now,
  });
}

describe('StorePriorityScheduler stats wiring', () => {
  it('records each lane\'s longest wait when queued work starts', async () => {
    let now = 0;
    const sut = scheduler(() => now);
    let release!: () => void;
    const blocker = sut.run('normal', 'test.blocker', () => new Promise<void>((resolve) => { release = resolve; }));
    const ack = sut.run('ack', 'test.ack', async () => undefined);
    const background = sut.run('background', 'test.background', async () => undefined);
    now = 30;
    release();
    await Promise.all([blocker, ack, background]);
    const taken = sut.stats.takeIntervalMaxQueueWaitMs();
    expect(taken.map((w) => [w.lane, w.maxQueueWaitMs, w.queueWaitCount])).toEqual([
      ['ack', 30, 1], ['health', 0, 0], ['normal', 0, 1], ['background', 30, 1],
    ]);
    expect(sparse(taken[0].queueWaitBuckets)).toEqual({ 1: 1 });
    expect(waits(sut.stats)).toEqual({ ack: 0, health: 0, normal: 0, background: 0 });
  });

  it('counts a full queue as a rejection that never waited, and tags the OTel counter with the family', async () => {
    const adds: Array<{ name: string; value: number; attributes: Record<string, unknown> }> = [];
    const instrument = (name: string) => ({
      record: () => {}, add: (value: number, attributes: Record<string, unknown> = {}) => { adds.push({ name, value, attributes }); },
    });
    metrics.setGlobalMeterProvider({ getMeter: () => ({
      createGauge: instrument, createHistogram: instrument, createCounter: instrument, createUpDownCounter: instrument,
    }) } as never);
    rebuildMetrics();
    const sut = scheduler(() => 0);
    let release!: () => void;
    const blocker = sut.run('normal', 'test.blocker', () => new Promise<void>((resolve) => { release = resolve; }));
    const queued = sut.run('normal', 'test.queued', async () => undefined);
    try {
      await expect(sut.run('normal', 'publisher.asyncPromote.findActiveConflict', async () => undefined))
        .rejects.toMatchObject({ code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full', operation: 'publisher.asyncPromote.findActiveConflict' });
      expect(adds.filter((add) => add.name === 'dkg.store.scheduler_rejections_total')).toEqual([{
        name: 'dkg.store.scheduler_rejections_total',
        value: 1,
        attributes: { priority: 'normal', reason: 'queue_full', operation_family: 'publisher.asyncPromote' },
      }]);
      expect(sut.stats.rejectionTotals()).toEqual([
        { lane: 'normal', family: 'publisher.asyncPromote', reason: 'queue_full', count: 1 },
      ]);
      // The rejected call never queued, and the blocker started at once (a 0 ms wait), so nothing else is counted.
      expect(laneWait(sut.stats, 'normal')).toMatchObject({ maxQueueWaitMs: 0, queueWaitCount: 1, queueWaitBuckets: { 0: 1 } });
    } finally {
      release();
      await Promise.all([blocker, queued]);
      metrics.disable();
      rebuildMetrics();
    }
  });

  it('counts a timed-out wait as a rejection and as the lane\'s longest wait', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const sut = scheduler(() => now, 100);
      let release!: () => void;
      const blocker = sut.run('ack', 'test.blocker', () => new Promise<void>((resolve) => { release = resolve; }));
      const expired = sut.run('ack', 'agent.storageAck.read', async () => undefined);
      const outcome = expect(expired).rejects.toMatchObject({ reason: 'queue_wait_timeout', priority: 'ack' });
      now = 100;
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      expect(sut.stats.rejectionTotals()).toEqual([
        { lane: 'ack', family: 'agent.storageAck', reason: 'queue_wait_timeout', count: 1 },
      ]);
      expect(laneWait(sut.stats, 'ack')).toMatchObject({ maxQueueWaitMs: 100, queueWaitCount: 2, queueWaitBuckets: { 0: 1, 2: 1 } });
      release();
      await blocker;
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the wait of work cancelled while queued, and the stats never change the error', async () => {
    let now = 0;
    const sut = scheduler(() => now);
    let release!: () => void;
    const blocker = sut.run('normal', 'test.blocker', () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const cancelled = sut.run('normal', 'test.cancelled', async () => undefined, controller.signal);
    now = 45;
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect(sut.stats.rejectionTotals()).toEqual([]);
    expect(laneWait(sut.stats, 'normal')).toMatchObject({ maxQueueWaitMs: 45, queueWaitCount: 2, queueWaitBuckets: { 0: 1, 1: 1 } });
    release();
    await blocker;
  });
});
