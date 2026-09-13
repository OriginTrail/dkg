import { describe, expect, it, vi } from 'vitest';
import { SchedulerPressureTracker } from '../src/backpressure-observability.js';
import {
  capturePressureCapacity,
  reconcilePressureCapacity,
  type SchedulerPressureCapacity,
} from '../src/scheduler-pressure-capacity.js';

describe('scheduler pressure capacity ownership', () => {
  it('owns dynamic capacity through ticket lifecycle and semantic equality', () => {
    const tracker = new SchedulerPressureTracker({
      scheduler: 'dynamic-capacity',
      capacity: { capacityModel: 'shared', queueLimit: 9, inflightLimit: 3 },
    });
    const firstCapacity = {
      capacityModel: 'partitioned' as const,
      queueLimit: 4,
      inflightLimit: 2,
      lanes: {
        fast: { queueLimit: 2, inflightLimit: 1 },
        slow: { queueLimit: 2, inflightLimit: 1 },
      },
    };
    const equivalentCapacity = {
      lanes: {
        slow: { inflightLimit: 1, queueLimit: 2 },
        fast: { inflightLimit: 1, queueLimit: 2 },
      },
      inflightLimit: 2,
      queueLimit: 4,
    };

    const active = tracker.enqueue(
      { lane: 'fast', operation: 'active' },
      firstCapacity,
    );
    const rejected = tracker.enqueue(
      { lane: 'slow', operation: 'rejected' },
      equivalentCapacity,
    );
    // Repeated diagnostics must not serialize each queued/active policy again.
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
      tracker.snapshot();
      tracker.snapshot();
      tracker.start(active);
      tracker.snapshot();
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
    expect(tracker.snapshot()).toMatchObject({
      capacityState: 'uniform',
      capacityModel: 'partitioned',
      totals: { queued: 1, inflight: 1, queueLimit: 4, inflightLimit: 2 },
    });

    tracker.rejectQueued(rejected, 'owner_queue_full');
    expect(tracker.snapshot()).toMatchObject({
      capacityModel: 'partitioned',
      totals: { queued: 0, inflight: 1, queueLimit: 4, inflightLimit: 2 },
    });

    const cancelled = tracker.enqueue(
      { lane: 'slow', operation: 'cancelled' },
      { capacityModel: 'shared', queueLimit: 8, inflightLimit: 4 },
    );
    expect(tracker.snapshot()).toMatchObject({
      capacityModel: 'shared',
      totals: { queued: 1, inflight: 1, queueLimit: null, inflightLimit: null },
    });
    tracker.cancelQueued(cancelled, 'aborted');
    expect(tracker.snapshot()).toMatchObject({
      capacityModel: 'partitioned',
      totals: { queued: 0, inflight: 1, queueLimit: 4, inflightLimit: 2 },
    });

    tracker.finish(active, 'released');
    expect(tracker.snapshot()).toMatchObject({
      capacityModel: 'shared',
      totals: { queued: 0, inflight: 0, queueLimit: 9, inflightLimit: 3 },
    });
  });

  it.each(['queued', 'active'] as const)('includes %s fallback tickets in mixed-policy ceilings', (state) => {
    const tracker = new SchedulerPressureTracker({
      scheduler: 'fallback-capacity',
      capacity: { capacityModel: 'shared', queueLimit: 9, inflightLimit: 3 },
    });
    const legacy = tracker.enqueue({ lane: 'default', operation: 'legacy' });
    if (state === 'active') tracker.start(legacy);
    const explicit = tracker.enqueue({ lane: 'default', operation: 'explicit' },
      { capacityModel: 'shared', queueLimit: 2, inflightLimit: 1 });
    expect(tracker.snapshot()).toMatchObject({
      state: 'healthy', totals: { queueLimit: null, inflightLimit: null },
    });
    tracker.cancelQueued(explicit, 'aborted');
    expect(tracker.snapshot()).toMatchObject({ totals: { queueLimit: 9, inflightLimit: 3 } });
    if (state === 'active') tracker.finish(legacy, 'completed');
    else tracker.cancelQueued(legacy, 'aborted');
    expect(tracker.snapshot()).toMatchObject({ totals: { queued: 0, inflight: 0, queueLimit: 9 } });
  });

  it('compares explicit tickets with the current fallback without serializing on reads', () => {
    const fallback = { capacityModel: 'shared' as const, queueLimit: 9, inflightLimit: 3 };
    const tracker = new SchedulerPressureTracker({ scheduler: 'fallback-updates', capacity: fallback });
    tracker.enqueue({ lane: 'default', operation: 'legacy' });
    tracker.enqueue({ lane: 'default', operation: 'explicit' }, { inflightLimit: 3, queueLimit: 9, capacityModel: 'shared' });
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
      expect(tracker.snapshot()).toMatchObject({ totals: { queueLimit: 9, inflightLimit: 3 } });
      expect(serialize).not.toHaveBeenCalled();
    } finally { serialize.mockRestore(); }
    tracker.updateCapacity({ capacityModel: 'shared', queueLimit: 2, inflightLimit: 1 });
    expect(tracker.snapshot()).toMatchObject({ totals: { queueLimit: null, inflightLimit: null } });
    tracker.updateCapacity(fallback);
    expect(tracker.snapshot()).toMatchObject({ totals: { queueLimit: 9, inflightLimit: 3 } });
  });

  it.each(['shared', 'partitioned'] as const)('represents differing %s policies as mixed without shared-pool pressure', (model) => {
    const policy = (limit: number): SchedulerPressureCapacity => model === 'shared'
      ? { capacityModel: 'shared', queueLimit: limit, inflightLimit: limit }
      : {
        capacityModel: 'partitioned', queueLimit: limit, inflightLimit: limit,
        lanes: { fast: { queueLimit: limit, inflightLimit: limit }, slow: { queueLimit: limit, inflightLimit: limit } },
      };
    const first = policy(1);
    const second = policy(2);
    const fallback = capturePressureCapacity({});
    expect(reconcilePressureCapacity([], fallback)).toEqual({ kind: 'uniform', capacity: fallback.value });
    expect(reconcilePressureCapacity([[{ capacity: capturePressureCapacity(first) }]], fallback)).toMatchObject({
      kind: 'uniform', capacity: { capacityModel: model, queueLimit: 1 },
    });
    expect(reconcilePressureCapacity([
      [{ capacity: capturePressureCapacity(first) }], [{ capacity: capturePressureCapacity(second) }],
    ], fallback)).toEqual({ kind: 'mixed' });

    let now = 0;
    const tracker = new SchedulerPressureTracker({ scheduler: 'explicit-mixed', now: () => now,
      thresholds: { degradedQueueAgeMs: 100, stalledActiveAgeMs: 200 } });
    const active = tracker.enqueue({ lane: 'fast', operation: 'active' }, first);
    tracker.start(active);
    tracker.enqueue({ lane: 'slow', operation: 'queued' }, second);
    const snapshot = tracker.snapshot();
    // The old outward label is a compatibility projection. Mixed owners have
    // unknown ceilings and local lane counts; they never share a capacity pool:
    // the queued ticket is half of its own owner's ceiling, and the other
    // owner's full inflight allocation is not charged against it.
    expect(snapshot).toMatchObject({ capacityState: 'mixed', capacityModel: 'shared', state: 'healthy',
      totals: { queueLimit: null, inflightLimit: null, queued: 1, inflight: 1 } });
    expect(snapshot.lanes).toMatchObject([
      { lane: 'fast', capacityState: 'mixed', capacityModel: 'shared', queueLimit: null, inflightLimit: null, pressureQueued: 0, pressureInflight: 1, stateReasons: [] },
      { lane: 'slow', capacityState: 'mixed', capacityModel: 'shared', queueLimit: null, inflightLimit: null, pressureQueued: 1, pressureInflight: 0, stateReasons: [] },
    ]);
    now = 100;
    expect(tracker.snapshot()).toMatchObject({ state: 'degraded' });
    now = 200;
    expect(tracker.snapshot()).toMatchObject({ state: 'stalled' });
  });

  it.each(['shared', 'partitioned'] as const)('classifies mixed %s owners against their own queues and reports the worst', (model) => {
    const policy = (queueLimit: number, lanes: string[]): SchedulerPressureCapacity => model === 'shared'
      ? { capacityModel: 'shared', queueLimit, inflightLimit: queueLimit }
      : {
        capacityModel: 'partitioned', queueLimit, inflightLimit: queueLimit,
        lanes: Object.fromEntries(lanes.map((lane) => [lane, { queueLimit, inflightLimit: queueLimit }])),
      };
    const strict = policy(1, ['durable']);
    const loose = policy(4, ['changelog', 'durable']);
    const tracker = new SchedulerPressureTracker({ scheduler: 'mixed-owner-depth' });
    tracker.start(tracker.enqueue({ lane: 'durable', operation: 'strict' }, strict));
    tracker.start(tracker.enqueue({ lane: 'changelog', operation: 'loose' }, loose));
    expect(tracker.snapshot()).toMatchObject({ capacityState: 'mixed', state: 'healthy',
      totals: { queued: 0, inflight: 2, queueLimit: null, inflightLimit: null } });

    // The strict owner's queue is full even though the looser owner keeps the
    // aggregate ceilings unknown; only the lane its work waits on saturates.
    const strictQueued = tracker.enqueue({ lane: 'durable', operation: 'strict' }, strict);
    const saturated = tracker.snapshot();
    expect(saturated).toMatchObject({ capacityState: 'mixed', state: 'saturated',
      totals: { queued: 1, inflight: 2, queueLimit: null, inflightLimit: null } });
    expect(saturated.lanes).toMatchObject([
      { lane: 'changelog', state: 'healthy', queueLimit: null, pressureQueued: 0, stateReasons: [] },
      { lane: 'durable', state: 'saturated', queueLimit: null, pressureQueued: 1, stateReasons: ['depth'] },
    ]);
    tracker.enqueue({ lane: 'durable', operation: 'loose' }, loose);
    expect(tracker.snapshot()).toMatchObject({ state: 'saturated', totals: { queued: 2, queueLimit: null } });

    // Once the strict owner drains, the loose owner is measured on its own:
    // one of four waiting is healthy, an unbounded owner adds no depth, three
    // of four is the degraded band, and a full queue saturates again.
    tracker.cancelQueued(strictQueued);
    tracker.enqueue({ lane: 'durable', operation: 'unbounded' }, { capacityModel: 'shared' });
    expect(tracker.snapshot()).toMatchObject({ capacityState: 'mixed', state: 'healthy',
      lanes: [{ lane: 'changelog', state: 'healthy' }, { lane: 'durable', state: 'healthy', pressureQueued: 2, stateReasons: [] }] });
    tracker.enqueue({ lane: 'durable', operation: 'loose' }, loose);
    tracker.enqueue({ lane: 'durable', operation: 'loose' }, loose);
    expect(tracker.snapshot()).toMatchObject({ state: 'degraded',
      lanes: [{ lane: 'changelog', state: 'healthy' }, { lane: 'durable', state: 'degraded', pressureQueued: 4, stateReasons: ['depth'] }] });
    tracker.enqueue({ lane: 'durable', operation: 'loose' }, loose);
    expect(tracker.snapshot()).toMatchObject({ state: 'saturated', totals: { queued: 5, queueLimit: null } });
  });

  it('owns enqueued capacity values independently of later caller mutation', () => {
    const tracker = new SchedulerPressureTracker({ scheduler: 'captured-capacity' });
    const capacity = {
      queueLimit: 4, inflightLimit: 2,
      lanes: { fast: { queueLimit: 4, inflightLimit: 2 } },
    };
    const active = tracker.enqueue({ lane: 'fast', operation: 'original' }, capacity);
    tracker.start(active);
    capacity.queueLimit = 8;
    capacity.lanes.fast.queueLimit = 8;
    expect(tracker.snapshot()).toMatchObject({
      totals: { queueLimit: 4, inflightLimit: 2 },
      lanes: [{ lane: 'fast', queueLimit: 4, inflightLimit: 2 }],
    });

    // The same caller object represents a new owner policy on its next enqueue.
    const changed = tracker.enqueue({ lane: 'fast', operation: 'changed' }, capacity);
    expect(tracker.snapshot().totals).toMatchObject({ queueLimit: null, inflightLimit: null });
    tracker.finish(active, 'released');
    expect(tracker.snapshot().totals).toMatchObject({ queueLimit: 8, inflightLimit: 2 });
    tracker.cancelQueued(changed);
    expect(tracker.snapshot().totals).toMatchObject({ queueLimit: null, inflightLimit: null });
  });
});
