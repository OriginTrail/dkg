import { describe, expect, it } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  AdaptiveCapacitySampler,
  deriveAdaptiveInflightHardMax,
} from '../src/sync/adaptive-capacity-sampler.js';

function fakeStore(pressure?: ReturnType<NonNullable<TripleStore['getPressureSnapshot']>>): TripleStore {
  return {
    getPressureSnapshot: () => pressure,
  } as unknown as TripleStore;
}

describe('adaptive capacity sampler', () => {
  it('reports interval host utilization and live store queues', () => {
    const cpu = [
      { idle: 40, total: 100 },
      { idle: 50, total: 200 },
    ];
    const eventLoop = [
      { idle: 1, active: 1, utilization: 0.5 },
      { idle: 2, active: 2, utilization: 0.5 },
    ];
    const sampler = new AdaptiveCapacitySampler(fakeStore({
      ackInflight: 0,
      normalInflight: 1,
      backgroundInflight: 0,
      ackQueued: 0,
      healthQueued: 2,
      normalQueued: 2,
      backgroundQueued: 0,
      maxConcurrent: 4,
      ackReservedSlots: 1,
    }), {
      readCpuTimes: () => cpu.shift()!,
      readEventLoopUtilization: () => eventLoop.shift()!,
      eventLoopUtilizationDelta: () => 0.25,
      readHeapRatio: () => 0.4,
    });

    expect(sampler.sample(true)).toEqual({
      demand: true,
      cpuUtilization: 0.9,
      eventLoopUtilization: 0.25,
      heapRatio: 0.4,
      store: {
        telemetryAvailable: true,
        ackQueued: 0,
        healthQueued: 2,
        normalQueued: 2,
        backgroundQueued: 0,
      },
    });
  });

  it('fails closed to unavailable store telemetry', () => {
    const sampler = new AdaptiveCapacitySampler(fakeStore(), {
      readCpuTimes: () => ({ idle: 1, total: 2 }),
      readEventLoopUtilization: () => ({ idle: 1, active: 1, utilization: 0.5 }),
      eventLoopUtilizationDelta: () => Number.NaN,
      readHeapRatio: () => undefined,
    });

    expect(sampler.sample(false)).toMatchObject({
      demand: false,
      store: { telemetryAvailable: false },
    });
  });

  it('caps the hard maximum by operator, hardware, and store capacity', () => {
    expect(deriveAdaptiveInflightHardMax({ operatorMax: 3, parallelism: 16 })).toBe(3);
    expect(deriveAdaptiveInflightHardMax({
      operatorMax: 8,
      parallelism: 16,
      storePressure: {
        ackInflight: 0,
        healthInflight: 0,
        normalInflight: 0,
        backgroundInflight: 0,
        ackQueued: 0,
        healthQueued: 0,
        normalQueued: 0,
        backgroundQueued: 0,
        maxConcurrent: 4,
        ackReservedSlots: 1,
        healthReservedSlots: 1,
        normalReservedSlots: 1,
      },
    })).toBe(1);
    expect(deriveAdaptiveInflightHardMax({
      operatorMax: 7,
      parallelism: 12,
      storePressure: {
        ackInflight: 0,
        healthInflight: 0,
        normalInflight: 0,
        backgroundInflight: 0,
        ackQueued: 0,
        healthQueued: 0,
        normalQueued: 0,
        backgroundQueued: 0,
        maxConcurrent: 5,
        ackReservedSlots: 1,
        healthReservedSlots: 1,
      },
    })).toBe(3);
    expect(deriveAdaptiveInflightHardMax({ operatorMax: 8, parallelism: 2 })).toBe(1);
  });
});
