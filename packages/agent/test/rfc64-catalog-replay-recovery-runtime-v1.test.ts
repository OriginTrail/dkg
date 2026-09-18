import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from
  '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

interface Target {
  readonly id: string;
}

function run(
  runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>,
  policyDigest: string,
  fullReplay = false,
) {
  return fullReplay
    ? runtime.request({
      contextGraphId: 'public-cg',
      policyDigest,
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze([]),
    })
    : runtime.request({
      contextGraphId: 'public-cg',
      policyDigest,
      kind: 'pending-recovery',
    });
}

describe('RFC-64 catalog replay recovery runtime', () => {
  it('owns policy replacement leases, coalesced completion, and status projection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestPeer = vi.fn(async () => {
      await gate;
      return Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([]),
      });
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
    const oldLease = runtime.markPeerPending('public-cg', 'old-policy', 'peer-old');
    const newLease = runtime.markPeerPending('public-cg', 'new-policy', 'peer-new');
    oldLease?.release();

    const first = run(runtime, 'new-policy');
    const coalesced = run(runtime, 'new-policy');
    expect(coalesced).toBe(first);
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: true,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });

    release();
    await expect(first).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestPeer).toHaveBeenCalledOnce();
    expect(runtime.status('public-cg', 'old-policy')).toBeNull();
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });
    newLease?.release();
  });

  it('OR-merges a joining full replay and clears only its failure witness', async () => {
    let parityFails = true;
    let release!: () => void;
    let gate = Promise.resolve();
    const requestPeer = vi.fn(async () => {
      await gate;
      return Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target' }]),
      });
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => parityFails,
    });

    runtime.markPeerPending('public-cg', 'policy', 'peer-a');
    await expect(run(runtime, 'policy')).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(true);

    parityFails = false;
    runtime.markPeerPending('public-cg', 'policy', 'peer-b');
    await expect(run(runtime, 'policy')).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(true);

    gate = new Promise<void>((resolve) => { release = resolve; });
    runtime.markPeerPending('public-cg', 'policy', 'peer-c');
    const scoped = run(runtime, 'policy');
    const full = run(runtime, 'policy', true);
    expect(full).toBe(scoped);
    release();
    await expect(scoped).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(false);
  });

  it('parks each pass on ITS OWN context graph and reads parity only after that wait', async () => {
    const order: string[] = [];
    const releases = new Map<string, () => void>();
    const whenReceiverIdleForContextGraph = vi.fn((contextGraphId: string) => (
      new Promise<void>((resolve) => {
        order.push(`idle-wait:${contextGraphId}`);
        releases.set(contextGraphId, resolve);
      })
    ));
    const parityFailed = vi.fn(async (contextGraphId: string) => {
      order.push(`parity:${contextGraphId}`);
      return false;
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target' }]),
      }),
      whenReceiverIdleForContextGraph,
      targetIdentity: (target) => target.id,
      parityFailed,
    });
    const request = (contextGraphId: string) => {
      runtime.markPeerPending(contextGraphId, 'policy', 'peer-a');
      return runtime.request({ contextGraphId, policyDigest: 'policy', kind: 'pending-recovery' });
    };

    const busy = request('busy-cg');
    const converged = request('converged-cg');
    await vi.waitFor(() => { expect(releases.size).toBe(2); });
    // The id is the whole contract: a wait keyed by anything else reads idle
    // for a graph with admissions still pending, or parks on a stranger's work.
    expect(whenReceiverIdleForContextGraph.mock.calls).toEqual([['busy-cg'], ['converged-cg']]);
    expect(parityFailed).not.toHaveBeenCalled();

    // The converged graph's pass completes while the busy graph's stays parked.
    releases.get('converged-cg')!();
    await expect(converged).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('converged-cg', 'policy')?.active).toBe(false);
    expect(runtime.status('busy-cg', 'policy')?.active).toBe(true);
    expect(order).toEqual(['idle-wait:busy-cg', 'idle-wait:converged-cg', 'parity:converged-cg']);

    releases.get('busy-cg')!();
    await expect(busy).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('busy-cg', 'policy')?.active).toBe(false);
  });
});
