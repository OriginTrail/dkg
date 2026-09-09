import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from
  '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

interface Target {
  readonly id: string;
}

function run(
  runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>,
  policyDigest: string,
  requestPeer: (peerId: string) => Promise<Readonly<{
    status: 'completed';
    targets: readonly Target[];
  }>>,
) {
  return runtime.request({
    contextGraphId: 'public-cg',
    policyDigest,
    seedPeers: Object.freeze([]),
    fullReplay: false,
    requestPeer,
    whenReceiverIdle: async () => undefined,
    targetIdentity: (target) => target.id,
    parityFailed: async () => false,
  });
}

describe('RFC-64 catalog replay recovery runtime', () => {
  it('owns policy replacement leases, coalesced completion, and status projection', async () => {
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>();
    const oldLease = runtime.markPeerPending('public-cg', 'old-policy', 'peer-old');
    const newLease = runtime.markPeerPending('public-cg', 'new-policy', 'peer-new');
    oldLease?.release();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestPeer = vi.fn(async () => {
      await gate;
      return Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([]),
      });
    });
    const first = run(runtime, 'new-policy', requestPeer);
    const coalesced = run(runtime, 'new-policy', requestPeer);
    expect(coalesced).toBe(first);
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: true,
      failed: false,
    });

    release();
    await expect(first).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestPeer).toHaveBeenCalledOnce();
    expect(runtime.status('public-cg', 'old-policy')).toBeNull();
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: false,
      failed: false,
    });
    newLease?.release();
  });
});
