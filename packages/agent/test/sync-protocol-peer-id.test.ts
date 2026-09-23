/**
 * Sync-protocol readiness against the REAL libp2p peer store.
 *
 * `@libp2p/peer-store` answers only for a real `PeerId`; any other key is
 * rejected with `InvalidParametersError('Invalid PeerId')`. Random Sampling
 * proof-time exact repair, durable recovery's `isSyncCapable` gate and the CLI
 * catch-up fallback all call `waitForSyncProtocol` with a
 * `{ toString: () => peerId }` wrapper. `waitForPeerProtocol` swallowed the
 * rejection as "peer metadata not available yet", so those callers saw every
 * peer as not sync-capable, and RS repair skipped every provider without
 * fetching.
 *
 * These tests run on a started DKGNode so the store's own validation is in
 * the loop. A permissive peer-store double would hide exactly this bug.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode, PROTOCOL_SYNC, tripleContentV10 } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';

/** A valid Ed25519 peer ID that the node's peer store records as a sync server. */
const SYNC_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
/** A valid peer ID a caller has already proven sync-capable; not in the store. */
const PRE_PROVEN_PEER_ID = '12D3KooWLwPkoiastt27S2SRPtdx6t8KuFXwcbHovgCkAMfkJcXx';

type PeerStoreGet = (peer: unknown, options?: unknown) => Promise<{ protocols: string[] }>;

let node: DKGNode;

beforeAll(async () => {
  // Dial-only: the real libp2p peer store is under test, not a transport.
  node = new DKGNode({ listenAddresses: [], enableMdns: false });
  await node.start();
  await node.libp2p.peerStore.merge(peerIdFromString(SYNC_PEER_ID), {
    protocols: [PROTOCOL_SYNC],
  });
});

afterAll(async () => {
  await node?.stop();
});

/** Delegates to the node's real peer store and records what reaches it. */
function spyOnRealPeerStore(): { get: ReturnType<typeof vi.fn<PeerStoreGet>> } {
  const real = node.libp2p.peerStore;
  return {
    get: vi.fn<PeerStoreGet>((peer, options) => real.get(peer as never, options as never)),
  };
}

/** The production method on an agent whose peer store is the real one. */
function waitForSyncProtocol(
  peer: { toString(): string },
  peerStore: { get: PeerStoreGet } = node.libp2p.peerStore,
): Promise<boolean> {
  return LifecycleSyncMethods.prototype.waitForSyncProtocol.call(
    { node: { libp2p: { peerStore } } } as never,
    peer,
  );
}

describe('waitForSyncProtocol on the real libp2p peer store', () => {
  it('relies on a store that rejects anything but a real PeerId', async () => {
    await expect(
      node.libp2p.peerStore.get({ toString: () => SYNC_PEER_ID } as never),
    ).rejects.toThrow('Invalid PeerId');
    const recorded = await node.libp2p.peerStore.get(peerIdFromString(SYNC_PEER_ID));
    expect(recorded.protocols).toContain(PROTOCOL_SYNC);
  });

  it('finds the sync protocol for a string peer-ID wrapper', async () => {
    const peerStore = spyOnRealPeerStore();

    await expect(
      waitForSyncProtocol({ toString: () => SYNC_PEER_ID }, peerStore),
    ).resolves.toBe(true);
    expect(peerStore.get).toHaveBeenCalledTimes(1);
    expect(String(peerStore.get.mock.calls[0]?.[0])).toBe(SYNC_PEER_ID);
  });

  it('passes a real PeerId through unchanged', async () => {
    const peerStore = spyOnRealPeerStore();
    const peerId = peerIdFromString(SYNC_PEER_ID);

    await expect(waitForSyncProtocol(peerId, peerStore)).resolves.toBe(true);
    expect(peerStore.get).toHaveBeenCalledTimes(1);
    expect(peerStore.get.mock.calls[0]?.[0]).toBe(peerId);
  });

  it('returns false without throwing or querying the store for a string that is not a peer ID', async () => {
    const peerStore = spyOnRealPeerStore();

    for (const invalid of ['not-a-peer-id', '12D3KooWRegistryProofProvider', '']) {
      await expect(
        waitForSyncProtocol({ toString: () => invalid }, peerStore),
      ).resolves.toBe(false);
    }
    expect(peerStore.get).not.toHaveBeenCalled();
  });
});

describe('Random Sampling proof-time exact repair on the real libp2p peer store', () => {
  it('fetches the challenged asset from a provider the peer store lists as sync-capable', async () => {
    const expectedUal = 'did:dkg:base:8453/0x0000000000000000000000000000000000001234/7';
    const historicalQuad = {
      subject: 'urn:historical',
      predicate: 'urn:value',
      object: '"proof"',
      graph: 'urn:historical-graph',
    };
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async (_peerId: string) => ({
      disposition: 'found' as const,
      result: { insertedTriples: 0 },
      authenticatedAssets: [{
        asset: { ual: expectedUal, dataQuads: [historicalQuad] },
        privateRoots: [],
      }],
    }));
    const agentLike = {
      started: true,
      peerId: node.libp2p.peerId.toString(),
      chain: {
        chainId: 'base:8453',
        getDKGKnowledgeAssetsAddress: async () => '0x00000000000000000000000000000000000000aa',
      },
      node: { stopSignal: undefined, libp2p: node.libp2p },
      log: { info: () => undefined },
      resolveRandomSamplingLocalContextGraphId: async () => 'food-safety',
      resolveCuratorPeerIdsForCg: async () => ({ peerIds: [SYNC_PEER_ID] }),
      vmReconcileObservedCandidatePeerIds: () => [],
      preferredSyncPeers: new Map<string, string>(),
      selectCatchupPeerWindow: (peers: Array<{ toString(): string }>) => peers,
      ensurePeerAdmittedForRecovery: async () => true,
      ensurePeerConnected: async () => undefined,
      // The production readiness check, reading the node's real peer store.
      waitForSyncProtocol: LifecycleSyncMethods.prototype.waitForSyncProtocol,
      syncExactKnowledgeAssetsFromPeerDetailed,
    };

    const outcome = await LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset
      .call(agentLike as never, {
        kaId: (0x1234n << 96n) | 7n,
        cgId: 1n,
        expectedRoot: new Uint8Array(32).fill(0x11),
        expectedLeafCount: 1n,
      })
      .result
      .then(
        (material) => ({ material }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );

    expect({
      fetchedFrom: syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId),
      outcome,
    }).toEqual({
      fetchedFrom: [SYNC_PEER_ID],
      outcome: {
        material: {
          contents: [tripleContentV10(
            historicalQuad.subject,
            historicalQuad.predicate,
            historicalQuad.object,
          )],
          privateRoots: [],
        },
      },
    });
  });
});

describe('durable recovery on the real libp2p peer store', () => {
  it('lets the graph owner fail over to a live peer the store lists as sync-capable', async () => {
    const slicedPeerIds: string[] = [];
    const agentLike = {
      started: true,
      node: {
        stopSignal: undefined,
        libp2p: {
          peerStore: node.libp2p.peerStore,
          getConnections: () => [{ remotePeer: peerIdFromString(SYNC_PEER_ID) }],
        },
      },
      syncCheckpoints: new MemorySyncCheckpointStore(),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      networkAdmissionCoordinator: { ensureAdmitted: async () => true },
      resolvePreferredSyncPeerId: async () => undefined,
      ensurePeerConnected: async () => undefined,
      primeCatchupConnections: async () => undefined,
      ensurePeerAdmittedForRecovery: async () => true,
      isPrivateContextGraph: async () => false,
      selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
      // The production gate behind `isSyncCapable`, reading the real store.
      waitForSyncProtocol: LifecycleSyncMethods.prototype.waitForSyncProtocol,
      syncFromPeerDetailed: async (peerId: string) => {
        slicedPeerIds.push(peerId);
        return createIncompleteDurableSyncResult();
      },
    };

    // The sync-on-connect / CLI catch-up shape: one pre-proven candidate and
    // no restriction, so the owner may also rank every live connection.
    const recovery = await LifecycleSyncMethods.prototype.syncDurableRecoveryContextGraph
      .call(agentLike as never, 'durable-gate-graph', {
        candidatePeerIds: [PRE_PROVEN_PEER_ID],
        candidatesAreSyncCapable: true,
      });

    expect({ slicedPeerIds, outcome: recovery.outcome }).toEqual({
      slicedPeerIds: [PRE_PROVEN_PEER_ID, SYNC_PEER_ID],
      outcome: 'no-progress',
    });
  });
});
