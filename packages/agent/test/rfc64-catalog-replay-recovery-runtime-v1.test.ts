import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from
  '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

interface Target {
  readonly id: string;
  readonly scope?: string;
  readonly version?: number;
}

/** Stands in for the agent's newest-version-per-scope promise pruning. */
function pruneSupersededTargets(targets: readonly Target[]): readonly Target[] {
  const newestByScope = new Map<string, number>();
  for (const target of targets) {
    const scope = target.scope ?? target.id;
    const version = target.version ?? 0;
    if ((newestByScope.get(scope) ?? -1) < version) newestByScope.set(scope, version);
  }
  return targets.filter(
    (target) => (target.version ?? 0) === newestByScope.get(target.scope ?? target.id),
  );
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
      whenReceiverIdle: async () => undefined,
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
      whenReceiverIdle: async () => undefined,
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

  it('keeps the promise of a peer a full pass never heard from', async () => {
    const targetsByPeer = new Map<string, readonly Target[]>([
      ['peer-a', [{ id: 'head-a' }]],
      ['peer-b', [{ id: 'head-b' }]],
    ]);
    let failingPeer: string | null = null;
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async (_contextGraphId, peerId) => {
        if (peerId === failingPeer) throw new Error('dial failed');
        return Object.freeze({
          status: 'completed' as const,
          targets: targetsByPeer.get(peerId) ?? [],
        });
      },
      whenReceiverIdle: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
    const fullPass = () => runtime.request({
      contextGraphId: 'public-cg',
      policyDigest: 'policy',
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze(['peer-a', 'peer-b']),
    });

    await expect(fullPass()).resolves.toEqual({ requested: 2, failed: 0 });
    expect(runtime.promisedTargets('public-cg', 'policy')).toEqual([
      { id: 'head-a' },
      { id: 'head-b' },
    ]);

    // The pass queued every connected peer, so it may clear a witness -- but
    // peer-b never answered, so its promised head was not re-heard and is not
    // evidence that peer-b retired it.
    failingPeer = 'peer-b';
    await expect(fullPass()).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.promisedTargets('public-cg', 'policy')).toEqual([
      { id: 'head-a' },
      { id: 'head-b' },
    ]);
  });

  it('prunes superseded promises instead of blocking a graph that advanced often', async () => {
    let promisedVersion = 1;
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{
          id: `scope-a@${promisedVersion}`,
          scope: 'scope-a',
          version: promisedVersion,
        }]),
      }),
      whenReceiverIdle: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
      pruneSupersededTargets,
    });

    // One live scope, advanced past the per-Context-Graph target bound. Each
    // scoped pass merges into the snapshot, so without pruning the superseded
    // versions accumulate and overflow it into `failed`.
    for (; promisedVersion <= 70; promisedVersion += 1) {
      runtime.markPeerPending('public-cg', 'policy', `peer-${promisedVersion}`);
      await expect(run(runtime, 'policy')).resolves.toEqual({ requested: 1, failed: 0 });
    }

    expect(runtime.promisedTargets('public-cg', 'policy')).toEqual([
      { id: 'scope-a@70', scope: 'scope-a', version: 70 },
    ]);
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(false);
  });
});
