import { describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import {
  requesterHasDirectLoopbackConnection,
  selectCuratorJoinDialAddress,
  verifiedCuratorDialAddress,
} from '../src/curator-dial-address.js';

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

describe('selectCuratorJoinDialAddress', () => {
  const lanAddress = `/ip4/192.168.1.20/tcp/9090/p2p/${PEER_ID}`;
  const publicAddress = `/ip4/178.104.54.178/tcp/9090/p2p/${PEER_ID}`;

  it('ranks public, LAN, and loopback listeners from one raw list', () => {
    const listeners = [ADDRESS, lanAddress, publicAddress];
    expect(selectCuratorJoinDialAddress(listeners, PEER_ID)).toBe(publicAddress);
    expect(selectCuratorJoinDialAddress(listeners, PEER_ID, { preferLoopback: true }))
      .toBe(ADDRESS);
    expect(selectCuratorJoinDialAddress([lanAddress, publicAddress], PEER_ID))
      .toBe(publicAddress);
  });

  it('prefers a verified LAN listener over an earlier loopback listener', () => {
    expect(selectCuratorJoinDialAddress([ADDRESS, lanAddress], PEER_ID)).toBe(lanAddress);
  });

  it('keeps loopback available for local deployments', () => {
    expect(selectCuratorJoinDialAddress([ADDRESS], PEER_ID)).toBe(ADDRESS);
  });

  it('selects loopback for the exact requester on a direct local connection', () => {
    const connections = [{
      remotePeer: { toString: () => OTHER_PEER_ID },
      remoteAddr: { toString: () => `/ip4/127.0.0.1/tcp/56789/p2p/${OTHER_PEER_ID}` },
    }];
    expect(requesterHasDirectLoopbackConnection(connections, OTHER_PEER_ID)).toBe(true);
    expect(selectCuratorJoinDialAddress([ADDRESS, lanAddress], PEER_ID, {
      preferLoopback: requesterHasDirectLoopbackConnection(connections, OTHER_PEER_ID),
    })).toBe(ADDRESS);
    expect(requesterHasDirectLoopbackConnection(connections, PEER_ID)).toBe(false);
    expect(selectCuratorJoinDialAddress([ADDRESS, lanAddress], PEER_ID, {
      preferLoopback: requesterHasDirectLoopbackConnection(connections, PEER_ID),
    })).toBe(lanAddress);
  });

  it('prefers the direct loopback listener over an earlier loopback relay circuit', () => {
    expect(selectCuratorJoinDialAddress([CIRCUIT, ADDRESS, lanAddress], PEER_ID, {
      preferLoopback: true,
    })).toBe(ADDRESS);
    expect(selectCuratorJoinDialAddress([CIRCUIT, lanAddress], PEER_ID, {
      preferLoopback: true,
    })).toBe(CIRCUIT);
  });

  it('does not treat LAN or relayed connections as a local direct route', () => {
    for (const remoteAddress of [
      `/ip4/192.168.1.30/tcp/56789/p2p/${OTHER_PEER_ID}`,
      `/ip4/127.0.0.1/tcp/56789/p2p/${OTHER_PEER_ID}/p2p-circuit`,
    ]) {
      expect(requesterHasDirectLoopbackConnection([{
        remotePeer: { toString: () => OTHER_PEER_ID },
        remoteAddr: { toString: () => remoteAddress },
      }], OTHER_PEER_ID)).toBe(false);
    }
  });

  it('ignores malformed, wrong-peer, and unspecified listeners', () => {
    expect(selectCuratorJoinDialAddress([
      'not a multiaddr',
      `/ip4/127.0.0.1/tcp/9090/p2p/${OTHER_PEER_ID}`,
      `/ip4/0.0.0.0/tcp/9090/p2p/${PEER_ID}`,
      lanAddress,
    ], PEER_ID)).toBe(lanAddress);
  });
});
