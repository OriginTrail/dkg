import { describe, expect, it } from 'vitest';
import {
  NetworkAdmissionService,
  peerIdsFromMultiaddrs,
} from '../src/p2p/network-admission.js';

describe('NetworkAdmissionService', () => {
  it('allows all peers when no active network identity is configured', () => {
    const admission = new NetworkAdmissionService();

    expect(admission.isPeerAccepted('peer-a', '/dkg/test', 'outbound')).toBe(true);
    expect(admission.snapshot().enabled).toBe(false);
  });

  it('fails unknown and configured seed peers closed when network identity is configured', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      selfPeerId: 'self-peer',
      trustedPeerIds: ['trusted-peer'],
    });

    expect(admission.isPeerAccepted('self-peer', '/dkg/test', 'outbound')).toBe(true);
    expect(admission.isPeerAccepted('trusted-peer', '/dkg/test', 'inbound')).toBe(false);
    expect(admission.isPeerAccepted('unknown-peer', '/dkg/test', 'gossip')).toBe(false);
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
    expect(admission.isPeerAccepted('trusted-peer', '/dkg/test', 'outbound')).toBe(false);
    expect(admission.isPeerAccepted('verified-peer', '/dkg/test', 'outbound')).toBe(false);
    expect([...admission.verifiedSameNetworkPeerIds()]).toEqual([]);
  });

  it('extracts peer ids from configured relay and bootstrap multiaddrs', () => {
    expect([...peerIdsFromMultiaddrs([
      '/ip4/127.0.0.1/tcp/4001/p2p/relay-peer',
      '/dns4/bootstrap.example/tcp/4001/p2p/bootstrap-peer',
    ])].sort()).toEqual(['bootstrap-peer', 'relay-peer']);
  });
});
