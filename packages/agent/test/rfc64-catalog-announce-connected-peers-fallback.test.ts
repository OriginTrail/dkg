import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { Rfc64CatalogUpsertMethods } from '../src/dkg-agent-rfc64-catalog-upsert.js';
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
 * The SWM projection lane's configured announcement set is empty for a fresh
 * public CG (no gossip mesh exists yet), so a replica connected before the CG
 * was created never received the head or the policy it carries, and -- because
 * both replay request versions require the policy digest -- could never pull it
 * either. The lane resolves its set through this helper; the generic announce
 * API deliberately does not.
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

  it('announceRfc64PublicCatalogHeadV1 keeps `peers: []` meaning "announce to nobody" (no widening)', async () => {
    // Internal author paths pass [] to defer announcing to their caller, and
    // replay-based tests/callers pass [] so a head reaches a replica ONLY via
    // replay. Widening here double-announced and broke that contract
    // (`keeps multi-author replay applying after one promised head lands`).
    const { agent, announceCatalogHead } = agentWithConnectedPeers([PEER_A, PEER_B]);
    const announcement = { kind: 'stub-announcement' } as never;

    await agent.announceRfc64PublicCatalogHeadV1({ announcement, peers: [] });

    expect(announceCatalogHead).toHaveBeenCalledOnce();
    expect(announceCatalogHead).toHaveBeenCalledWith({ announcement, peers: [] });
  });

  it('warns the author about every peer whose announce delivery failed', () => {
    const warn = vi.fn();
    const agent = Object.assign(Object.create(Rfc64CatalogUpsertMethods.prototype), {
      log: { warn },
    });
    const announcement = {
      catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
      contextGraphId: '0x1111111111111111111111111111111111111111/lane',
      catalogVersion: '7',
    };

    agent.warnRfc64CatalogAnnounceFailuresV1({
      announcement,
      announcedPeers: [PEER_A],
      failedPeers: [
        { peerId: PEER_B, error: 'stream reset by peer' },
        { peerId: SELF, error: 'dial timeout' },
      ],
    });

    expect(warn).toHaveBeenCalledOnce();
    const [, message] = warn.mock.calls[0]!;
    expect(message).toContain('RFC-64 catalog head announce failed for 2/3 peer(s)');
    expect(message).toContain(`head=${announcement.catalogHeadObjectDigest}`);
    expect(message).toContain(`cg=${announcement.contextGraphId}`);
    expect(message).toContain('version=7');
    expect(message).toContain(`peers=${PEER_B.slice(-8)},${SELF.slice(-8)}`);
    expect(message).toContain('error=stream reset by peer');
  });

  it('stays silent when every announce delivery was acknowledged', () => {
    const warn = vi.fn();
    const agent = Object.assign(Object.create(Rfc64CatalogUpsertMethods.prototype), {
      log: { warn },
    });

    agent.warnRfc64CatalogAnnounceFailuresV1({
      announcement: { catalogHeadObjectDigest: `0x${'aa'.repeat(32)}` },
      announcedPeers: [PEER_A, PEER_B],
      failedPeers: [],
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
