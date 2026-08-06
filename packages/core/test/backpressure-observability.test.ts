import { describe, expect, it } from 'vitest';
import {
  BackpressureMonitor,
  BackpressureRegistry,
  SchedulerPressureTracker,
  type BackpressureSnapshot,
} from '../src/backpressure-observability.js';

describe('SchedulerPressureTracker', () => {
  it('tracks queue and active age without owning scheduling policy', () => {
    let now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'test scheduler',
      now: () => now,
      capacity: {
        queueLimit: 4,
        inflightLimit: 1,
        lanes: {
          normal: { queueLimit: 4, inflightLimit: 1 },
        },
      },
      thresholds: {
        degradedQueueAgeMs: 5_000,
        stalledActiveAgeMs: 30_000,
      },
    });

    const ticket = tracker.enqueue({
      lane: 'normal',
      operation: 'sparql query with payload-ish punctuation?',
    });
    now += 6_000;
    expect(tracker.snapshot()).toMatchObject({
      scheduler: 'test_scheduler',
      state: 'degraded',
      totals: {
        queued: 1,
        inflight: 0,
        oldestQueuedAgeMs: 6_000,
      },
      lanes: [{
        lane: 'normal',
        state: 'degraded',
        queuedOperations: [{
          operation: 'sparql_query_with_payload-ish_punctuation_',
          count: 1,
          oldestAgeMs: 6_000,
        }],
      }],
    });

    tracker.start(ticket);
    now += 31_000;
    expect(tracker.snapshot()).toMatchObject({
      state: 'stalled',
      totals: {
        queued: 0,
        inflight: 1,
        oldestActiveAgeMs: 31_000,
      },
    });

    tracker.finish(ticket, 'completed');
    expect(tracker.snapshot()).toMatchObject({
      state: 'healthy',
      totals: { queued: 0, inflight: 0 },
    });
  });

  it('makes recent rejection pressure visible without retaining rejected payloads', () => {
    let now = 10_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'store',
      now: () => now,
      thresholds: { rejectionStateWindowMs: 60_000 },
    });

    tracker.reject({ lane: 'normal', operation: 'blazegraph.query' }, 'queue_full');
    expect(tracker.snapshot()).toMatchObject({
      state: 'saturated',
      lanes: [{
        lane: 'normal',
        rejectedTotal: 1,
        rejectedByReason: { queue_full: 1 },
        queuedOperations: [],
        activeOperations: [],
      }],
    });

    now += 60_001;
    expect(tracker.snapshot().state).toBe('healthy');
  });

  // The clock never advances in the three tests below. With `now` held, both
  // age thresholds are provably inert (`oldestQueuedAgeMs` and
  // `oldestActiveAgeMs` are 0) and nothing is ever rejected, so queue depth is
  // the only signal that can move a lane off `healthy`. Without that, a lane
  // state assertion here would pass for the wrong reason.
  it('classifies a shared-pool lane against the pool depth, not its own share of it', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, inflightLimit: 2, capacityModel: 'shared' },
    });

    // Four queued entries fill a pool of four, but no single lane holds more
    // than two. A scheduler whose lanes own private allocations would read
    // 2/4 and 1/4 and call all three lanes healthy; these lanes are all waiting
    // behind the same full queue, and the next admission in any of them is the
    // one that gets rejected.
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'changelog', operation: 'changelog:reconcile' });
    tracker.enqueue({ lane: 'shared_memory', operation: 'shared-memory:on-connect' });

    expect(tracker.snapshot()).toMatchObject({
      state: 'saturated',
      totals: { queued: 4, queueLimit: 4, inflightLimit: 2 },
      lanes: [
        // `queued` is the lane's own share; `pressureQueued` is the pool depth
        // the state was judged against, published so no consumer has to
        // reconstruct it from `totals`.
        { lane: 'changelog', state: 'saturated', capacityModel: 'shared', queued: 1, pressureQueued: 4, queueLimit: 4, inflightLimit: 2 },
        { lane: 'durable', state: 'saturated', capacityModel: 'shared', queued: 2, pressureQueued: 4, queueLimit: 4 },
        { lane: 'shared_memory', state: 'saturated', capacityModel: 'shared', queued: 1, pressureQueued: 4, queueLimit: 4 },
      ],
    });
    // Depth did it, not age or a rejection.
    for (const lane of tracker.snapshot().lanes) {
      expect(lane).toMatchObject({
        oldestQueuedAgeMs: 0,
        oldestActiveAgeMs: 0,
        rejectedTotal: 0,
        lastRejectedAgeMs: null,
      });
    }
  });

  it('classifies a shared-pool lane that fills the queue on its own', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, inflightLimit: 2, capacityModel: 'shared' },
    });

    // The concentrated shape from the issue: one lane holds the whole queue.
    // Nothing has been rejected yet — the rejection comes on the NEXT
    // admission — and the queue has been full for zero milliseconds.
    for (let i = 0; i < 4; i += 1) {
      tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    }

    expect(tracker.snapshot()).toMatchObject({
      state: 'saturated',
      lanes: [{
        lane: 'durable',
        state: 'saturated',
        queued: 4,
        queueLimit: 4,
        oldestQueuedAgeMs: 0,
        rejectedTotal: 0,
        lastRejectedAgeMs: null,
      }],
    });
  });

  it('leaves a shared-pool lane with nothing waiting out of the pool pressure', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, inflightLimit: 2, capacityModel: 'shared' },
    });

    // `swm_recovery` is a known lane — it has run work — but has nothing queued
    // now. A full pool is not evidence that an idle lane is under pressure, and
    // reporting it as such would light up every lane the scheduler has ever
    // touched.
    const admitted = tracker.enqueue({ lane: 'swm_recovery', operation: 'swm-recovery:reconcile' });
    tracker.start(admitted);
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });

    expect(tracker.snapshot()).toMatchObject({
      totals: { queued: 3, queueLimit: 4 },
      lanes: [
        // 3/4 of the pool is the documented 75% early-warning band.
        { lane: 'durable', state: 'degraded', capacityModel: 'shared', queued: 3 },
        { lane: 'swm_recovery', state: 'healthy', capacityModel: 'shared', queued: 0, inflight: 1 },
      ],
    });
  });

  it('keeps a partitioned lane on its own allocation when the scheduler is full', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'store',
      now: () => now,
      capacity: {
        queueLimit: 4,
        inflightLimit: 2,
        lanes: {
          ack: { queueLimit: 2, inflightLimit: 2 },
          background: { queueLimit: 2, inflightLimit: 1 },
        },
      },
    });

    // The store scheduler owns its lanes: `ack` filling its own allocation says
    // nothing about `background`, which still has room. This is the invariant
    // the shared-pool model must not leak into — the scheduler rollup reports
    // the full queue, the lanes report themselves.
    tracker.enqueue({ lane: 'ack', operation: 'store.ack' });
    tracker.enqueue({ lane: 'ack', operation: 'store.ack' });
    tracker.enqueue({ lane: 'background', operation: 'api.query.scoped' });

    expect(tracker.snapshot()).toMatchObject({
      state: 'saturated',
      totals: { queued: 3, queueLimit: 4 },
      lanes: [
        // A private allocation is judged against its own backlog, so the two
        // depths coincide — the model is uniform, not a special case.
        { lane: 'ack', state: 'saturated', capacityModel: 'partitioned', queued: 2, pressureQueued: 2, queueLimit: 2 },
        { lane: 'background', state: 'healthy', capacityModel: 'partitioned', queued: 1, pressureQueued: 1, queueLimit: 2 },
      ],
    });
  });

  it('does not charge a partitioned lane with a scheduler queue it did not fill', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'store',
      now: () => now,
      capacity: {
        // Deliberately inconsistent: the scheduler-level ceiling is lower than
        // its lanes add up to, so the ROLLUP is full while neither lane is
        // anywhere near its own allocation. This is the shape that catches the
        // shared-pool denominator leaking into a partitioned scheduler — under
        // a pool denominator both lanes would read 2/2 and go saturated.
        queueLimit: 2,
        lanes: {
          ack: { queueLimit: 4 },
          normal: { queueLimit: 4 },
        },
      },
    });

    tracker.enqueue({ lane: 'ack', operation: 'store.ack' });
    tracker.enqueue({ lane: 'normal', operation: 'store.query' });

    expect(tracker.snapshot()).toMatchObject({
      // The rollup arm still reports the full scheduler queue; asserting it
      // here is what stops this test passing if the totals branch were broken
      // instead of the lane branch being right.
      state: 'saturated',
      totals: { queued: 2, queueLimit: 2 },
      lanes: [
        { lane: 'ack', state: 'healthy', queued: 1, queueLimit: 4 },
        { lane: 'normal', state: 'healthy', queued: 1, queueLimit: 4 },
      ],
    });
  });
});

describe('BackpressureRegistry', () => {
  it('isolates a broken diagnostic source', () => {
    const registry = new BackpressureRegistry();
    registry.register({
      backpressureId: 'broken',
      getBackpressureSnapshot: () => {
        throw new Error('snapshot failed');
      },
    });

    expect(registry.capture()).toMatchObject({
      state: 'healthy',
      schedulers: [],
      failures: [{ scheduler: 'broken', error: 'snapshot failed' }],
    });
  });
});

describe('BackpressureMonitor', () => {
  it('logs transitions, rate-limited summaries, and recovery', () => {
    let now = 1_000;
    let state: BackpressureSnapshot['state'] = 'healthy';
    const registry = new BackpressureRegistry();
    registry.register({
      backpressureId: 'test',
      getBackpressureSnapshot: () => ({
        scheduler: 'test',
        state,
        totals: {
          queued: state === 'healthy' ? 0 : 3,
          queueLimit: 4,
          inflight: 1,
          inflightLimit: 1,
          oldestQueuedAgeMs: state === 'healthy' ? 0 : 6_000,
          oldestActiveAgeMs: 1_000,
          rejectedTotal: 0,
        },
        // Deliberately the pre-`capacityModel` lane shape. A hand-built
        // `BackpressureSource` written against an older `dkg-core` must still
        // satisfy `BackpressureSnapshot` and must still log identically — the
        // new fields are additive, not required.
        lanes: [{
          lane: 'normal',
          state,
          queued: state === 'healthy' ? 0 : 3,
          queueLimit: 4,
          inflight: 1,
          inflightLimit: 1,
          oldestQueuedAgeMs: state === 'healthy' ? 0 : 6_000,
          oldestActiveAgeMs: 1_000,
          queuedOperations: [],
          activeOperations: [],
          events: {},
          rejectedTotal: 0,
          rejectedByReason: {},
          lastRejectedAgeMs: null,
        }],
      }),
    });
    const messages: Array<{ level: string; message: string }> = [];
    const monitor = new BackpressureMonitor({
      registry,
      now: () => now,
      intervalMs: 5_000,
      summaryIntervalMs: 60_000,
      emit: (level, message) => messages.push({ level, message }),
    });

    monitor.sample();
    expect(messages).toEqual([]);

    state = 'degraded';
    monitor.sample();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ level: 'warn' });
    expect(messages[0].message).toContain('"event":"transition"');

    now += 59_999;
    monitor.sample();
    expect(messages).toHaveLength(1);

    now += 1;
    monitor.sample();
    expect(messages).toHaveLength(2);
    expect(messages[1].message).toContain('"event":"summary"');

    state = 'healthy';
    monitor.sample();
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ level: 'info' });
    expect(messages[2].message).toContain('"event":"recovered"');
    // A lane that declares no model is a private allocation, so its own backlog
    // is what classified it and there is no second depth to report.
    for (const entry of messages) expect(entry.message).not.toContain('pressureQueued');
  });

  it('puts the pool depth on a shared lane record and leaves a private one alone', () => {
    // The classifier tests prove the state; this proves the operator-facing
    // LOG contract, which nothing else exercises — a regression that dropped or
    // misspelled the field would otherwise leave every other test green.
    const registry = new BackpressureRegistry();
    const laneRow = (
      lane: string,
      queued: number,
      extra: Partial<BackpressureSnapshot['lanes'][number]>,
    ) => ({
      lane,
      state: 'saturated' as const,
      queued,
      queueLimit: 4,
      inflight: 0,
      inflightLimit: 2,
      oldestQueuedAgeMs: 0,
      oldestActiveAgeMs: 0,
      queuedOperations: [],
      activeOperations: [],
      events: {},
      rejectedTotal: 0,
      rejectedByReason: {},
      lastRejectedAgeMs: null,
      ...extra,
    });
    registry.register({
      backpressureId: 'sync-global',
      getBackpressureSnapshot: () => ({
        scheduler: 'sync-global',
        state: 'saturated',
        totals: {
          queued: 4,
          queueLimit: 4,
          inflight: 0,
          inflightLimit: 2,
          oldestQueuedAgeMs: 0,
          oldestActiveAgeMs: 0,
          rejectedTotal: 0,
        },
        lanes: [
          laneRow('durable', 3, { capacityModel: 'shared', pressureQueued: 4 }),
          laneRow('changelog', 1, { capacityModel: 'shared', pressureQueued: 4 }),
          // Same scheduler, private allocation: its own backlog IS the depth
          // that classified it, so the record must carry no second number.
          laneRow('ack', 4, { capacityModel: 'partitioned', pressureQueued: 4 }),
        ],
      }),
    });
    const messages: string[] = [];
    const monitor = new BackpressureMonitor({
      registry,
      now: () => 1_000,
      emit: (_level, message) => messages.push(message),
    });

    monitor.sample();

    const line = (lane: string) => messages.find((m) => m.includes(`"lane":"${lane}"`));
    expect(line('durable')).toContain('"queued":3,"pressureQueued":4,"queueLimit":4');
    expect(line('changelog')).toContain('"queued":1,"pressureQueued":4,"queueLimit":4');
    expect(line('ack')).toContain('"queued":4,"queueLimit":4');
    expect(line('ack')).not.toContain('pressureQueued');
    // Documented consequence: once a lane matches the rollup, the scheduler's
    // own `all` record is no longer emitted — which is why the pool depth had
    // to move onto the lane records.
    expect(line('all')).toBeUndefined();
  });

  it('contains logger failures', () => {
    const registry = new BackpressureRegistry();
    registry.register({
      backpressureId: 'test',
      getBackpressureSnapshot: () => ({
        scheduler: 'test',
        state: 'saturated',
        totals: {
          queued: 1,
          queueLimit: 1,
          inflight: 0,
          inflightLimit: 1,
          oldestQueuedAgeMs: 1,
          oldestActiveAgeMs: 0,
          rejectedTotal: 1,
        },
        lanes: [],
      }),
    });
    const monitor = new BackpressureMonitor({
      registry,
      emit: () => {
        throw new Error('logger unavailable');
      },
    });

    expect(() => monitor.sample()).not.toThrow();
  });
});
