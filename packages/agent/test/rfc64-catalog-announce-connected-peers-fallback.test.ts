import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from '../src/rfc64/catalog-peers-v1.js';

// Realistic libp2p peer-id shapes so the wire snapshot validator accepts them.
const SELF = '12D3KooWNBE8KjvhrwgYHqXqoLiSk7cHz2KkhuAyhdHjwCibhzeA';
const PEER_A = '12D3KooWAUCFb3hwTLUu3bhMqAsqtF1YH1sTUaMuTXiyvC1z7k65';
const PEER_B = '12D3KooWM72VdeDJFRRhrm9LKLYPrDyQjomVtccJuV8WXYG7uBUU';

function agentWithConnectedPeers(peerIds: readonly string[]) {
  const announceCatalogHead = vi.fn(async (input: unknown) => input);
  const agent = Object.assign(Object.create(Rfc64CatalogMethods.prototype), {
    node: {
      libp2p: {
        peerId: { toString: () => SELF },
        getPeers: () => peerIds.map((id) => ({ toString: () => id })),
      },
    },
    requireRfc64PublicCatalogServiceV1: () => ({ announceCatalogHead }),
  });
  return { agent, announceCatalogHead };
}

/**
 * Author paths that publish the first heads of a fresh CG pass `peers: []`
 * (that CG's gossip mesh does not exist yet). Before the fix that announced to
 * nobody, so a replica connected before the CG was created never received the
 * head or the policy it carries, and — because both replay request versions
 * require the policy digest — could never pull it either.
 */
describe('RFC-64 catalog announcement peer fallback', () => {
  it('falls back to the currently connected peers when the requested set is empty', () => {
    const { agent } = agentWithConnectedPeers([PEER_B, SELF, PEER_A, PEER_A]);

    const peers = agent.resolveRfc64CatalogAnnouncementPeersV1([]);

    // Self is excluded, duplicates collapse, order is deterministic.
    expect(peers).toEqual([PEER_A, PEER_B]);
  });

  it('honours a non-empty explicit set unchanged (no widening)', () => {
    const { agent } = agentWithConnectedPeers([PEER_A, PEER_B]);

    expect(agent.resolveRfc64CatalogAnnouncementPeersV1([PEER_B])).toEqual([PEER_B]);
  });

  it('caps the fallback at the wire limit', () => {
    const many = Array.from({ length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 + 5 }, (_, i) =>
      `12D3KooW${String(i).padStart(44, 'a')}`);
    const { agent } = agentWithConnectedPeers(many);

    expect(agent.resolveRfc64CatalogAnnouncementPeersV1([]))
      .toHaveLength(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1);
  });

  it('returns the empty set when there is no libp2p node to consult', () => {
    const agent = Object.assign(Object.create(Rfc64CatalogMethods.prototype), {});

    expect(agent.resolveRfc64CatalogAnnouncementPeersV1([])).toEqual([]);
  });

  it('announceRfc64PublicCatalogHeadV1 delivers to the resolved fallback peers', async () => {
    const { agent, announceCatalogHead } = agentWithConnectedPeers([PEER_A, PEER_B]);
    const announcement = { kind: 'stub-announcement' } as never;

    await agent.announceRfc64PublicCatalogHeadV1({ announcement, peers: [] });

    expect(announceCatalogHead).toHaveBeenCalledOnce();
    expect(announceCatalogHead).toHaveBeenCalledWith({
      announcement,
      peers: [PEER_A, PEER_B],
    });
  });
});
