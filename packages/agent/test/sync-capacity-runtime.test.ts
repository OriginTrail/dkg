import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { StorePressureSnapshot, TripleStore } from '@origintrail-official/dkg-storage';
import { SyncCapacityRuntime } from '../src/sync/capacity-runtime.js';
import { CorePublicSyncCoverageScheduler } from '../src/sync/core-public-coverage-scheduler.js';
import { withGlobalSyncBackpressure } from '../src/sync/backpressure.js';

function fakeStore(pressure?: StorePressureSnapshot): TripleStore {
  return {
    getPressureSnapshot: () => pressure,
  } as unknown as TripleStore;
}

const STORE_PRESSURE: StorePressureSnapshot = {
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
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('sync capacity runtime resolution', () => {
  it('keeps Edge nodes on the exact static policy even if adaptive is requested', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'edge',
      syncGlobalMaxInflight: 4,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(false);
    expect(runtime.getResolvedPolicyStatus()).toMatchObject({ inflightLimit: 4 });
    expect(runtime.getAdmissionOptions()).toHaveProperty('policy');
    expect(runtime.getStatus()).toMatchObject({ mode: 'static', currentInflight: 4 });
  });

  it('defaults Core nodes without an explicit global limit to adaptive mode', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncCorePublicBatchSize: 7,
    }, fakeStore(STORE_PRESSURE), { parallelism: 16, now: () => 100 });

    expect(runtime.isAdaptive()).toBe(true);
    expect(runtime.getResolvedPolicyStatus()).toMatchObject({
      inflightLimit: 3,
      queueLimit: 6,
    });
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 2,
      minInflight: 1,
      maxInflight: 3,
      currentCoverageBatch: 7,
      configuredCoverageBatch: 7,
    });
    expect(runtime.getAdmissionOptions()).toHaveProperty('policy');
    expect(runtime.getBackpressureSnapshot().limit).toBe(2);
  });

  it('owns sampling and restores constrained coverage from supplemental Core demand', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let heapRatio = 0.82;
    let cpuIdle = 0;
    let cpuTotal = 0;
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncCorePublicBatchSize: 8,
    }, fakeStore(STORE_PRESSURE), {
      parallelism: 16,
      samplerDependencies: {
        readCpuTimes: () => {
          cpuIdle += 80;
          cpuTotal += 100;
          return { idle: cpuIdle, total: cpuTotal };
        },
        readEventLoopUtilization: () => ({ idle: 1, active: 1, utilization: 0.5 }),
        eventLoopUtilizationDelta: () => 0.2,
        readHeapRatio: () => heapRatio,
      },
    });
    const coverage = new CorePublicSyncCoverageScheduler(8);
    for (const contextGraphId of ['cg:a', 'cg:b', 'cg:c', 'cg:d', 'cg:e']) {
      coverage.register(contextGraphId);
    }

    runtime.sample(true);
    expect(runtime.getStatus()).toMatchObject({
      currentInflight: 1,
      currentCoverageBatch: 4,
      lastDecision: { action: 'halve', reason: 'critical_heap' },
    });

    heapRatio = 0.3;
    expect(runtime.startSampling({
      hasSupplementalDemand: () => coverage.hasAutomaticCoverageBacklog(
        [],
        runtime.getEffectiveCoverageBatch(),
      ),
      intervalMs: 5_000,
      onError: (error) => { throw error; },
    })).toBe(true);
    vi.advanceTimersByTime(30_000);

    expect(runtime.getStatus()).toMatchObject({
      currentInflight: 2,
      currentCoverageBatch: 5,
      lastDecision: { action: 'increase', reason: 'healthy_hysteresis' },
    });
    expect(runtime.stopSampling()).toBe(true);
    expect(runtime.stopSampling()).toBe(false);
  });

  it('pumps queued requester work when a healthy sample raises live capacity', async () => {
    let now = 0;
    let heapRatio = 0.82;
    let cpuIdle = 0;
    let cpuTotal = 0;
    const runtime = SyncCapacityRuntime.create({ nodeRole: 'core' }, fakeStore(STORE_PRESSURE), {
      parallelism: 16,
      now: () => now,
      samplerDependencies: {
        readCpuTimes: () => {
          cpuIdle += 80;
          cpuTotal += 100;
          return { idle: cpuIdle, total: cpuTotal };
        },
        readEventLoopUtilization: () => ({ idle: 1, active: 1, utilization: 0.5 }),
        eventLoopUtilizationDelta: () => 0.2,
        readHeapRatio: () => heapRatio,
      },
    });
    runtime.sample(true);
    expect(runtime.getStatus().currentInflight).toBe(1);

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlock = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const ctx = createOperationContext('test');
    const first = withGlobalSyncBackpressure({
      ...runtime.getAdmissionOptions(),
      ctx,
      label: 'durable:first',
    }, async () => {
      markFirstStarted();
      await firstBlock;
    });
    await firstStarted;

    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    let secondRan = false;
    const second = withGlobalSyncBackpressure({
      ...runtime.getAdmissionOptions(),
      ctx,
      label: 'durable:second',
    }, async () => {
      secondRan = true;
      markSecondStarted();
    });
    await Promise.resolve();
    expect(secondRan).toBe(false);

    heapRatio = 0.3;
    for (let sample = 1; sample <= 6; sample += 1) {
      now = sample * 5_000;
      runtime.sample(true);
    }
    await secondStarted;
    expect(runtime.getStatus().currentInflight).toBe(2);
    expect(secondRan).toBe(true);

    releaseFirst();
    await Promise.all([first, second]);
  });

  it('keeps an explicit Core limit static unless adaptation is explicitly enabled', () => {
    const staticRuntime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 6,
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });
    const adaptiveRuntime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 6,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(staticRuntime.isAdaptive()).toBe(false);
    expect(staticRuntime.getResolvedPolicyStatus().inflightLimit).toBe(6);
    expect(adaptiveRuntime.isAdaptive()).toBe(true);
    expect(adaptiveRuntime.getResolvedPolicyStatus()).toEqual({
      inflightLimit: 3,
      queueLimit: 6,
    });
    expect(adaptiveRuntime.getStatus().maxInflight).toBe(3);
  });

  it('sizes the default adaptive queue from the effective hard maximum', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 100,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 64 });

    expect(runtime.getResolvedPolicyStatus()).toEqual({
      inflightLimit: 3,
      queueLimit: 6,
    });
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 2,
      maxInflight: 3,
    });
  });

  it('does not reapply a larger global-limit env after deriving the adaptive hard maximum', () => {
    vi.stubEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT', '100');
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 64 });

    expect(runtime.getResolvedPolicyStatus()).toEqual({
      inflightLimit: 3,
      queueLimit: 6,
    });
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 2,
      maxInflight: 3,
    });
  });

  it('honors the config-level adaptive opt-out', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncAdaptiveCapacity: { enabled: false },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(false);
    expect(runtime.getStatus()).toMatchObject({ mode: 'static', currentInflight: 2 });
  });

  it('applies valid config-level adaptive min and max bounds', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncAdaptiveCapacity: { minInflight: 1, maxInflight: 2 },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(true);
    expect(runtime.getResolvedPolicyStatus()).toEqual({
      inflightLimit: 2,
      queueLimit: 4,
    });
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 2,
      minInflight: 1,
      maxInflight: 2,
    });
  });

  it('uses the legacy environment limit ahead of newer config for adaptive policy and status', () => {
    vi.stubEnv('DKG_SYNC_GLOBAL_LIMIT', '1');
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 6,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(true);
    expect(runtime.getResolvedPolicyStatus().inflightLimit).toBe(1);
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 1,
      minInflight: 1,
      maxInflight: 1,
    });
  });

  it.each([0, -1, 1.5])('rejects invalid configured adaptive max %s', (maxInflight) => {
    expect(() => SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncAdaptiveCapacity: { maxInflight },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 })).toThrow(
      'syncAdaptiveCapacity.maxInflight must be a positive integer',
    );
  });

  it('rejects an invalid adaptive max environment override instead of dropping a valid config ceiling', () => {
    vi.stubEnv('DKG_SYNC_ADAPTIVE_MAX_INFLIGHT', '0');
    expect(() => SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncAdaptiveCapacity: { maxInflight: 1 },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 })).toThrow(
      'DKG_SYNC_ADAPTIVE_MAX_INFLIGHT must be a positive integer',
    );
  });

  it('rejects an invalid adaptive minimum instead of silently widening the controller bounds', () => {
    vi.stubEnv('DKG_SYNC_ADAPTIVE_MIN_INFLIGHT', '1.5');
    expect(() => SyncCapacityRuntime.create({
      nodeRole: 'core',
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 })).toThrow(
      'DKG_SYNC_ADAPTIVE_MIN_INFLIGHT must be a positive integer',
    );
  });

  it('retains explicit zero as unbounded and disables adaptation', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 0,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(false);
    expect(runtime.getResolvedPolicyStatus().inflightLimit).toBeNull();
    expect(runtime.getStatus().currentInflight).toBeNull();
  });

  it('honors the adaptive environment disable over inferred Core defaults', () => {
    vi.stubEnv('DKG_SYNC_ADAPTIVE_CAPACITY_ENABLED', '0');
    const runtime = SyncCapacityRuntime.create({ nodeRole: 'core' }, fakeStore(STORE_PRESSURE));
    expect(runtime.isAdaptive()).toBe(false);
  });
});
