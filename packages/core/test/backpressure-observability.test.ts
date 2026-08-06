import { describe, expect, it } from 'vitest';
import {
  BackpressureMonitor,
  BackpressureRegistry,
  recordBackpressureSnapshotMetrics,
  SchedulerPressureTracker,
  type BackpressureSnapshot,
} from '../src/backpressure-observability.js';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { rebuildMetrics } from '../src/telemetry-api.js';

interface RecordedMetric { metric: string; lane: string; value: number }

/**
 * Capture emitted instruments by NAME, through a stand-in meter provider.
 *
 * Patching the instrument objects directly does not work: with no global
 * provider registered, the API hands back **one shared no-op instrument**, so
 * stubbing `backpressureQueueDepth.record` silently stubs every other gauge too
 * and the capture cannot tell them apart. Binding a real provider also pins the
 * published metric names, which is the actual contract a dashboard depends on.
 */
function captureMetrics(run: () => void): RecordedMetric[] {
  const recorded: RecordedMetric[] = [];
  const instrument = (metric: string) => ({
    record: (value: number, attributes?: Record<string, unknown>) => {
      recorded.push({ metric, lane: String(attributes?.lane), value });
    },
    add: () => {},
  });
  const meter = {
    createGauge: instrument,
    createCounter: instrument,
    createHistogram: instrument,
    createUpDownCounter: instrument,
  };
  otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  rebuildMetrics();
  try {
    run();
  } finally {
    otelMetrics.disable();
    rebuildMetrics();
  }
  return recorded;
}

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
      // The scheduler-level field is the authoritative one; assert it from a
      // real tracker, not only inside a lane row, or deleting it goes unnoticed
      // while the API reports `partitioned` above rows that all say `shared`.
      capacityModel: 'shared',
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

    // The issue's literal acceptance criterion: one lane holds the whole queue.
    // Nothing has been rejected yet — the rejection comes on the NEXT
    // admission — and the queue has been full for zero milliseconds.
    //
    // Its kill set is deliberately a subset of the spread test's: with
    // `this.queued.size === laneQueued` the pool-vs-lane distinction is
    // invisible here, which is the point — this is the case where the two
    // denominators AGREE, so it guards that the fix did not break the shape a
    // naive per-lane denominator would also have caught.
    for (let i = 0; i < 4; i += 1) {
      tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    }

    expect(tracker.snapshot()).toMatchObject({
      state: 'saturated',
      capacityModel: 'shared',
      lanes: [{
        lane: 'durable',
        state: 'saturated',
        capacityModel: 'shared',
        queued: 4,
        pressureQueued: 4,
        queueLimit: 4,
        oldestQueuedAgeMs: 0,
        rejectedTotal: 0,
        lastRejectedAgeMs: null,
      }],
    });
  });

  it('opens the 75% band on a shared pool no single lane is anywhere near filling', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, capacityModel: 'shared' },
    });

    // Three lanes hold one entry each: the pool sits at 75% — the documented
    // early-warning band — while every lane is at 25% of the ceiling on its
    // own. The saturation tests above cannot catch a degraded branch that
    // regressed to per-lane depth, because at a full pool the two denominators
    // agree often enough to hide it. This is the shape where they disagree.
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'changelog', operation: 'changelog:reconcile' });
    tracker.enqueue({ lane: 'shared_memory', operation: 'shared-memory:on-connect' });

    expect(tracker.snapshot()).toMatchObject({
      state: 'degraded',
      totals: { queued: 3, queueLimit: 4 },
      lanes: [
        { lane: 'changelog', state: 'degraded', queued: 1, pressureQueued: 3, queueLimit: 4 },
        { lane: 'durable', state: 'degraded', queued: 1, pressureQueued: 3, queueLimit: 4 },
        { lane: 'shared_memory', state: 'degraded', queued: 1, pressureQueued: 3, queueLimit: 4 },
      ],
    });
    for (const lane of tracker.snapshot().lanes) {
      expect(lane).toMatchObject({ oldestQueuedAgeMs: 0, lastRejectedAgeMs: null });
    }
  });

  it('reports each lane its own backlog when a shared pool has no ceiling', () => {
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { capacityModel: 'shared' },
    });

    // An unbounded shared pool: no ceiling, so no depth applies and no lane is
    // classified on it. The published numerator falls back to the lane's own
    // backlog — not 0, which would put a fabricated `pressureQueued: 0` beside
    // `queued: 2` on the row and on every log line.
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'changelog', operation: 'changelog:reconcile' });

    expect(tracker.snapshot()).toMatchObject({
      state: 'healthy',
      totals: { queued: 3, queueLimit: null },
      lanes: [
        { lane: 'changelog', state: 'healthy', queued: 1, pressureQueued: 1, queueLimit: null },
        { lane: 'durable', state: 'healthy', queued: 2, pressureQueued: 2, queueLimit: null },
      ],
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
      // `inflightLimit` is asserted rather than merely exercised, so the
      // rollup's own value is pinned here too. The mutant that matters for
      // `sumLaneLimits` — relaxing it to skip nulls and sum the rest — cannot
      // be killed by THIS test: both ceilings are non-null, so `normalizeLimit`
      // short-circuits and the fallback is never reached. It is killed by the
      // unbounded-pool test above, where `totals.queueLimit: null` becomes 0.
      totals: { queued: 3, queueLimit: 4, inflightLimit: 2 },
      lanes: [
        // 3/4 of the pool is the documented 75% early-warning band.
        { lane: 'durable', state: 'degraded', capacityModel: 'shared', queued: 3, pressureQueued: 3 },
        // …and the idle lane reports the depth it was actually judged on,
        // which is none. Publishing the pool's 3 here would make a `healthy`
        // lane with nothing waiting read as 75% utilized to anyone following
        // the documented `pressureQueued / queueLimit` rule.
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
      capacityModel: 'partitioned',
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
    // Two registered schedulers, the way the daemon actually registers them —
    // one wholly shared, one wholly partitioned. The capacity model is a
    // scheduler invariant, so a single scheduler reporting a mix of both is a
    // shape the tracker cannot produce and this test must not invent.
    registry.register({
      backpressureId: 'sync-global',
      getBackpressureSnapshot: () => ({
        scheduler: 'sync-global',
        state: 'saturated',
        capacityModel: 'shared',
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
        ],
      }),
    });
    registry.register({
      backpressureId: 'store',
      getBackpressureSnapshot: () => ({
        scheduler: 'store',
        state: 'saturated',
        capacityModel: 'partitioned',
        totals: {
          queued: 4,
          queueLimit: 4,
          inflight: 0,
          inflightLimit: 2,
          oldestQueuedAgeMs: 0,
          oldestActiveAgeMs: 0,
          rejectedTotal: 0,
        },
        // A private allocation: its own backlog IS the depth that classified
        // it, so the record must carry no second number.
        lanes: [laneRow('ack', 4, { capacityModel: 'partitioned', pressureQueued: 4 })],
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

  it('drives a real shared tracker past the point where the rollup outranks its lanes', () => {
    // The assertion above feeds the monitor hand-built rows whose equal states
    // this test chose, so it cannot fail if the identity it claims to prove
    // breaks. This one derives the states from a real tracker: mutate the
    // shared numerator and a lane drops below the rollup, `sync-global` starts
    // emitting `"lane":"all"` again — the opposite of what is documented — and
    // only this test notices.
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, inflightLimit: 2, capacityModel: 'shared' },
    });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    tracker.enqueue({ lane: 'changelog', operation: 'changelog:reconcile' });
    tracker.enqueue({ lane: 'shared_memory', operation: 'shared-memory:on-connect' });

    const registry = new BackpressureRegistry();
    registry.register({
      backpressureId: 'sync-global',
      getBackpressureSnapshot: () => tracker.snapshot(),
    });
    const messages: string[] = [];
    new BackpressureMonitor({
      registry,
      now: () => now,
      emit: (_level, message) => messages.push(message),
    }).sample();

    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe('saturated');
    // Every lane holding work reaches the rollup's own state — the identity the
    // suppression depends on — so no rollup record is emitted…
    expect(snapshot.lanes.every((lane) => lane.state === snapshot.state)).toBe(true);
    expect(messages.some((m) => m.includes('"lane":"all"'))).toBe(false);
    // …and each lane record carries the pool depth that classified it.
    for (const lane of ['changelog', 'durable', 'shared_memory']) {
      const record = messages.find((m) => m.includes(`"lane":"${lane}"`));
      expect(record).toContain('"pressureQueued":4');
    }
  });

  it('exports a depth a metric consumer can divide by the limit beside it', () => {
    // The snapshot and the log line both carry the pressure numerator; metrics
    // are the third surface, and the one W1 alerting actually reads. Without
    // this a shared lane exports `queue_depth: 1` against a pool
    // `queue_limit: 4` — a utilization alert reads 25% while the lane state is
    // `degraded` at 75%, which is exactly the pressure this change exists to
    // surface.
    const now = 1_000;
    const shared = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 4, capacityModel: 'shared' },
    });
    shared.enqueue({ lane: 'durable', operation: 'durable:catchup-foreground' });
    shared.enqueue({ lane: 'changelog', operation: 'changelog:reconcile' });
    shared.enqueue({ lane: 'shared_memory', operation: 'shared-memory:on-connect' });
    const sharedSnapshot = shared.snapshot();

    const emitted = captureMetrics(() => recordBackpressureSnapshotMetrics(sharedSnapshot));
    const valueOf = (metric: string, lane: string) =>
      emitted.find((e) => e.metric === metric && e.lane === lane)?.value;

    expect(sharedSnapshot.lanes.every((lane) => lane.state === 'degraded')).toBe(true);
    for (const lane of ['changelog', 'durable', 'shared_memory']) {
      // Attribution is unchanged: each lane still exports its own backlog…
      expect(valueOf('dkg.backpressure.queue_depth', lane)).toBe(1);
      // …and the numerator that pairs with the exported limit is the pool's, so
      // a metric-only alert sees the same 75% the lane state was classified on.
      const pressure = valueOf('dkg.backpressure.pressure_depth', lane)!;
      const limit = valueOf('dkg.backpressure.queue_limit', lane)!;
      expect({ lane, pressure, limit }).toEqual({ lane, pressure: 3, limit: 4 });
      expect(pressure / limit).toBeGreaterThanOrEqual(0.75);
    }

    // A private allocation publishes the same number under both names, so a
    // consumer never has to know which model it is looking at.
    const partitioned = new SchedulerPressureTracker({
      scheduler: 'store',
      now: () => now,
      capacity: { queueLimit: 4, lanes: { ack: { queueLimit: 2 } } },
    });
    partitioned.enqueue({ lane: 'ack', operation: 'store.ack' });
    const ackEmitted = captureMetrics(() => recordBackpressureSnapshotMetrics(partitioned.snapshot()));
    const ackValue = (metric: string) =>
      ackEmitted.find((e) => e.metric === metric && e.lane === 'ack')?.value;
    expect(ackValue('dkg.backpressure.queue_depth')).toBe(1);
    expect(ackValue('dkg.backpressure.pressure_depth')).toBe(1);
  });

  it('pairs a shared row concurrency count with the ceiling that bounds it', () => {
    // The inflight half of the pressure pair had no coverage anywhere: reverting
    // it to `active.length` left both suites green, which is how a review
    // finding comes back silently. Needs its own tracker — the monitor test
    // above starts nothing, so `active.size` is 0 there and the omit-when-equal
    // rule suppresses the field on every record.
    const now = 1_000;
    const tracker = new SchedulerPressureTracker({
      scheduler: 'sync-global',
      now: () => now,
      capacity: { queueLimit: 2, inflightLimit: 2, capacityModel: 'shared' },
    });
    for (const lane of ['durable', 'changelog']) {
      tracker.start(tracker.enqueue({ lane, operation: `${lane}:reconcile` }));
      tracker.enqueue({ lane, operation: `${lane}:reconcile` });
    }

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      totals: { inflight: 2, inflightLimit: 2 },
      lanes: [
        // One admission running in each lane, against a pool of two. `inflight`
        // stays the lane's own — the attribution signal — while the count that
        // belongs with the pool's ceiling is the pool's. Publishing `1` beside
        // `inflightLimit: 2` would read as half-idle concurrency at the moment
        // the pool is full and is the reason nothing drains.
        { lane: 'changelog', inflight: 1, pressureInflight: 2, inflightLimit: 2 },
        { lane: 'durable', inflight: 1, pressureInflight: 2, inflightLimit: 2 },
      ],
    });

    // …on the log line, under the omit-when-equal rule…
    const registry = new BackpressureRegistry();
    registry.register({ backpressureId: 'sync-global', getBackpressureSnapshot: () => snapshot });
    const messages: string[] = [];
    new BackpressureMonitor({
      registry, now: () => now, emit: (_level, message) => messages.push(message),
    }).sample();
    expect(messages.find((m) => m.includes('"lane":"durable"'))).toContain('"inflight":1,"pressureInflight":2');

    // …and on the metric, by name, so a misspelt gauge is caught too.
    const emitted = captureMetrics(() => recordBackpressureSnapshotMetrics(snapshot));
    const at = (metric: string, lane: string) =>
      emitted.find((e) => e.metric === metric && e.lane === lane)?.value;
    expect(at('dkg.backpressure.inflight', 'durable')).toBe(1);
    expect(at('dkg.backpressure.pressure_inflight', 'durable')).toBe(2);

    // A private allocation reports one number under both names.
    const partitioned = new SchedulerPressureTracker({
      scheduler: 'store',
      now: () => now,
      capacity: { lanes: { ack: { inflightLimit: 2 } } },
    });
    partitioned.start(partitioned.enqueue({ lane: 'ack', operation: 'store.ack' }));
    expect(partitioned.snapshot().lanes).toMatchObject([
      { lane: 'ack', inflight: 1, pressureInflight: 1, inflightLimit: 2 },
    ]);
  });

  it('applies the empty-lane guard only where a pool is shared', () => {
    // `degradedQueueUtilization` is caller-supplied public API and appears in no
    // other test in the repo, so the scoping that keeps a private allocation
    // byte-identical to base rested on reading alone. At a zero threshold the
    // old branch read `0 / limit >= 0` as degraded on an idle lane; that must
    // still happen for `partitioned`, and must not for `shared`.
    const now = 1_000;
    const idleLane = (capacity: Parameters<typeof SchedulerPressureTracker>[0]['capacity']) => {
      const tracker = new SchedulerPressureTracker({
        scheduler: 'probe',
        now: () => now,
        capacity,
        thresholds: { degradedQueueUtilization: 0 },
      });
      // Give the lane a runtime without queueing or rejecting anything.
      tracker.cancelQueued(tracker.enqueue({ lane: 'interactive', operation: 'probe' }));
      return tracker.snapshot().lanes[0];
    };

    expect(idleLane({ lanes: { interactive: { queueLimit: 4 } } })).toMatchObject({
      lane: 'interactive', capacityModel: 'partitioned', queued: 0, state: 'degraded',
    });
    expect(idleLane({ queueLimit: 4, capacityModel: 'shared' })).toMatchObject({
      lane: 'interactive', capacityModel: 'shared', queued: 0, state: 'healthy',
    });
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
