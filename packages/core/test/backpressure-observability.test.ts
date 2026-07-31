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
