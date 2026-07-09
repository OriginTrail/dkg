import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  canonicalTargetPeerIdFromMultiaddr,
  peerIdsFromMultiaddrs,
  targetPeerIdFromMultiaddr,
} from '../src/p2p/multiaddr-peer-target.js';

const TARGET_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

describe('multiaddr peer targets', () => {
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

  it('keeps raw and canonical target peer ids together', () => {
    const cidPeerId = peerIdFromString(TARGET_PEER_ID).toCID().toString();
    const addr = `/ip4/127.0.0.1/tcp/4001/p2p/${cidPeerId}`;

    expect(canonicalTargetPeerIdFromMultiaddr(addr)).toEqual({
      multiaddress: addr,
      raw: cidPeerId,
      canonical: TARGET_PEER_ID,
    });
  });
});
