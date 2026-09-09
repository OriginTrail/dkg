import {
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphPolicyV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
} from '../src/rfc64/public-catalog-transport-v1.js';
import { unsignedOpenContextGraphPolicyEnvelopeV1 } from
  '../src/rfc64/open-catalog-policy-v1.js';
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
    vi.spyOn(service, 'whenReceiverIdle').mockImplementation(async () => {
      idleCalls += 1;
      if (idleCalls === 1) {
        edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
      }
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 2, failed: 0 });
    expect(requestReplay).toHaveBeenCalledTimes(2);
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
      { seedConnectedPeers: false },
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
      { seedConnectedPeers: false },
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
    vi.spyOn(service, 'whenReceiverIdle').mockImplementation(async () => {
      edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peer);
    });

    await expect(edge.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
      CONTEXT_GRAPH_ID,
    )).resolves.toEqual({ requested: 64, failed: 1 });
    expect(requestReplay).toHaveBeenCalledTimes(64);
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
        listAppliedCatalogHeadsV1: () => {
          parityReads += 1;
          if (parityReads === 1) {
            edge.markRfc64CatalogReplayPeerPendingV1(
              CONTEXT_GRAPH_ID,
              '12D3KooWReplayParityBoundaryPeer64',
            );
          }
          return [];
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
        listAppliedCatalogHeadsV1: () => {
          parityReads += 1;
          if (parityReads === 1) {
            edge.markRfc64CatalogReplayPeerPendingV1(CONTEXT_GRAPH_ID, peerB);
          }
          return [];
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

