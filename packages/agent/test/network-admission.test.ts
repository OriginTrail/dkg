import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const VERIFIED_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const VERIFIED_PEER_ID_CID = peerIdFromString(VERIFIED_PEER_ID).toCID().toString();
const UNKNOWN_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

describe('NetworkAdmissionService', () => {
  it('validates configured self peer ids', () => {
    expect(() => new NetworkAdmissionService({
      selfPeerId: 'fixture-self',
    })).toThrow();
  });

  it('accepts self and fails unknown peers closed', () => {
    const admission = new NetworkAdmissionService({
      selfPeerId: SELF_PEER_ID,
    });

    expect(admission.isAcceptedPeer(SELF_PEER_ID)).toBe(true);
    expect(admission.isAcceptedPeer(UNKNOWN_PEER_ID)).toBe(false);
    expect(admission.isRejectedPeer(UNKNOWN_PEER_ID)).toBe(false);
    expect(admission.isAcceptedPeer('not-a-peer-id')).toBe(false);
    expect(admission.isRejectedPeer('not-a-peer-id')).toBe(true);
  });

  it('promotes verified same-network peers and excludes quarantined peers', () => {
    const admission = new NetworkAdmissionService();

    admission.markVerifiedSameNetwork(VERIFIED_PEER_ID_CID);
    expect(admission.isAcceptedPeer(VERIFIED_PEER_ID)).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()].sort()).toEqual([VERIFIED_PEER_ID]);

    admission.quarantinePeer(VERIFIED_PEER_ID_CID);
    expect(admission.isAcceptedPeer(VERIFIED_PEER_ID)).toBe(false);
    expect(admission.isRejectedPeer(VERIFIED_PEER_ID)).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()]).toEqual([]);
  });

  it('throws on invalid peer ids for mutating admission operations', () => {
    const admission = new NetworkAdmissionService();

    expect(() => admission.markVerifiedSameNetwork('not-a-peer-id')).toThrow('Invalid peer id not-a-peer-id');
    expect(() => admission.quarantinePeer('not-a-peer-id')).toThrow('Invalid peer id not-a-peer-id');
  });
});
