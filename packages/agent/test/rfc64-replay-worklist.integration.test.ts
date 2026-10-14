import {
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphPolicyV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
} from '../src/rfc64/public-catalog-transport-v1.js';
import { unsignedOpenContextGraphPolicyEnvelopeV1 } from
  '../src/rfc64/open-catalog-policy-v1.js';
import { createAppliedCatalogHeadsSnapshotV1 } from '../src/rfc64/inventory-v1/index.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
} from './_helpers/rfc64-rollout-agent-harness.js';

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 replay worklist lifecycle', () => {
  it('preserves an admission-owned fence when a connected-peer snapshot coalesces', async () => {
    const edge = await startAgent({
      name: 'replay-admission-fence-snapshot',
      activation: activation('catalog'),
    });
    const activePeer = '12D3KooWReplayAlreadyActivePeer';
    const pendingPeer = '12D3KooWReplayAdmissionPendingPeer';
    let connectedPeers = [activePeer];
    vi.spyOn(edge.node.libp2p, 'getPeers').mockImplementation(() => (
      connectedPeers.map((peerId) => ({ toString: () => peerId })) as never
    ));
    let releaseActive!: () => void;
    let enteredActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    const activeStarted = new Promise<void>((resolve) => { enteredActive = resolve; });
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockImplementation(async ({ remotePeerId }: { remotePeerId: string }) => {
        if (remotePeerId === activePeer) {
          enteredActive();
          await activeGate;
        }
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });
    let resolveAdmission!: (value: boolean) => void;
    const admission = new Promise<boolean>((resolve) => { resolveAdmission = resolve; });
    vi.spyOn(
      (edge as any).networkAdmissionCoordinator,
      'ensureAdmitted',
    ).mockImplementation(async () => admission);

    const replay = edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(CONTEXT_GRAPH_ID);
    await activeStarted;
    connectedPeers = [pendingPeer];
    edge.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
      detail: {
        remotePeer: { toString: () => pendingPeer },
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1' },
        direction: 'inbound',
        timeline: { open: Date.now() },
      },
    } as any));
    const coalesced = edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(CONTEXT_GRAPH_ID);

    resolveAdmission(false);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    releaseActive();

    await expect(Promise.all([replay, coalesced])).resolves.toEqual([
      { requested: 1, failed: 0 },
      { requested: 1, failed: 0 },
    ]);
    expect(requestReplay).toHaveBeenCalledOnce();
    expect(requestReplay).toHaveBeenCalledWith(expect.objectContaining({
      remotePeerId: activePeer,
    }));
  });

  it('replays a newer same-peer generation raised after its completion snapshot', async () => {
    const edge = await startAgent({
      name: 'replay-same-peer-new-generation',
      activation: activation('catalog'),
    });
    const peer = '12D3KooWReplayDuplicateReconnectPeer';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => peer },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));
    let idleCalls = 0;
    const whenIdle = vi.spyOn(service, 'whenReceiverIdleForContextGraph')
      .mockImplementation(async () => {
        idleCalls += 1;
        if (idleCalls === 1) {
          edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
        }
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 2, failed: 0 });
    expect(requestReplay).toHaveBeenCalledTimes(2);
    // The replay parks on ITS OWN graph: a wait keyed by any other string reads
    // idle at once, so the id is pinned through runtime -> adapter -> service.
    expect(whenIdle.mock.calls.map(([contextGraphId]) => contextGraphId))
      .toEqual([CONTEXT_GRAPH_ID, CONTEXT_GRAPH_ID]);
  });

  it('does not let an older same-peer fence release a newer replay demand', async () => {
    const edge = await startAgent({
      name: 'replay-stale-same-policy-lease',
      activation: activation('catalog'),
    });
    const peer = '12D3KooWReplayStaleSamePolicyLease';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));

    const older = edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
    const newer = edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    older!.release();

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestReplay).toHaveBeenCalledOnce();
    expect(requestReplay).toHaveBeenCalledWith(expect.objectContaining({ remotePeerId: peer }));
  });

  it('does not let an old-policy fence release a replacement-policy demand', async () => {
    const edge = await startAgent({
      name: 'replay-stale-policy-lease',
      activation: activation('catalog'),
    });
    const peer = '12D3KooWReplayStalePolicyLease';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));

    const older = edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
    expect(older).not.toBeNull();
    const accepted = service.acceptedPolicySnapshot(NETWORK_ID, CONTEXT_GRAPH_ID);
    if (accepted === null) throw new Error('test edge has no accepted RFC-64 policy');
    const replacementPolicy = Object.freeze({
      ...accepted.policy,
      version: '1',
      previousPolicyDigest: accepted.policyDigest,
    }) as ContextGraphPolicyV1;
    edge.acceptRfc64CatalogAccessSnapshotV1({
      policy: replacementPolicy,
      policyDigest: computeContextGraphPolicyObjectDigestV1(
        unsignedOpenContextGraphPolicyEnvelopeV1(replacementPolicy),
      ),
      roster: null,
    });
    const newer = edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
    expect(newer).not.toBeNull();
    older!.release();

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestReplay).toHaveBeenCalledOnce();
    expect(requestReplay).toHaveBeenCalledWith(expect.objectContaining({ remotePeerId: peer }));
  });

  it('fails closed after the bounded worklist is exhausted by same-peer reconnect churn', async () => {
    const edge = await startAgent({
      name: 'replay-duplicate-peer-churn-bound',
      activation: activation('catalog'),
    });
    const peer = '12D3KooWReplayContinuousReconnectPeer';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => peer },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockImplementation(async () => {
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });
    const whenIdle = vi.spyOn(service, 'whenReceiverIdleForContextGraph')
      .mockImplementation(async () => {
        edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 1 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
    expect(whenIdle).toHaveBeenCalledTimes(64);
    expect(new Set(whenIdle.mock.calls.map(([contextGraphId]) => contextGraphId)))
      .toEqual(new Set([CONTEXT_GRAPH_ID]));
    await expect(edge.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        phase: 'blocked',
        stableReason: 'catalog-replay-incomplete',
      }),
    );
  });

  it('fails closed at the 64-request boundary under distinct-peer churn', async () => {
    const edge = await startAgent({
      name: 'replay-distinct-peer-churn-bound',
      activation: activation('catalog'),
    });
    const peer = (index: number) => `12D3KooWReplayDistinctPeer${index}`;
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => peer(0) },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    let replayCalls = 0;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockImplementation(async () => {
        replayCalls += 1;
        edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer(replayCalls));
        return Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
          heads: Object.freeze([]),
        });
      });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 1 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
  });

  it('rejects a 65th queued peer before a bounded replay run starts', async () => {
    const edge = await startAgent({
      name: 'replay-prequeued-peer-overflow-bound',
      activation: activation('catalog'),
    });
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));
    for (let index = 0; index < 64; index += 1) {
      expect(edge.markRfc64CatalogReplayPeerPendingV1(
        CONTEXT_GRAPH_ID,
        `12D3KooWReplayPrequeuedPeer${index}`,
      )).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    }
    expect(edge.markRfc64CatalogReplayPeerPendingV1(
      CONTEXT_GRAPH_ID,
      '12D3KooWReplayPrequeuedPeerOverflow',
    )).toBeNull();

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 1 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
  });

  it('fails closed when a 65th peer arrives during the durable parity read', async () => {
    const edge = await startAgent({
      name: 'replay-post-parity-peer-overflow-bound',
      activation: activation('catalog'),
    });
    const peers = Array.from(
      { length: 64 },
      (_, index) => `12D3KooWReplayParityBoundaryPeer${index}`,
    );
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue(peers.map((peer) => ({
      toString: () => peer,
    })) as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));
    const persistence = (edge as any).rfc64PersistenceV1;
    let parityReads = 0;
    (edge as any).rfc64PersistenceV1 = Object.freeze({
      ...persistence,
      inventory: Object.freeze({
        ...persistence.inventory,
        readAppliedCatalogHeadsSnapshotV1: () => {
          parityReads += 1;
          if (parityReads === 1) {
            edge.markRfc64CatalogReplayPeerPendingV1(
              CONTEXT_GRAPH_ID,
              '12D3KooWReplayParityBoundaryPeer64',
            );
          }
          return createAppliedCatalogHeadsSnapshotV1([]);
        },
      }),
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 1 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
  });

  it('replays a new peer generation raised during the durable parity read', async () => {
    const edge = await startAgent({
      name: 'replay-post-parity-peer-fence',
      activation: activation('catalog'),
    });
    const peerA = '12D3KooWReplayParityPeerA';
    const peerB = '12D3KooWReplayParityPeerB';
    vi.spyOn(edge.node.libp2p, 'getPeers').mockReturnValue([
      { toString: () => peerA },
    ] as never);
    const service = (edge as any).rfc64PublicCatalogServiceV1;
    const requestReplay = vi.spyOn(service, 'requestCatalogHeadReplay')
      .mockResolvedValue(Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: Object.freeze([]),
      }));
    const persistence = (edge as any).rfc64PersistenceV1;
    let parityReads = 0;
    (edge as any).rfc64PersistenceV1 = Object.freeze({
      ...persistence,
      inventory: Object.freeze({
        ...persistence.inventory,
        readAppliedCatalogHeadsSnapshotV1: () => {
          parityReads += 1;
          if (parityReads === 1) {
            edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peerB);
          }
          return createAppliedCatalogHeadsSnapshotV1([]);
        },
      }),
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 2, failed: 0 });
    expect(requestReplay.mock.calls.map(([{ remotePeerId }]: [{ remotePeerId: string }]) => (
      remotePeerId
    ))).toEqual([peerA, peerB]);
  });
});


describe('staged full-pass completeness custody', () => {
  function failingParityRuntime() {
    let parityFails = true;
    const requestPeer = vi.fn(async () => ({ status: 'completed' as const, targets: [] }));
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({ requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: () => '', parityFailed: async () => parityFails,
    });
    const full = (peers: readonly string[]) => runtime.request({ kind: 'full-connected-peers',
      contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: peers });
    const demand = (value: { peerId: string; generation: number }) => runtime.request({
      kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: value });
    return { runtime, full, demand, requestPeer, repaired: () => { parityFails = false; } };
  }

  it('requires the replacement reservation generation to execute before clearing parity', async () => {
    const { runtime, full, demand, repaired } = failingParityRuntime();
    await expect(full(['peer'])).resolves.toEqual({ requested: 1, failed: 1 }); repaired();
    const older = runtime.reservePeer('cg', 'policy', 'peer')!;
    await expect(full(['peer'])).resolves.toEqual({ requested: 0, failed: 0 });
    const replacement = runtime.reservePeer('cg', 'policy', 'peer')!;
    older.admit();
    await expect(demand(older)).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('cg', 'policy')?.failed).toBe(true);
    older.release();
    replacement.admit();
    await expect(demand(replacement)).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('cg', 'policy')?.failed).toBe(false); replacement.release();
  });

  it('withholds earlier full-pass entitlement when a joined bounded fill is incomplete', async () => {
    let parityFails = true;
    let hold = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async () => {
        if (hold) { entered(); await gate; }
        return { status: 'completed', targets: [] };
      },
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: () => '', parityFailed: async () => parityFails,
    });
    const full = (peers: readonly string[]) => runtime.request({ kind: 'full-connected-peers',
      contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: peers });
    await full(['first']); parityFails = false; hold = true;
    const running = full(['first']); await started;
    const staged = Array.from({ length: 64 }, (_, index) => runtime.reservePeer('cg', 'policy', `staged-${index}`)!);
    try {
      expect(staged.every(Boolean)).toBe(true);
      const joined = full(['new']); release();
      await expect(Promise.all([running, joined])).resolves.toEqual([
        { requested: 1, failed: 0 }, { requested: 1, failed: 0 },
      ]);
      expect(runtime.status('cg', 'policy')?.failed).toBe(true);
    } finally { release(); for (const lease of staged) lease.release(); await running; }
    await full(['new']); expect(runtime.status('cg', 'policy')?.failed).toBe(false);
  });

  it('does not donate cancelled staged coverage to an unrelated scoped replay', async () => {
    const { runtime, full, demand, repaired } = failingParityRuntime();
    await full(['peer']); repaired();
    const cancelled = runtime.reservePeer('cg', 'policy', 'peer')!;
    await full(['peer']); cancelled.release();
    const unrelated = runtime.markPeerPending('cg', 'policy', 'other')!;
    await demand(unrelated);
    expect(runtime.status('cg', 'policy')?.failed).toBe(true); unrelated.release();
    await full(['other']); expect(runtime.status('cg', 'policy')?.failed).toBe(false);
  });

  it('cannot donate staged coverage across replacement of the policy owner', async () => {
    const { runtime, full, demand, repaired } = failingParityRuntime();
    const old = runtime.reservePeer('cg', 'old-policy', 'peer')!;
    await runtime.request({ kind: 'full-connected-peers', contextGraphId: 'cg',
      policyDigest: 'old-policy', connectedPeerIds: ['peer'] });
    await full(['other']); repaired(); old.admit(); old.release();
    const current = runtime.markPeerPending('cg', 'policy', 'other')!;
    await demand(current); expect(runtime.status('cg', 'policy')?.failed).toBe(true);
    current.release(); await full(['other']);
    expect(runtime.status('cg', 'policy')?.failed).toBe(false);
  });

  it('checks both settled provider promises when the last staged peer completes', async () => {
    let parityFails = true;
    const parity = vi.fn(async (_cg: string, _targets: readonly string[]) => parityFails);
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
      requestPeer: async (_cg, peer) => ({ status: 'completed', targets: peer === 'old' ? [] : [peer] }),
      whenReceiverIdleForContextGraph: async () => undefined, targetIdentity: target => target,
      parityFailed: parity,
    });
    const full = (peers: readonly string[]) => runtime.request({ kind: 'full-connected-peers',
      contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: peers });
    await full(['old']); parityFails = false;
    const a = runtime.reservePeer('cg', 'policy', 'a')!;
    const b = runtime.reservePeer('cg', 'policy', 'b')!;
    await expect(full(['a', 'b'])).resolves.toEqual({ requested: 0, failed: 0 });
    a.admit(); await runtime.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: a });
    expect(runtime.status('cg', 'policy')?.failed).toBe(true); a.release();
    b.admit(); await runtime.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: b });
    expect(parity).toHaveBeenLastCalledWith('cg', ['a', 'b']);
    expect(runtime.promisedTargets('cg', 'policy')).toEqual(['a', 'b']);
    expect(runtime.status('cg', 'policy')?.failed).toBe(false); b.release();
  });
});

describe('split full replay evidence across receiver waits', () => {
  it('prunes superseded heads before checking the 64-live-scope bound while retaining same-version forks', async () => {
    type Head = Readonly<{ id: string; scope: string; version: number }>;
    let version = 1;
    let fork = false;
    const parity = vi.fn(async (_cg: string, targets: readonly Head[]) => targets.some(target => target.id === 'fork'));
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Head>({
      requestPeer: async (_cg, peer) => ({ status: 'completed', targets: peer === 'old'
        ? Array.from({ length: 64 }, (_, index) => ({ id: `${index}-1`, scope: String(index), version: 1 }))
        : [...Array.from({ length: 32 }, (_, index) => {
          const scope = String(index + (peer === 'b' ? 32 : 0));
          return { id: `${scope}-${version}`, scope, version };
        }), ...(fork && peer === 'a' ? [{ id: 'fork', scope: '0', version }] : [])] }),
      whenReceiverIdleForContextGraph: async () => undefined, targetIdentity: target => target.id,
      pruneSupersededTargets: targets => {
        const latest = new Map<string, number>();
        for (const target of targets) latest.set(target.scope, Math.max(latest.get(target.scope) ?? 0, target.version));
        return targets.filter(target => target.version === latest.get(target.scope));
      }, parityFailed: parity,
    });
    const full = (peers: readonly string[]) => runtime.request({ kind: 'full-connected-peers', contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: peers });
    await full(['old']); version = 2;
    const a = runtime.reservePeer('cg', 'policy', 'a')!; const b = runtime.reservePeer('cg', 'policy', 'b')!;
    await full(['a', 'b']);
    for (const lease of [a, b]) {
      lease.admit(); await runtime.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: lease }); lease.release();
    }
    expect(runtime.status('cg', 'policy')?.failed).toBe(false);
    expect(runtime.promisedTargets('cg', 'policy')).toHaveLength(64);
    expect(runtime.promisedTargets('cg', 'policy')?.every(target => target.version === 2)).toBe(true);
    expect(parity.mock.calls.at(-1)?.[1]).toHaveLength(64);
    // A same-version competing digest is not superseded: it must still fail closed.
    fork = true;
    await full(['a', 'b']);
    expect(runtime.status('cg', 'policy')?.failed).toBe(true);
  });

  it('retains an earlier staged manifest after drain timeout so the final peer cannot clear an unchecked head', async () => {
    let timeout = false; let initialFailure = true; let newHeadApplied = false;
    const never = () => new Promise<void>(() => undefined);
    const parity = vi.fn(async (_cg: string, targets: readonly string[]) => initialFailure || (!newHeadApplied && targets.includes('new-head')));
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
      requestPeer: async (_cg, peer) => ({ status: 'completed', targets: peer === 'a' ? ['new-head'] : ['old-head'] }),
      whenReceiverIdleForContextGraph: () => timeout ? never() : Promise.resolve(),
      sleep: () => timeout ? Promise.resolve() : never(), targetIdentity: target => target, parityFailed: parity,
    });
    const full = () => runtime.request({ kind: 'full-connected-peers', contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: ['a', 'b'] });
    await runtime.request({ kind: 'full-connected-peers', contextGraphId: 'cg', policyDigest: 'policy', connectedPeerIds: ['old'] }); initialFailure = false;
    const a = runtime.reservePeer('cg', 'policy', 'a')!; const b = runtime.reservePeer('cg', 'policy', 'b')!;
    await full(); timeout = true;
    a.admit(); await runtime.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: a }); a.release();
    expect(runtime.status('cg', 'policy')).toMatchObject({ failed: true, unverified: true });
    timeout = false;
    b.admit(); await runtime.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand: b }); b.release();
    expect(parity.mock.calls.at(-1)?.[1]).toContain('new-head');
    expect(runtime.promisedTargets('cg', 'policy')).toContain('new-head');
    expect(runtime.status('cg', 'policy')?.failed).toBe(true);
    newHeadApplied = true; await full();
    expect(runtime.status('cg', 'policy')).toMatchObject({ failed: false, unverified: false });
  });
});

describe('cancelled receiver observation', () => {
  it('retains the promised head as unverified when the caller aborts during receiver drain', async () => {
    const entered = Promise.withResolvers<void>(); const controller = new AbortController();
    const cancelled = new Error('receiver observation cancelled');
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
      requestPeer: async () => ({ status: 'completed', targets: ['unobserved-head'] }),
      whenReceiverIdleForContextGraph: async (_cg, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      }, sleep: () => new Promise<void>(() => undefined), targetIdentity: target => target,
      parityFailed: async () => false,
    });
    const run = runtime.request({ kind: 'full-connected-peers', contextGraphId: 'cg', policyDigest: 'policy',
      connectedPeerIds: ['peer'], signal: controller.signal });
    await entered.promise; controller.abort(cancelled);
    await expect(run).rejects.toBe(cancelled);
    expect(runtime.promisedTargets('cg', 'policy')).toEqual(['unobserved-head']);
    expect(runtime.status('cg', 'policy')).toMatchObject({ failed: false, unverified: true });
  });
});
