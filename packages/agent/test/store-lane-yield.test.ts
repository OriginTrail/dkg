import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { StorePressureSnapshot } from '@origintrail-official/dkg-storage';
import { RecoveryMaterializationOwner, type RecoveryMaterializationPorts } from '../src/durable-recovery-materialization.js';
import type { DurableRecoveryAuthority } from '../src/durable-recovery-authority.js';
import * as materialization from '../src/sync/requester/graph-scoped-materialization.js';
import * as laneYield from '../src/sync/requester/store-lane-yield.js';
import { STORE_LANE_YIELD_MAX_MS, yieldStoreBackgroundLane } from '../src/sync/requester/store-lane-yield.js';

afterEach(() => vi.restoreAllMocks());

function lane(backgroundQueued: number, backgroundInflight = 0): StorePressureSnapshot {
  return {
    ackInflight: 0, normalInflight: 0, backgroundInflight,
    ackQueued: 0, normalQueued: 0, backgroundQueued,
    maxConcurrent: 4, ackReservedSlots: 1,
  };
}

/** A clock that only moves when the yield sleeps. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    sleeps,
  };
}

describe('yielding the store background lane between asset writes', () => {
  it('costs one event-loop turn when the lane is idle or unreported', async () => {
    const time = fakeTime();
    await yieldStoreBackgroundLane({ store: { getPressureSnapshot: () => lane(0) }, previousWriteMs: 5_000, ...time });
    await yieldStoreBackgroundLane({ store: {}, previousWriteMs: 5_000, ...time });
    expect(time.sleeps).toEqual([]);
  });

  it('waits while other work is queued or running, until the lane clears', async () => {
    const time = fakeTime();
    const snapshots = [lane(2), lane(1, 1), lane(0, 1), lane(0)];
    await yieldStoreBackgroundLane({
      store: { getPressureSnapshot: () => snapshots.shift() ?? lane(0) },
      previousWriteMs: 5_000,
      ...time,
    });
    expect(time.sleeps).toEqual([50, 50, 50]);
  });

  it('never waits longer than the previous write took, nor past its ceiling', async () => {
    const busy = { getPressureSnapshot: () => lane(1, 1) };
    const short = fakeTime();
    await yieldStoreBackgroundLane({ store: busy, previousWriteMs: 120, ...short });
    expect(short.sleeps).toEqual([50, 50, 20]);
    const long = fakeTime();
    await yieldStoreBackgroundLane({ store: busy, previousWriteMs: 60_000, ...long });
    expect(long.now()).toBe(STORE_LANE_YIELD_MAX_MS);
    const none = fakeTime();
    await yieldStoreBackgroundLane({ store: busy, previousWriteMs: -5, ...none });
    expect(none.sleeps).toEqual([]);
  });

  it('stops waiting when the operation is cancelled', async () => {
    const controller = new AbortController();
    const time = fakeTime();
    await yieldStoreBackgroundLane({
      store: { getPressureSnapshot: () => lane(1) },
      previousWriteMs: 5_000,
      signal: controller.signal,
      now: time.now,
      sleep: async (ms) => { await time.sleep(ms); controller.abort(); },
    });
    expect(time.sleeps).toEqual([50]);
  });

  it('waits with real timers when no clock is injected', async () => {
    let calls = 0;
    const started = Date.now();
    await yieldStoreBackgroundLane({
      store: { getPressureSnapshot: () => (calls++ < 1 ? lane(1) : lane(0)) },
      previousWriteMs: 1_000,
    });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('runs between the writes of one recovery operation, never before its first', async () => {
    const asset = { contextGraphId: 'graph', ual: 'asset' } as materialization.VerifiedGraphScopedAsset;
    const store = { getPressureSnapshot: () => lane(0) };
    const subscription = { onChainId: '1' };
    const ports = {
      store: () => store,
      isClosed: () => false,
      subscription: () => subscription,
      bindingGeneration: () => 0,
      isBindingGenerationCurrent: () => true,
      track: () => {},
      recordDrops: () => {},
      reconcile: async () => {},
    } as unknown as RecoveryMaterializationPorts;
    const authority = {
      coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
      authenticate: async () => ({ asset, onChainContextGraphId: '1' }),
    } as unknown as DurableRecoveryAuthority;
    const order: string[] = [];
    vi.spyOn(materialization, 'materializeVerifiedGraphScopedAsset').mockImplementation(async () => {
      order.push('write');
      return 'applied';
    });
    const yields = vi.spyOn(laneYield, 'yieldStoreBackgroundLane').mockImplementation(async () => {
      order.push('yield');
    });
    const scope = new RecoveryMaterializationOwner(ports).forOperation({
      ctx: createOperationContext('sync'), contextGraphId: 'graph', authority,
    });

    for (let index = 0; index < 3; index += 1) {
      await scope.storeGraphScopedAsset({ asset, authenticationDeadline: Date.now() + 2_000 });
    }

    expect(order).toEqual(['write', 'yield', 'write', 'yield', 'write']);
    expect(yields.mock.calls[0]![0]).toMatchObject({ store });
    expect(yields.mock.calls[0]![0].previousWriteMs).toBeGreaterThanOrEqual(0);
    // A new operation starts without a previous write to yield after.
    const next = new RecoveryMaterializationOwner(ports).forOperation({
      ctx: createOperationContext('sync'), contextGraphId: 'graph', authority,
    });
    await next.storeGraphScopedAsset({ asset, authenticationDeadline: Date.now() + 2_000 });
    expect(order.at(-2)).toBe('write');
    expect(order.at(-1)).toBe('write');
  });
});
