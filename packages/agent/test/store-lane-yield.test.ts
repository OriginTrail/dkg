import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler } from '@origintrail-official/dkg-storage';
import { RecoveryMaterializationOwner, type RecoveryMaterializationPorts } from '../src/durable-recovery-materialization.js';
import type { DurableRecoveryAuthority } from '../src/durable-recovery-authority.js';
import * as materialization from '../src/sync/requester/graph-scoped-materialization.js';
import * as laneYield from '../src/sync/requester/store-lane-yield.js';
import { yieldStoreBackgroundLane } from '../src/sync/requester/store-lane-yield.js';

afterEach(() => vi.restoreAllMocks());

describe('yielding the store background lane between asset writes', () => {
  it('lets event-loop callbacks run before the next admission', async () => {
    let ran = false;
    setImmediate(() => { ran = true; });
    await yieldStoreBackgroundLane();
    expect(ran).toBe(true);
  });

  it('observes cancellation before and during the yield', async () => {
    const before = new AbortController();
    before.abort(new Error('before'));
    await expect(yieldStoreBackgroundLane({ signal: before.signal })).rejects.toThrow('before');
    const during = new AbortController();
    setImmediate(() => during.abort(new Error('during')));
    await expect(yieldStoreBackgroundLane({ signal: during.signal })).rejects.toThrow('during');
  });

  it('lets existing FIFO admission run queued work between recovery writes', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
      healthReservedSlots: 0, backgroundReservedSlots: 0 });
    const order: string[] = [];
    let release!: () => void;
    const first = scheduler.run('background', 'recovery.first', async () => {
      order.push('first'); await new Promise<void>(resolve => { release = resolve; });
    });
    const queued = scheduler.run('background', 'other.queued', async () => { order.push('queued'); });
    release();
    await first;
    await yieldStoreBackgroundLane();
    await scheduler.run('background', 'recovery.second', async () => { order.push('second'); });
    await queued;
    expect(order).toEqual(['first', 'queued', 'second']);
  });

  it('runs between the writes of one recovery operation, never before its first', async () => {
    const asset = { contextGraphId: 'graph', ual: 'asset' } as materialization.VerifiedGraphScopedAsset;
    const store = {};
    const subscription = { onChainId: '1' };
    const ports = {
      store: () => store,
      isClosed: () => false,
      subscription: () => subscription,
      bindingGeneration: () => 0,
      isBindingGenerationCurrent: () => true,
      track: () => {},
      recordDrops: () => {},
      logTiming: () => {},
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
    expect(yields.mock.calls[0]![0]).toEqual({ signal: undefined });
    // A new operation starts without a previous write to yield after.
    const next = new RecoveryMaterializationOwner(ports).forOperation({
      ctx: createOperationContext('sync'), contextGraphId: 'graph', authority,
    });
    await next.storeGraphScopedAsset({ asset, authenticationDeadline: Date.now() + 2_000 });
    expect(order.at(-2)).toBe('write');
    expect(order.at(-1)).toBe('write');
  });
});
