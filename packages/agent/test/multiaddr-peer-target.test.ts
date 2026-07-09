import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  canonicalTargetPeerIdFromMultiaddr,
  parseMultiaddrConnectTarget,
  peerIdsFromMultiaddrs,
  targetPeerIdFromMultiaddr,
} from '../src/p2p/multiaddr-peer-target.js';

const TARGET_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const BOOTSTRAP_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

describe('multiaddr peer targets', () => {
  it('extracts peer ids from configured relay and bootstrap multiaddrs', () => {
    expect([...peerIdsFromMultiaddrs([
      `/ip4/127.0.0.1/tcp/4001/p2p/${RELAY_PEER_ID}`,
      `/dns4/bootstrap.example/tcp/4001/p2p/${BOOTSTRAP_PEER_ID}`,
    ])].sort()).toEqual([BOOTSTRAP_PEER_ID, RELAY_PEER_ID].sort());
  });

  it('separates relay seed peers from the explicit target peer in relayed multiaddrs', () => {
    const addr = `/ip4/127.0.0.1/tcp/4001/p2p/${RELAY_PEER_ID}/p2p-circuit/p2p/${TARGET_PEER_ID}`;

    expect([...peerIdsFromMultiaddrs([addr])]).toEqual([RELAY_PEER_ID, TARGET_PEER_ID]);
    expect(targetPeerIdFromMultiaddr(addr)).toBe(TARGET_PEER_ID);
  });

  it('keeps raw and canonical target peer ids together', () => {
    const cidPeerId = peerIdFromString(TARGET_PEER_ID).toCID().toString();
    const addr = `/ip4/127.0.0.1/tcp/4001/p2p/${cidPeerId}`;

    expect(canonicalTargetPeerIdFromMultiaddr(addr)).toEqual({
      raw: cidPeerId,
      canonical: TARGET_PEER_ID,
    });
    expect(parseMultiaddrConnectTarget(addr)).toEqual({
      kind: 'direct',
      multiaddress: addr,
      target: {
        raw: cidPeerId,
        canonical: TARGET_PEER_ID,
      },
    });
  });

  it('returns a closed circuit target shape with relay and required target peer', () => {
    const cidPeerId = peerIdFromString(TARGET_PEER_ID).toCID().toString();
    const relay = `/ip4/127.0.0.1/tcp/4001/p2p/${RELAY_PEER_ID}`;
    const addr = `${relay}/p2p-circuit/p2p/${cidPeerId}`;

    expect(parseMultiaddrConnectTarget(addr)).toEqual({
      kind: 'circuit',
      multiaddress: addr,
      relayMultiaddress: relay,
      target: {
        raw: cidPeerId,
        canonical: TARGET_PEER_ID,
      },
    });
  });

  it('requires a target peer for circuit multiaddrs', () => {
    expect(targetPeerIdFromMultiaddr(
      `/ip4/127.0.0.1/tcp/4001/p2p/${RELAY_PEER_ID}/p2p-circuit`,
    )).toBeUndefined();
    expect(() => parseMultiaddrConnectTarget(
      `/ip4/127.0.0.1/tcp/4001/p2p/${RELAY_PEER_ID}/p2p-circuit`,
    )).toThrow('Circuit multiaddr missing target peer id');
  });
});
