/** GH-2741: extracted from sync-protocol-peer-id; keep the real peer-store boundary. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const SYNC_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
let node: DKGNode;
beforeAll(async () => {
  node = new DKGNode({ listenAddresses: [], enableMdns: false });
  await node.start();
  await node.libp2p.peerStore.merge(peerIdFromString(SYNC_PEER_ID), { protocols: [PROTOCOL_SYNC] });
});
afterAll(async () => { await node?.stop(); });

describe('Random Sampling proof-time exact repair on the real libp2p peer store', () => {
  it('fetches the challenged asset from a provider the peer store lists as sync-capable', async () => {
    // Successful setup must precede the behavioral assertion on both revisions.
    const recorded = await node.libp2p.peerStore.get(peerIdFromString(SYNC_PEER_ID));
    expect(recorded.protocols).toContain(PROTOCOL_SYNC);
    await expect(node.libp2p.peerStore.get({ toString: () => SYNC_PEER_ID } as never))
      .rejects.toThrow('Invalid PeerId');
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

    const observed = {
      fetchedFrom: syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId),
      outcome,
    };
    process.stdout.write('REGRESSION_RUNTIME GH-2741 ' + process.version + '\n');
    process.stdout.write('REGRESSION_OBSERVATION GH-2741 ' + JSON.stringify(observed) + '\n');
    expect(observed, 'GH-2741: capable peer repair fetch completes').toEqual({
      fetchedFrom: [SYNC_PEER_ID],
      outcome: {
        material: {
          // Protocol bytes for this fixed fixture, independent of the
          // production canonicalization helper used by the repair path.
          contents: [new TextEncoder().encode('<urn:historical> <urn:value> "proof" .')],
          privateRoots: [],
        },
      },
    });
  });
});

