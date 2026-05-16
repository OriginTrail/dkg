import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

// Peer IDs are real-shape v4 UUIDs in the canonical libp2p format
// so `peerIdFromString` accepts them. These are NOT real keys —
// they're the same fixtures the `p2p-messenger` suite uses.
const SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_PEER = '12D3KooWLb1bH9NfMSjJDmsZxufmw5UFD8wajVKnvD5HfL3VbqGq';
const REMOTE_PEER = '12D3KooWGiQrwo1jXJsHaQK4kFYx3xVDp5tWHPEnpUUEUbygP4WL';

// `enrichPeerStoreFromInboundCircuit` only needs `this.node.libp2p`
// for the self-peer guard and the peerStore.merge call — build the
// minimum that satisfies both so we don't pull the full DKGAgent
// init path into the test.
function makeAgent(): {
  agent: DKGAgent;
  mergeMock: ReturnType<typeof vi.fn>;
} {
  const mergeMock = vi.fn(async () => undefined);
  const fakeLibp2p = {
    peerId: { toString: () => SELF_PEER },
    peerStore: { merge: mergeMock },
  };
  const fakeNode = { libp2p: fakeLibp2p };
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  // `node` is private but the test reaches in directly via Object.assign
  // — same pattern the `dkg-agent-diagnostics` suite (PR #533) uses.
  Object.assign(agent, { node: fakeNode });
  return { agent, mergeMock };
}

describe('DKGAgent.enrichPeerStoreFromInboundCircuit — reverse-path peerStore enrichment', () => {
  let agent: DKGAgent;
  let mergeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ agent, mergeMock } = makeAgent());
  });

  // Headline behaviour: when an inbound circuit-relay connection
  // opens, we echo the inbound circuit address back as an outbound
  // multiaddr for the remote peer and merge it into peerStore. This
  // is the May 2026 Window D fix: future `dialProtocol(remote, ...)`
  // calls now have an address to try instead of returning "no valid
  // addresses for peer".
  it('merges the reverse-path multiaddr for an inbound circuit-relay connection', async () => {
    const inboundAddr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit`;
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: { toString: () => inboundAddr },
      remotePeer: { toString: () => REMOTE_PEER },
    });
    expect(mergeMock).toHaveBeenCalledTimes(1);
    const [calledPid, opts] = mergeMock.mock.calls[0];
    expect(calledPid.toString()).toBe(REMOTE_PEER);
    expect(opts.multiaddrs).toHaveLength(1);
    expect(opts.multiaddrs[0].toString()).toBe(
      `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit/p2p/${REMOTE_PEER}`,
    );
  });

  // Defensive: some libp2p versions / transports surface the
  // inbound circuit remoteAddr WITH the trailing `/p2p/<self>`
  // segment (explicit-destination shape). The reverse-path build
  // must slice on the FIRST `/p2p-circuit` and rebuild from the
  // relay prefix, NOT just append — otherwise we'd produce a
  // double-circuit multiaddr like
  //   `/<R>/p2p-circuit/p2p/<self>/p2p/<remote>`
  // which is uninterpretable and would poison the peerStore.
  it('handles inbound circuit remoteAddr that already includes /p2p/<self>', async () => {
    const inboundAddr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF_PEER}`;
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: { toString: () => inboundAddr },
      remotePeer: { toString: () => REMOTE_PEER },
    });
    expect(mergeMock).toHaveBeenCalledTimes(1);
    const [, opts] = mergeMock.mock.calls[0];
    expect(opts.multiaddrs[0].toString()).toBe(
      `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit/p2p/${REMOTE_PEER}`,
    );
  });

  // Outbound connections — peerStore was ALREADY populated to make
  // the dial happen, so re-merging the same address is pointless.
  // More importantly: if we DID merge on outbound, we'd race the
  // libp2p stream-negotiation issue documented at
  // docs/archive/UPSTREAM_ISSUE_DRAFT.md (peerStore.merge during a
  // newStream call closes the connection mid-negotiation). Outbound
  // is the case where that race matters most.
  it('is a no-op for outbound connections (regardless of circuit-ness)', async () => {
    const outboundAddr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit`;
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'outbound',
      remoteAddr: { toString: () => outboundAddr },
      remotePeer: { toString: () => REMOTE_PEER },
    });
    expect(mergeMock).not.toHaveBeenCalled();
  });

  // Direct (non-circuit) inbound connections have nothing to enrich
  // — the dialer side already had the address it used to connect,
  // and our outbound dialer will get that same address via the
  // normal identify exchange. Re-merging would be redundant and
  // could pollute peerStore with addresses that don't make sense as
  // outbound dial targets (e.g. inbound TCP from a private IP).
  it('is a no-op for direct (non-circuit) inbound connections', async () => {
    const directAddr = `/ip4/192.168.1.10/tcp/45678/p2p/${REMOTE_PEER}`;
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: { toString: () => directAddr },
      remotePeer: { toString: () => REMOTE_PEER },
    });
    expect(mergeMock).not.toHaveBeenCalled();
  });

  // The libp2p loopback case — a node briefly self-dials during
  // bootstrap (mostly in tests, but also in some relay configs).
  // Merging our own peerId into our own peerStore is meaningless
  // and the guard is the same one the surrounding listener
  // (`connection:open`) already applies for the outbox flush.
  // Defensive coverage so a refactor of the listener can't strip
  // the guard from this code path independently.
  it('is a no-op when the remote peer is self (loopback bootstrap)', async () => {
    const inboundAddr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit`;
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: { toString: () => inboundAddr },
      remotePeer: { toString: () => SELF_PEER },
    });
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('is a no-op when remoteAddr is missing or empty', async () => {
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: undefined,
      remotePeer: { toString: () => REMOTE_PEER },
    });
    await agent.enrichPeerStoreFromInboundCircuit({
      direction: 'inbound',
      remoteAddr: { toString: () => '' },
      remotePeer: { toString: () => REMOTE_PEER },
    });
    expect(mergeMock).not.toHaveBeenCalled();
  });

  // Defensive: a peerStore.merge that throws (e.g. shutdown race,
  // libp2p internal shape mismatch) must propagate so the caller's
  // `.catch()` in the `connection:open` listener logs and moves on.
  // The connection:open listener wrapping the call already gates
  // against throws crossing the libp2p event boundary; here we only
  // assert the helper itself does NOT silently swallow.
  it('propagates peerStore.merge errors to the caller (listener does the swallow)', async () => {
    const failingAgent = makeAgent();
    failingAgent.mergeMock.mockRejectedValueOnce(new Error('peerStore is down'));
    const inboundAddr = `/ip4/1.2.3.4/tcp/4001/p2p/${RELAY_PEER}/p2p-circuit`;
    await expect(
      failingAgent.agent.enrichPeerStoreFromInboundCircuit({
        direction: 'inbound',
        remoteAddr: { toString: () => inboundAddr },
        remotePeer: { toString: () => REMOTE_PEER },
      }),
    ).rejects.toThrow('peerStore is down');
  });
});
