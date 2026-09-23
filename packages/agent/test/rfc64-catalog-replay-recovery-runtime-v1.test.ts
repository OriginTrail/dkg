import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { Rfc64BackgroundWorkDispatcherV1 } from
  '../src/rfc64/background-work-dispatcher-v1.js';
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
  it('cancels a held peer replay request when its background owner closes', async () => {
    const onError = vi.fn();
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
    const entered = Promise.withResolvers<AbortSignal>();
    const requestPeer = vi.fn(async (
      _contextGraphId: string,
      _peerId: string,
      signal?: AbortSignal,
    ) => {
      if (signal === undefined) throw new Error('replay request signal missing');
      entered.resolve(signal);
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
    runtime.markPeerPending('public-cg', 'policy', 'peer-held');
    dispatcher.scheduleKeyed('catalog-replay', async (signal) => {
      await runtime.request({
        contextGraphId: 'public-cg',
        policyDigest: 'policy',
        kind: 'pending-recovery',
        signal,
      });
    });

    const signal = await entered.promise;
    await expect(dispatcher.closeAndDrain()).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(requestPeer).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(runtime.status('public-cg', 'policy')).toMatchObject({
      active: false,
      failed: false,
    });
  });

  it('cancels a held receiver-idle barrier when its background owner closes', async () => {
    const onError = vi.fn();
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
    const entered = Promise.withResolvers<AbortSignal>();
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([]),
      }),
      whenReceiverIdleForContextGraph: async (_contextGraphId, signal) => {
        if (signal === undefined) throw new Error('receiver idle signal missing');
        entered.resolve(signal);
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
    runtime.markPeerPending('public-cg', 'policy', 'peer-ready');
    dispatcher.scheduleKeyed('catalog-replay', async (signal) => {
      await runtime.request({
        contextGraphId: 'public-cg',
        policyDigest: 'policy',
        kind: 'pending-recovery',
        signal,
      });
    });

    const signal = await entered.promise;
    await expect(dispatcher.closeAndDrain()).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(runtime.status('public-cg', 'policy')).toMatchObject({
      active: false,
      failed: false,
    });
  });

  it('keeps mixed provider failure in runtime health instead of dispatcher errors', async () => {
    const onError = vi.fn();
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
    const promote = vi.fn(async () => undefined);
    const replay = vi.fn(async () => Object.freeze({ requested: 1, failed: 1 }));
    const scheduleAcceptedRecovery = (
      Rfc64CatalogMethods.prototype as unknown as {
        scheduleRfc64AuthorityAcceptedCatalogRecoveryV1(
          contextGraphId: string,
          policyDigest: string,
        ): void;
      }
    ).scheduleRfc64AuthorityAcceptedCatalogRecoveryV1;
    scheduleAcceptedRecovery.call({
      rfc64BackgroundWorkDispatcherV1: dispatcher,
      promoteRfc64OwnerSignedSwmInventoriesV1: promote,
      requestRfc64CatalogHeadReplaysFromConnectedPeersV1: replay,
    }, 'public-cg', `0x${'11'.repeat(32)}`);

    await dispatcher.whenIdle();
    expect(promote).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    await dispatcher.closeAndDrain();
  });

  it('retries a transient authority promotion failure without another authority event', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
      const promote = vi.fn()
        .mockRejectedValueOnce(new Error('temporary inventory store failure'))
        .mockResolvedValue(undefined);
      const replay = vi.fn(async () => Object.freeze({ requested: 1, failed: 0 }));
      const scheduleAcceptedRecovery = (
        Rfc64CatalogMethods.prototype as unknown as {
          scheduleRfc64AuthorityAcceptedCatalogRecoveryV1(
            contextGraphId: string,
            policyDigest: string,
          ): void;
        }
      ).scheduleRfc64AuthorityAcceptedCatalogRecoveryV1;

      scheduleAcceptedRecovery.call({
        rfc64BackgroundWorkDispatcherV1: dispatcher,
        promoteRfc64OwnerSignedSwmInventoriesV1: promote,
        requestRfc64CatalogHeadReplaysFromConnectedPeersV1: replay,
      }, 'public-cg', `0x${'22'.repeat(32)}`);

      await vi.advanceTimersByTimeAsync(0);
      expect(promote).toHaveBeenCalledOnce();
      expect(replay).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(249);
      expect(promote).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await dispatcher.whenIdle();

      expect(promote).toHaveBeenCalledTimes(2);
      expect(replay).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      await dispatcher.closeAndDrain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending authority recovery retry when its background owner closes', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
      const attempted = Promise.withResolvers<void>();
      const promote = vi.fn(async () => {
        attempted.resolve();
        throw new Error('temporary inventory store failure');
      });
      const replay = vi.fn(async () => Object.freeze({ requested: 1, failed: 0 }));
      const scheduleAcceptedRecovery = (
        Rfc64CatalogMethods.prototype as unknown as {
          scheduleRfc64AuthorityAcceptedCatalogRecoveryV1(
            contextGraphId: string,
            policyDigest: string,
          ): void;
        }
      ).scheduleRfc64AuthorityAcceptedCatalogRecoveryV1;

      scheduleAcceptedRecovery.call({
        rfc64BackgroundWorkDispatcherV1: dispatcher,
        promoteRfc64OwnerSignedSwmInventoriesV1: promote,
        requestRfc64CatalogHeadReplaysFromConnectedPeersV1: replay,
      }, 'public-cg', `0x${'33'.repeat(32)}`);

      await attempted.promise;
      await expect(dispatcher.closeAndDrain()).resolves.toBeUndefined();

      expect(promote).toHaveBeenCalledOnce();
      expect(replay).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

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
      whenReceiverIdleForContextGraph: async () => undefined,
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
      whenReceiverIdleForContextGraph: async () => undefined,
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
