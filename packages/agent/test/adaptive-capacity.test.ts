import { describe, expect, it } from 'vitest';
import {
  AdaptiveCapacityController,
  MAX_SYNC_ADAPTIVE_INFLIGHT,
  resolveAdaptiveCapacityBounds,
  type AdaptiveCapacitySample,
} from '../src/sync/adaptive-capacity.js';

const healthyStore = {
  telemetryAvailable: true,
  ackQueued: 0,
  healthQueued: 0,
  normalQueued: 0,
  backgroundQueued: 0,
} as const;

function healthySample(
  overrides: Partial<AdaptiveCapacitySample> = {},
): AdaptiveCapacitySample {
  return {
    demand: true,
    cpuUtilization: 0.3,
    heapRatio: 0.4,
    eventLoopUtilization: 0.35,
    store: healthyStore,
    ...overrides,
  };
}

function controller(
  input: Parameters<typeof resolveAdaptiveCapacityBounds>[0] = {},
  now = 0,
): AdaptiveCapacityController {
  const bounds = resolveAdaptiveCapacityBounds(input);
  if (bounds.mode !== 'bounded') throw new Error('test requires bounded capacity');
  return new AdaptiveCapacityController(bounds, { now: () => now });
}

describe('adaptive sync capacity bounds', () => {
  it('resolves safe defaults and clamps the initial and hard maximum', () => {
    expect(resolveAdaptiveCapacityBounds({})).toEqual({
      mode: 'bounded',
      initialInflight: 2,
      minInflight: 1,
      maxInflight: MAX_SYNC_ADAPTIVE_INFLIGHT,
      configuredCoverageBatch: 8,
    });
    expect(resolveAdaptiveCapacityBounds({
      initialInflight: 12,
      maxInflight: 20,
      configuredCoverageBatch: 3,
    })).toEqual({
      mode: 'bounded',
      initialInflight: 8,
      minInflight: 1,
      maxInflight: 8,
      configuredCoverageBatch: 3,
    });
    expect(resolveAdaptiveCapacityBounds({
      initialInflight: 1,
      minInflight: 3,
      maxInflight: 5,
    })).toMatchObject({ initialInflight: 3, minInflight: 3, maxInflight: 5 });
  });

  it('preserves zero as unbounded inflight and disabled automatic coverage', () => {
    expect(resolveAdaptiveCapacityBounds({
      initialInflight: 0,
      configuredCoverageBatch: 0,
    })).toEqual({
      mode: 'unbounded',
      configuredCoverageBatch: 0,
    });
  });

  it('fails clearly on invalid or contradictory bounded input', () => {
    expect(() => resolveAdaptiveCapacityBounds({ initialInflight: -1 }))
      .toThrow(/initialInflight/);
    expect(() => resolveAdaptiveCapacityBounds({ initialInflight: 1.5 }))
      .toThrow(/initialInflight/);
    expect(() => resolveAdaptiveCapacityBounds({ minInflight: 0 }))
      .toThrow(/minInflight/);
    expect(() => resolveAdaptiveCapacityBounds({ minInflight: 4, maxInflight: 3 }))
      .toThrow(/maxInflight/);
    expect(() => resolveAdaptiveCapacityBounds({ minInflight: 9, maxInflight: 10 }))
      .toThrow(/absolute adaptive cap/);
    expect(() => resolveAdaptiveCapacityBounds({ configuredCoverageBatch: -1 }))
      .toThrow(/configuredCoverageBatch/);
    expect(() => resolveAdaptiveCapacityBounds({ configuredCoverageBatch: 1.5 }))
      .toThrow(/configuredCoverageBatch/);
  });
});

describe('adaptive sync capacity controller', () => {
  it('exposes a cheap immutable status before the first sample', () => {
    const capacity = controller({ initialInflight: 2, maxInflight: 4 });

    const first = capacity.getStatus();
    const second = capacity.getStatus();

    expect(first).not.toBe(second);
    expect(capacity.getCurrentInflight()).toBe(2);
    expect(capacity.getEffectiveCoverageBatch()).toBe(8);
    expect(first).toMatchObject({
      state: 'warming',
      currentInflight: 2,
      minInflight: 1,
      maxInflight: 4,
      effectiveCoverageBatch: 8,
      storePressureTelemetryAvailable: false,
      cooldownUntilMs: 30_000,
      lastDecision: { action: 'hold', reason: 'warming', atMs: 0 },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.lastDecision)).toBe(true);
  });

  it('increases by exactly one after six healthy demand samples and the cooldown', () => {
    const capacity = controller({ initialInflight: 2, maxInflight: 5 });

    for (let sample = 1; sample <= 5; sample += 1) {
      expect(capacity.observe(healthySample(), sample * 5_000).currentInflight).toBe(2);
    }
    const grown = capacity.observe(healthySample(), 30_000);

    expect(grown).toMatchObject({
      state: 'cooldown',
      currentInflight: 3,
      consecutiveHealthyDemandSamples: 0,
      cooldownUntilMs: 60_000,
      lastDecision: {
        action: 'increase',
        previousInflight: 2,
        currentInflight: 3,
      },
    });
  });

  it('does not treat an idle sync queue as growth demand', () => {
    const capacity = controller({ initialInflight: 2, maxInflight: 5 });

    for (let sample = 1; sample <= 12; sample += 1) {
      capacity.observe(healthySample({ demand: false }), sample * 5_000);
    }

    expect(capacity.getStatus()).toMatchObject({
      state: 'healthy',
      currentInflight: 2,
      consecutiveHealthyDemandSamples: 0,
      lastDecision: { action: 'hold', reason: 'no_demand' },
    });
  });

  it.each([
    ['ACK work', healthySample({ store: { ...healthyStore, ackQueued: 1 } }), 'critical_ack_queue'],
    ['health work', healthySample({ store: { ...healthyStore, healthQueued: 1 } }), 'critical_health_queue'],
    ['store saturation', healthySample({ store: { ...healthyStore, saturated: true } }), 'critical_store_saturated'],
    ['store stall', healthySample({ store: { ...healthyStore, stalled: true } }), 'critical_store_stalled'],
    ['heap pressure', healthySample({ heapRatio: 0.82 }), 'critical_heap'],
    ['event-loop pressure', healthySample({ eventLoopUtilization: 0.92 }), 'critical_event_loop'],
  ] as const)('immediately halves on critical %s', (_label, sample, reason) => {
    const capacity = controller({
      initialInflight: 7,
      minInflight: 1,
      maxInflight: 8,
      configuredCoverageBatch: 7,
    });

    const status = capacity.observe(sample, 1_000);

    expect(status).toMatchObject({
      state: 'constrained',
      currentInflight: 3,
      effectiveCoverageBatch: 3,
      cooldownUntilMs: 31_000,
      lastDecision: {
        action: 'halve',
        reason,
        previousInflight: 7,
        currentInflight: 3,
        previousCoverageBatch: 7,
        currentCoverageBatch: 3,
      },
    });
  });

  it.each([
    ['normal store queue', healthySample({ store: { ...healthyStore, normalQueued: 1 } }), 'strained_store_queue'],
    ['background store queue', healthySample({ store: { ...healthyStore, backgroundQueued: 1 } }), 'strained_store_queue'],
    ['CPU', healthySample({ cpuUtilization: 0.85 }), 'strained_cpu'],
    ['heap', healthySample({ heapRatio: 0.72 }), 'strained_heap'],
    ['event loop', healthySample({ eventLoopUtilization: 0.8 }), 'strained_event_loop'],
  ] as const)('requires two consecutive strained %s samples', (_label, sample, reason) => {
    const capacity = controller({
      initialInflight: 4,
      maxInflight: 8,
      configuredCoverageBatch: 4,
    });

    expect(capacity.observe(sample, 5_000)).toMatchObject({
      currentInflight: 4,
      effectiveCoverageBatch: 4,
      consecutiveStrainedSamples: 1,
      lastDecision: { action: 'hold', reason: 'strained_hysteresis' },
    });
    expect(capacity.observe(sample, 10_000)).toMatchObject({
      state: 'constrained',
      currentInflight: 3,
      effectiveCoverageBatch: 3,
      consecutiveStrainedSamples: 0,
      lastDecision: { action: 'decrease', reason },
    });
  });

  it('requires consecutive strain and holds when signals are ambiguous', () => {
    const capacity = controller({ initialInflight: 4, maxInflight: 8 });
    const strained = healthySample({ cpuUtilization: 0.85 });

    capacity.observe(strained, 5_000);
    const ambiguous = capacity.observe({
      demand: true,
      heapRatio: 0.65,
      store: { telemetryAvailable: false },
    }, 10_000);
    const nextStrained = capacity.observe(strained, 15_000);

    expect(ambiguous.lastDecision.reason).toBe('ambiguous_signals');
    expect(nextStrained).toMatchObject({
      currentInflight: 4,
      consecutiveStrainedSamples: 1,
    });
  });

  it('uses the cooldown to prevent an immediate healthy rebound', () => {
    const capacity = controller({ initialInflight: 4, maxInflight: 8 });
    capacity.observe(healthySample({ heapRatio: 0.82 }), 1_000);

    for (let sample = 1; sample <= 6; sample += 1) {
      capacity.observe(healthySample(), 1_000 + sample * 4_000);
    }
    expect(capacity.getStatus()).toMatchObject({
      state: 'cooldown',
      currentInflight: 2,
      consecutiveHealthyDemandSamples: 6,
      lastDecision: { action: 'hold', reason: 'cooldown' },
    });

    expect(capacity.observe(healthySample(), 31_000)).toMatchObject({
      currentInflight: 3,
      consecutiveHealthyDemandSamples: 0,
      lastDecision: { action: 'increase' },
    });
  });

  it('allows host-healthy growth to two without store telemetry but never above it', () => {
    const capacity = controller({
      initialInflight: 1,
      minInflight: 1,
      maxInflight: 6,
      configuredCoverageBatch: 0,
    });
    const noStoreTelemetry = healthySample({
      store: { telemetryAvailable: false },
    });

    for (let sample = 1; sample <= 6; sample += 1) {
      capacity.observe(noStoreTelemetry, sample * 5_000);
    }
    expect(capacity.getStatus()).toMatchObject({
      currentInflight: 2,
      effectiveCoverageBatch: 0,
      storePressureTelemetryAvailable: false,
    });

    for (let sample = 7; sample <= 18; sample += 1) {
      capacity.observe(noStoreTelemetry, sample * 5_000);
    }
    expect(capacity.getStatus()).toMatchObject({
      state: 'constrained',
      currentInflight: 2,
      effectiveCoverageBatch: 0,
      lastDecision: { action: 'hold', reason: 'store_telemetry_growth_cap' },
    });
  });

  it('restores a reduced coverage batch without exceeding its configured maximum', () => {
    const capacity = controller({
      initialInflight: 2,
      maxInflight: 2,
      configuredCoverageBatch: 4,
    });
    capacity.observe(healthySample({ heapRatio: 0.82 }), 0);
    expect(capacity.getStatus().effectiveCoverageBatch).toBe(2);

    for (let sample = 1; sample <= 6; sample += 1) {
      capacity.observe(healthySample(), 30_000 + sample * 5_000);
    }
    expect(capacity.getStatus()).toMatchObject({
      currentInflight: 2,
      effectiveCoverageBatch: 3,
      lastDecision: { action: 'increase' },
    });

    for (let sample = 1; sample <= 6; sample += 1) {
      capacity.observe(healthySample(), 60_000 + sample * 5_000);
    }
    expect(capacity.getStatus().effectiveCoverageBatch).toBe(4);
  });

  it('never enables a configured zero coverage batch', () => {
    const capacity = controller({
      initialInflight: 4,
      maxInflight: 8,
      configuredCoverageBatch: 0,
    });
    capacity.observe(healthySample({ heapRatio: 0.82 }), 1_000);
    for (let sample = 1; sample <= 12; sample += 1) {
      capacity.observe(healthySample(), 31_000 + sample * 5_000);
    }

    expect(capacity.getStatus().effectiveCoverageBatch).toBe(0);
  });

  it('rejects malformed samples instead of making unsafe decisions', () => {
    const capacity = controller();
    expect(() => capacity.observe(healthySample({ cpuUtilization: 1.1 }), 1))
      .toThrow(/cpuUtilization/);
    expect(() => capacity.observe(healthySample({ heapRatio: Number.NaN }), 1))
      .toThrow(/heapRatio/);
    expect(() => capacity.observe(healthySample({
      store: { ...healthyStore, normalQueued: -1 },
    }), 1)).toThrow(/store.normalQueued/);
    expect(() => capacity.observe(healthySample(), Number.NaN)).toThrow(/atMs/);
  });
});
