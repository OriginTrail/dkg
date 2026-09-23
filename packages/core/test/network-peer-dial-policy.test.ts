import { describe, expect, it } from 'vitest';
import {
  NETWORK_MISMATCH_DIAL_DENY_TTL_MS,
  NETWORK_MISMATCH_INBOUND_REFUSAL_MS,
  NetworkPeerDialPolicy,
  peerIdFromRelayAddress,
} from '../src/network-peer-dial-policy.js';

// Real relay peer ids from the bundled network configs.
const TESTNET_RELAY_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const TESTNET_RELAY_B = '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge';
const BASE_RELAY = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const TESTNET_RELAY_A_ADDR = `/ip4/178.104.54.178/tcp/9090/p2p/${TESTNET_RELAY_A}`;
const BASE_RELAY_ADDR = `/ip4/178.104.98.10/tcp/9090/p2p/${BASE_RELAY}`;

const SELF = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const OTHER_PEER = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
const THIRD_PEER = '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';

const id = (value: string) => ({ toString: () => value });

function policy(overrides: ConstructorParameters<typeof NetworkPeerDialPolicy>[0] = {}) {
  return new NetworkPeerDialPolicy({
    selfPeerId: SELF,
    configuredRelayPeerIds: [BASE_RELAY],
    otherNetworkRelayPeerIds: [TESTNET_RELAY_A, TESTNET_RELAY_B],
    ...overrides,
  });
}

describe('peerIdFromRelayAddress', () => {
  it('returns the canonical terminal peer id of a relay multiaddr or bare id', () => {
    expect(peerIdFromRelayAddress(TESTNET_RELAY_A_ADDR)).toBe(TESTNET_RELAY_A);
    expect(peerIdFromRelayAddress(` ${TESTNET_RELAY_A} `)).toBe(TESTNET_RELAY_A);
    expect(peerIdFromRelayAddress(`${BASE_RELAY_ADDR}/p2p-circuit/p2p/${PEER}`)).toBe(PEER);
  });

  it('rejects placeholder, empty and peer-less addresses', () => {
    expect(peerIdFromRelayAddress('/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS')).toBeUndefined();
    expect(peerIdFromRelayAddress('/ip4/178.105.87.39/tcp/9090')).toBeUndefined();
    expect(peerIdFromRelayAddress('   ')).toBeUndefined();
  });
});

describe('NetworkPeerDialPolicy — other-network relays', () => {
  it('refuses dials, connections and stored addresses for another network\'s relay', () => {
    const gater = policy().connectionGater;

    expect(gater.denyDialPeer(id(TESTNET_RELAY_A))).toBe(true);
    expect(gater.denyDialMultiaddr(id(TESTNET_RELAY_A_ADDR))).toBe(true);
    expect(gater.denyOutboundEncryptedConnection(id(TESTNET_RELAY_A))).toBe(true);
    // Inbound too: circuit-relay discovery would reuse an inbound connection
    // from a foreign relay as a reservation candidate.
    expect(gater.denyInboundEncryptedConnection(id(TESTNET_RELAY_A))).toBe(true);
    expect(gater.filterMultiaddrForPeer(id(TESTNET_RELAY_A), id('/ip4/178.104.54.178/tcp/9090'))).toBe(false);
  });

  it('allows unknown peers and the node\'s own configured relays', () => {
    const gater = policy().connectionGater;

    for (const peer of [PEER, BASE_RELAY]) {
      expect(gater.denyDialPeer(id(peer))).toBe(false);
      expect(gater.denyOutboundEncryptedConnection(id(peer))).toBe(false);
      expect(gater.denyInboundEncryptedConnection(id(peer))).toBe(false);
      expect(gater.filterMultiaddrForPeer(id(peer), id('/ip4/1.2.3.4/tcp/9090'))).toBe(true);
    }
    expect(gater.denyDialMultiaddr(id(BASE_RELAY_ADDR))).toBe(false);
    expect(gater.denyDialMultiaddr(id('/ip4/1.2.3.4/tcp/9090'))).toBe(false);
  });

  it('never denies a configured relay that another network config also lists', () => {
    const shared = policy({
      configuredRelayPeerIds: [BASE_RELAY, TESTNET_RELAY_A],
    });

    expect(shared.otherNetworkRelayCount).toBe(1);
    expect(shared.dialDenialReason(TESTNET_RELAY_A)).toBeUndefined();
    expect(shared.connectionGater.denyDialPeer(id(TESTNET_RELAY_A))).toBe(false);
    expect(shared.connectionGater.denyInboundEncryptedConnection(id(TESTNET_RELAY_A))).toBe(false);
    expect(shared.dialDenialReason(TESTNET_RELAY_B)).toBe('other-network-relay');
  });

  it('ignores unparseable other-network ids such as pre-deployment placeholders', () => {
    const placeholders = policy({ otherNetworkRelayPeerIds: ['PEER_ID_SOLARIS', '', TESTNET_RELAY_A] });

    expect(placeholders.otherNetworkRelayCount).toBe(1);
    expect(placeholders.dialDenialReason(TESTNET_RELAY_A)).toBe('other-network-relay');
  });
});

describe('NetworkPeerDialPolicy — circuit paths', () => {
  it('denies a circuit through a foreign relay before the relay hop is dialed', () => {
    const gater = policy().connectionGater;

    // Target-bearing dial address and the target-less form isDialable() probes.
    expect(gater.denyDialMultiaddr(id(`${TESTNET_RELAY_A_ADDR}/p2p-circuit/p2p/${PEER}`))).toBe(true);
    expect(gater.denyDialMultiaddr(id(`${TESTNET_RELAY_A_ADDR}/p2p-circuit`))).toBe(true);
  });

  it('denies a circuit through a configured relay only when its target is foreign', () => {
    const gater = policy().connectionGater;

    expect(gater.denyDialMultiaddr(id(`${BASE_RELAY_ADDR}/p2p-circuit/p2p/${PEER}`))).toBe(false);
    expect(gater.denyDialMultiaddr(id(`${BASE_RELAY_ADDR}/p2p-circuit/p2p/${TESTNET_RELAY_B}`))).toBe(true);
  });

  it('keeps circuits through foreign relays out of the peer store and nothing else', () => {
    // Used unbound: libp2p hands this hook to the peer store as a bare function.
    const { filterMultiaddrForPeer } = policy().connectionGater;

    expect(filterMultiaddrForPeer(id(PEER), id(`${TESTNET_RELAY_A_ADDR}/p2p-circuit`))).toBe(false);
    expect(filterMultiaddrForPeer(id(PEER), id(`${BASE_RELAY_ADDR}/p2p-circuit`))).toBe(true);
    // A same-network operator relay we are not configured with stays storable;
    // the relay-path gate alone decides whether it may be dialed.
    expect(filterMultiaddrForPeer(
      id(PEER),
      id(`/ip4/5.6.7.8/tcp/9090/p2p/${OTHER_PEER}/p2p-circuit`),
    )).toBe(true);
    expect(filterMultiaddrForPeer(id(PEER), id('/ip4/1.2.3.4/tcp/9090'))).toBe(true);
    // The node's own record is never filtered.
    expect(filterMultiaddrForPeer(id(SELF), id(`${TESTNET_RELAY_A_ADDR}/p2p-circuit`))).toBe(true);
  });
});

describe('NetworkPeerDialPolicy — deny after identity mismatch', () => {
  it('refuses outbound for the TTL and inbound only for the quarantine window', () => {
    let now = 1_000;
    const mismatch = policy({ now: () => now, mismatchDenyTtlMs: 60_000, mismatchInboundRefusalMs: 10_000 });
    const gater = mismatch.connectionGater;

    expect(mismatch.denyAfterNetworkMismatch(PEER)).toBe(true);
    expect(mismatch.dialDenialReason(PEER)).toBe('network-identity-mismatch');
    expect(gater.denyDialPeer(id(PEER))).toBe(true);
    expect(gater.denyDialMultiaddr(id(`/ip4/1.2.3.4/tcp/9090/p2p/${PEER}`))).toBe(true);
    expect(gater.denyOutboundEncryptedConnection(id(PEER))).toBe(true);
    expect(gater.filterMultiaddrForPeer(id(PEER), id('/ip4/1.2.3.4/tcp/9090'))).toBe(false);
    // Admission cannot re-verify a quarantined peer, so an inbound connection
    // would only sit open (or be reused by relay discovery as a reservation).
    expect(gater.denyInboundEncryptedConnection(id(PEER))).toBe(true);

    now += 10_000;
    // Quarantine over: a peer whose operator fixed its network config can dial
    // in and re-run the identity proof, while we still do not dial it.
    expect(gater.denyInboundEncryptedConnection(id(PEER))).toBe(false);
    expect(gater.denyDialPeer(id(PEER))).toBe(true);

    now += 49_999;
    expect(gater.denyDialPeer(id(PEER))).toBe(true);
    now += 1;
    expect(gater.denyDialPeer(id(PEER))).toBe(false);
    expect(mismatch.dialDenialReason(PEER)).toBeUndefined();
  });

  it('defaults the inbound refusal to the admission quarantine and caps it at the TTL', () => {
    let now = 0;
    const defaults = policy({ now: () => now });
    defaults.denyAfterNetworkMismatch(PEER);
    now = NETWORK_MISMATCH_INBOUND_REFUSAL_MS - 1;
    expect(defaults.connectionGater.denyInboundEncryptedConnection(id(PEER))).toBe(true);
    now = NETWORK_MISMATCH_INBOUND_REFUSAL_MS;
    expect(defaults.connectionGater.denyInboundEncryptedConnection(id(PEER))).toBe(false);
    expect(defaults.connectionGater.denyDialPeer(id(PEER))).toBe(true);

    now = 0;
    const shortTtl = policy({ now: () => now, mismatchDenyTtlMs: 1_000 });
    shortTtl.denyAfterNetworkMismatch(PEER);
    now = 999;
    expect(shortTtl.connectionGater.denyInboundEncryptedConnection(id(PEER))).toBe(true);
    now = 1_000;
    expect(shortTtl.connectionGater.denyInboundEncryptedConnection(id(PEER))).toBe(false);
  });

  it('refreshes the TTL on a repeated rejection', () => {
    let now = 0;
    const mismatch = policy({ now: () => now, mismatchDenyTtlMs: 1_000 });

    mismatch.denyAfterNetworkMismatch(PEER);
    now = 900;
    mismatch.denyAfterNetworkMismatch(PEER);
    now = 1_500;
    expect(mismatch.dialDenialReason(PEER)).toBe('network-identity-mismatch');
  });

  it('lifts the denial once the peer passes the identity proof', () => {
    const mismatch = policy();

    mismatch.denyAfterNetworkMismatch(PEER);
    mismatch.clearNetworkMismatchDenial(PEER);
    expect(mismatch.connectionGater.denyDialPeer(id(PEER))).toBe(false);
  });

  it('never records the node itself, a configured relay or an unparseable id', () => {
    const mismatch = policy();

    expect(mismatch.denyAfterNetworkMismatch(SELF)).toBe(false);
    expect(mismatch.denyAfterNetworkMismatch(BASE_RELAY)).toBe(false);
    expect(mismatch.denyAfterNetworkMismatch('not-a-peer-id')).toBe(false);
    expect(mismatch.connectionGater.denyDialPeer(id(BASE_RELAY))).toBe(false);
  });

  it('bounds the remembered set by evicting the oldest rejection', () => {
    const mismatch = policy({ maxMismatchDeniedPeers: 2 });

    mismatch.denyAfterNetworkMismatch(PEER);
    mismatch.denyAfterNetworkMismatch(OTHER_PEER);
    mismatch.denyAfterNetworkMismatch(THIRD_PEER);

    expect(mismatch.dialDenialReason(PEER)).toBeUndefined();
    expect(mismatch.dialDenialReason(OTHER_PEER)).toBe('network-identity-mismatch');
    expect(mismatch.dialDenialReason(THIRD_PEER)).toBe('network-identity-mismatch');
  });

  it('aligns its windows with the 5-minute admission quarantine by default', () => {
    // A shorter dial window reopens dials while admission still short-circuits
    // the peer as rejected, which leaves the redialed socket open.
    expect(NETWORK_MISMATCH_DIAL_DENY_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(NETWORK_MISMATCH_INBOUND_REFUSAL_MS).toBe(5 * 60_000);
  });
});

describe('NetworkPeerDialPolicy — denial logging', () => {
  it('logs at most once per direction and peer per interval', () => {
    let now = 0;
    const logs: string[] = [];
    const gater = policy({ now: () => now, log: (message) => logs.push(message) }).connectionGater;

    gater.denyDialPeer(id(TESTNET_RELAY_A));
    gater.denyDialPeer(id(TESTNET_RELAY_A));
    gater.denyOutboundEncryptedConnection(id(TESTNET_RELAY_A));
    gater.denyInboundEncryptedConnection(id(TESTNET_RELAY_A));
    expect(logs).toEqual([
      'Network isolation: refusing outbound connection peer=Gq6hB57M reason=other-network-relay',
      'Network isolation: refusing inbound connection peer=Gq6hB57M reason=other-network-relay',
    ]);

    now += 10 * 60_000;
    gater.denyDialPeer(id(TESTNET_RELAY_A));
    expect(logs[2]).toBe(
      'Network isolation: refusing outbound connection peer=Gq6hB57M reason=other-network-relay suppressedSinceLast=2',
    );
  });

  it('does not log address filtering', () => {
    const logs: string[] = [];
    const { filterMultiaddrForPeer } = policy({ log: (message) => logs.push(message) }).connectionGater;

    filterMultiaddrForPeer(id(TESTNET_RELAY_A), id('/ip4/178.104.54.178/tcp/9090'));
    expect(logs).toEqual([]);
  });
});
