import { describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler } from '@origintrail-official/dkg-storage';
import {
  Rfc64CatalogReplayRecoveryRuntimeV1,
  type Rfc64CatalogReplayRecoveryPortsV1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

function runtime(requestPeer: Rfc64CatalogReplayRecoveryPortsV1<string>['requestPeer']) {
  return new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
    requestPeer,
    whenReceiverIdleForContextGraph: async () => {},
    targetIdentity: (target) => target,
    parityFailed: async () => false,
  });
}

function full(
  owner: Rfc64CatalogReplayRecoveryRuntimeV1<string>,
  contextGraphId: string,
  count: number,
  signal?: AbortSignal,
) {
  return owner.request({
    kind: 'full-connected-peers',
    contextGraphId,
    policyDigest: 'current-policy',
    connectedPeerIds: Array.from({ length: count }, (_, i) => `peer-${i}`),
    ...(signal === undefined ? {} : { executionOwner: { signal } }),
  });
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('catalog replay store pressure', () => {
  it('bounds graph-by-peer authorization fanout and leaves ordinary store headroom', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: 64,
      queueWaitTimeoutMs: 10_000,
    });
    let active = 0;
    let peak = 0;
    const proof = (source: string) => scheduler.run('normal', source, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    });
    const requestPeer = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        // These are the two concurrently entered local/remote authorization
        // proof families observed in the live queue, before the network dial.
        await Promise.all([
          proof('agent.contextGraph.confirmedMeta.privateDefinition'),
          proof('agent.contextGraph.registrationStatus'),
        ]);
        return { status: 'completed', targets: [] } as const;
      } finally {
        active -= 1;
      }
    });
    const owner = runtime(requestPeer);
    const passes = ['graph-a', 'graph-b'].map((id) => full(owner, id, 40));
    await turn();
    const discovery = proof('agent.contextGraphMetadataRelocation.candidates');
    void discovery.catch(() => {});
    const [a, b] = await Promise.all(passes);
    await discovery;
    expect(a).toEqual({ requested: 40, failed: 0 });
    expect(b).toEqual({ requested: 40, failed: 0 });
    expect(requestPeer).toHaveBeenCalledTimes(80);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(scheduler.getBackpressureSnapshot().totals.rejectedTotal).toBe(0);
    expect(scheduler.snapshot.normalQueued).toBe(0);
    expect(scheduler.snapshot.normalInflight).toBe(0);
    expect(owner.status('graph-a', 'current-policy')).toMatchObject({ active: false, failed: false });
    expect(owner.status('graph-b', 'current-policy')).toMatchObject({ active: false, failed: false });
  });

  it('removes cancelled queued work without releasing active non-cooperative requests early', async () => {
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const owner = runtime(async (id) => {
      calls.push(id);
      if (id === 'abandoned') await gate.promise;
      return { status: 'completed', targets: [] } as const;
    });
    const stop = new AbortController();
    const abandoned = full(owner, 'abandoned', 6, stop.signal);
    const rejected = expect(abandoned).rejects.toThrow('caller left');
    let settled = false;
    void abandoned.then(() => { settled = true; }, () => { settled = true; });
    await turn();
    expect(calls).toHaveLength(4);
    const survivor = full(owner, 'survivor', 1);
    stop.abort(new Error('caller left'));
    await turn();
    expect(calls).toHaveLength(4);
    // Canary keeps completion custody until active transports physically drain.
    expect(settled).toBe(false);
    gate.resolve();
    await rejected;
    await expect(survivor).resolves.toEqual({ requested: 1, failed: 0 });
    expect(calls).toEqual(['abandoned', 'abandoned', 'abandoned', 'abandoned', 'survivor']);
  });

  it('does not dispatch retired queued generations or reset physical permit ownership', async () => {
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const owner = runtime(async (id) => {
      calls.push(id);
      if (id === 'active') await gate.promise;
      return { status: 'completed', targets: [] } as const;
    });
    const active = full(owner, 'active', 4);
    const retired = full(owner, 'retired', 1);
    await turn();
    expect(calls).toHaveLength(4);
    owner.clear('retired');
    owner.reset();
    const current = full(owner, 'current', 1);
    await turn();
    expect(calls).toHaveLength(4);
    gate.resolve();
    await Promise.all([active, retired, current]);
    expect(calls).toEqual(['active', 'active', 'active', 'active', 'current']);
    expect(owner.status('retired', 'current-policy')).toBeNull();
    expect(owner.status('current', 'current-policy')).toMatchObject({ active: false, failed: false });
  });

  it('puts a retry behind work already waiting for admission', async () => {
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const owner = runtime(async (id, peer) => {
      calls.push(`${id}/${peer}`);
      if (id === 'first' && peer === 'peer-0' && calls.length === 1) {
        await gate.promise;
        throw new Error('retryable transport failure');
      }
      if (id === 'first') await gate.promise;
      return { status: 'completed', targets: [] } as const;
    });
    const first = full(owner, 'first', 4);
    const next = full(owner, 'next', 1);
    await turn();
    expect(calls).toHaveLength(4);
    gate.resolve();
    await expect(first).resolves.toEqual({ requested: 4, failed: 0 });
    await expect(next).resolves.toEqual({ requested: 1, failed: 0 });
    expect(calls.indexOf('next/peer-0')).toBeLessThan(calls.lastIndexOf('first/peer-0'));
  });
});
