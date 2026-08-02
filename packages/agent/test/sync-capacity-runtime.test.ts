import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorePressureSnapshot, TripleStore } from '@origintrail-official/dkg-storage';
import { SyncCapacityRuntime } from '../src/sync/capacity-runtime.js';

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

afterEach(() => vi.unstubAllEnvs());

describe('sync capacity runtime resolution', () => {
  it('keeps Edge nodes on the exact static policy even if adaptive is requested', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'edge',
      syncGlobalMaxInflight: 4,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(false);
    expect(runtime.policy.limit).toBe(4);
    expect(runtime.getStatus()).toMatchObject({ mode: 'static', currentInflight: 4 });
  });

  it('defaults Core nodes without an explicit global limit to adaptive mode', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncCorePublicBatchSize: 7,
    }, fakeStore(STORE_PRESSURE), { parallelism: 16, now: () => 100 });

    expect(runtime.isAdaptive()).toBe(true);
    expect(runtime.policy.limit).toBe(3);
    expect(runtime.getStatus()).toMatchObject({
      mode: 'adaptive',
      currentInflight: 2,
      minInflight: 1,
      maxInflight: 3,
      currentCoverageBatch: 7,
      configuredCoverageBatch: 7,
    });
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
    expect(staticRuntime.policy.limit).toBe(6);
    expect(adaptiveRuntime.isAdaptive()).toBe(true);
    expect(adaptiveRuntime.policy.limit).toBe(6);
    expect(adaptiveRuntime.getStatus().maxInflight).toBe(3);
  });

  it('retains explicit zero as unbounded and disables adaptation', () => {
    const runtime = SyncCapacityRuntime.create({
      nodeRole: 'core',
      syncGlobalMaxInflight: 0,
      syncAdaptiveCapacity: { enabled: true },
    }, fakeStore(STORE_PRESSURE), { parallelism: 16 });

    expect(runtime.isAdaptive()).toBe(false);
    expect(runtime.policy.limit).toBeUndefined();
    expect(runtime.getStatus().currentInflight).toBeNull();
  });

  it('honors the adaptive environment disable over inferred Core defaults', () => {
    vi.stubEnv('DKG_SYNC_ADAPTIVE_CAPACITY_ENABLED', '0');
    const runtime = SyncCapacityRuntime.create({ nodeRole: 'core' }, fakeStore(STORE_PRESSURE));
    expect(runtime.isAdaptive()).toBe(false);
  });
});

