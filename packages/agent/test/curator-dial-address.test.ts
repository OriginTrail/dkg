import { describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { verifiedCuratorDialAddress } from '../src/curator-dial-address.js';

const PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const ADDRESS = `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_ID}`;

describe('verifiedCuratorDialAddress', () => {
  it('accepts a valid address bound to the expected curator peer', () => {
    expect(verifiedCuratorDialAddress(ADDRESS, PEER_ID)).toBe(ADDRESS);
  });

  it('rejects malformed, wrong-peer, and oversized hints', () => {
    expect(verifiedCuratorDialAddress('not a multiaddr', PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress(ADDRESS, 'another-peer')).toBeUndefined();
    const oversizedAddress = `/dns4/${'a'.repeat(450)}.example/tcp/9090/p2p/${PEER_ID}`;
    expect(oversizedAddress.length).toBeGreaterThan(512);
    expect(multiaddr(oversizedAddress).toString()).toBe(oversizedAddress);
    expect(verifiedCuratorDialAddress(oversizedAddress, PEER_ID)).toBeUndefined();
    expect(verifiedCuratorDialAddress(null, PEER_ID)).toBeUndefined();
  });
});
