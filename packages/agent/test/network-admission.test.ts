import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  NetworkAdmissionService,
  peerIdsFromMultiaddrs,
  targetPeerIdFromMultiaddr,
} from '../src/p2p/network-admission.js';
import { canonicalPeerIdString } from '../src/p2p/peer-id.js';

const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const VERIFIED_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const VERIFIED_PEER_ID_CID = peerIdFromString(VERIFIED_PEER_ID).toCID().toString();
const UNKNOWN_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

describe('NetworkAdmissionService', () => {
  it('allows all peers when no active network identity is configured', () => {
    const admission = new NetworkAdmissionService();

    expect(admission.isAcceptedPeer(canonicalPeerIdString(UNKNOWN_PEER_ID))).toBe(true);
    expect(admission.snapshot().enabled).toBe(false);
  });

  it('fails unknown peers closed when network identity is configured', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      selfPeerId: SELF_PEER_ID,
    });

    expect(admission.isAcceptedPeer(canonicalPeerIdString(SELF_PEER_ID))).toBe(true);
    expect(admission.isAcceptedPeer(canonicalPeerIdString(UNKNOWN_PEER_ID))).toBe(false);
    expect(admission.isRejectedPeer(canonicalPeerIdString(UNKNOWN_PEER_ID))).toBe(false);
  });

  it('promotes verified same-network peers and excludes quarantined peers', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
    });

    admission.markVerifiedSameNetwork(canonicalPeerIdString(VERIFIED_PEER_ID_CID));
    expect(admission.isAcceptedPeer(canonicalPeerIdString(VERIFIED_PEER_ID))).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()].sort()).toEqual([VERIFIED_PEER_ID]);

    admission.quarantinePeer(canonicalPeerIdString(VERIFIED_PEER_ID_CID));
    expect(admission.isAcceptedPeer(canonicalPeerIdString(VERIFIED_PEER_ID))).toBe(false);
    expect(admission.isRejectedPeer(canonicalPeerIdString(VERIFIED_PEER_ID))).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()]).toEqual([]);
  });

  it('extracts peer ids from configured relay and bootstrap multiaddrs', () => {
    expect([...peerIdsFromMultiaddrs([
      '/ip4/127.0.0.1/tcp/4001/p2p/relay-peer',
      '/dns4/bootstrap.example/tcp/4001/p2p/bootstrap-peer',
    ])].sort()).toEqual(['bootstrap-peer', 'relay-peer']);
  });

  it('separates relay seed peers from the explicit target peer in relayed multiaddrs', () => {
    const addr = '/ip4/127.0.0.1/tcp/4001/p2p/relay-peer/p2p-circuit/p2p/target-peer';

    expect([...peerIdsFromMultiaddrs([addr])]).toEqual(['relay-peer', 'target-peer']);
    expect(targetPeerIdFromMultiaddr(addr)).toBe('target-peer');
  });
});
