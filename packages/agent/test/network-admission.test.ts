import { describe, expect, it } from 'vitest';
import {
  NetworkAdmissionService,
  peerIdsFromMultiaddrs,
  targetPeerIdFromMultiaddr,
} from '../src/p2p/network-admission.js';

describe('NetworkAdmissionService', () => {
  it('allows all peers when no active network identity is configured', () => {
    const admission = new NetworkAdmissionService();

    expect(admission.isAcceptedPeer('peer-a')).toBe(true);
    expect(admission.snapshot().enabled).toBe(false);
  });

  it('fails unknown and configured seed peers closed when network identity is configured', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      selfPeerId: 'self-peer',
      trustedPeerIds: ['trusted-peer'],
    });

    expect(admission.isAcceptedPeer('self-peer')).toBe(true);
    expect(admission.isAcceptedPeer('trusted-peer')).toBe(false);
    expect(admission.isAcceptedPeer('unknown-peer')).toBe(false);
  });

  it('promotes verified same-network peers and excludes quarantined peers', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      trustedPeerIds: ['trusted-peer'],
    });

    admission.markVerifiedSameNetwork('verified-peer');
    expect([...admission.verifiedSameNetworkPeerIds()].sort()).toEqual(['verified-peer']);

    admission.quarantinePeer('trusted-peer');
    admission.quarantinePeer('verified-peer');
    expect(admission.isAcceptedPeer('trusted-peer')).toBe(false);
    expect(admission.isAcceptedPeer('verified-peer')).toBe(false);
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
