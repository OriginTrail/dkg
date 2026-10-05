import { describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { verifiedCuratorDialAddress } from '../src/curator-dial-address.js';

const PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const OTHER_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const ADDRESS = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_ID}`;
const CIRCUIT = `/ip4/127.0.0.1/tcp/9090/p2p/${OTHER_PEER_ID}/p2p-circuit/p2p/${PEER_ID}`;

describe('verifiedCuratorDialAddress', () => {
  it('accepts private direct and relay circuit addresses bound to the curator peer', () => {
    expect(verifiedCuratorDialAddress(ADDRESS, PEER_ID)).toBe(ADDRESS);
    expect(verifiedCuratorDialAddress(CIRCUIT, PEER_ID)).toBe(CIRCUIT);
  });

  it('rejects malformed, wrong-peer, and oversized hints', () => {
    expect(verifiedCuratorDialAddress('not a multiaddr', PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress(ADDRESS, 'another-peer')).toBeUndefined();
    expect(verifiedCuratorDialAddress(`/ip4/127.0.0.1/tcp/9090/p2p/${OTHER_PEER_ID}`, PEER_ID))
      .toBeUndefined();
    expect(verifiedCuratorDialAddress(CIRCUIT, OTHER_PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress('/ip4/127.0.0.1/tcp/9090', PEER_ID))
      .toBeUndefined();
    expect(verifiedCuratorDialAddress(`${ADDRESS}/ws`, PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress(`${CIRCUIT}/ws`, PEER_ID)).toBeUndefined();
    const oversizedAddress = `/dns4/${'a'.repeat(450)}.example/tcp/9090/p2p/${PEER_ID}`;
    expect(oversizedAddress.length).toBeGreaterThan(512);
    expect(multiaddr(oversizedAddress).toString()).toBe(oversizedAddress);
    expect(verifiedCuratorDialAddress(oversizedAddress, PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress(null, PEER_ID)).toBeUndefined();
  });
});
