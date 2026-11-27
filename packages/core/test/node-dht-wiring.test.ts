import { afterEach, describe, expect, it, vi } from 'vitest';
import { dhtProtocolForNetwork } from '../src/constants.js';

const mocks = vi.hoisted(() => ({
  kadOptions: [] as any[],
  createLibp2p: vi.fn(async (options: any) => ({
    peerId: { toString: () => 'mock-peer' },
    peerStore: { merge: vi.fn() },
    services: options.services,
    getConnections: vi.fn(() => []),
    getMultiaddrs: vi.fn(() => []),
    getPeers: vi.fn(() => []),
    addEventListener: vi.fn(),
    stop: vi.fn(),
    dial: vi.fn(),
  })),
}));

vi.mock('@libp2p/kad-dht', () => ({
  kadDHT: vi.fn((options: any) => {
    mocks.kadOptions.push(options);
    return { mockService: 'dht' };
  }),
}));

vi.mock('libp2p', () => ({
  createLibp2p: mocks.createLibp2p,
}));

const ACTIVE_RELAY_PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const FOREIGN_RELAY_PEER = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
const REMOTE_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

describe('DKGNode DHT network identity wiring', () => {
  afterEach(() => {
    mocks.kadOptions.length = 0;
    mocks.createLibp2p.mockClear();
  });

  it('passes the network-scoped DHT protocol into kadDHT during start', async () => {
    const { DKGNode } = await import('../src/node.js');
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      networkIdentity: {
        networkId: 'shared-genesis',
        genesisId: 'base-testnet',
        chainId: 'base:84532',
      },
    });

    await node.start();

    expect(mocks.kadOptions).toHaveLength(1);
    expect(mocks.kadOptions[0]).toMatchObject({
      protocol: dhtProtocolForNetwork('shared-genesis', 'base:84532'),
    });

    await node.stop();
  });

  it('passes the active relay network gater into libp2p during start', async () => {
    const { DKGNode } = await import('../src/node.js');
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: false,
      relayPeers: [`/ip4/1.2.3.4/tcp/9090/p2p/${ACTIVE_RELAY_PEER}`],
      networkIdentity: {
        networkId: 'shared-genesis',
        genesisId: 'base-testnet',
        chainId: 'base:84532',
      },
    });

    await node.start();

    expect(mocks.createLibp2p).toHaveBeenCalledOnce();
    const options = mocks.createLibp2p.mock.calls[0][0];
    const denyDialMultiaddr = options.connectionGater?.denyDialMultiaddr;
    expect(denyDialMultiaddr).toEqual(expect.any(Function));
    expect(
      denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${ACTIVE_RELAY_PEER}/p2p-circuit/p2p/${REMOTE_PEER}`),
    ).toBe(false);
    expect(
      denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${FOREIGN_RELAY_PEER}/p2p-circuit/p2p/${REMOTE_PEER}`),
    ).toBe(true);

    await node.stop();
  });

  it('installs the other-network dial policy hooks alongside the relay gater', async () => {
    const { DKGNode } = await import('../src/node.js');
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [`/ip4/1.2.3.4/tcp/9090/p2p/${ACTIVE_RELAY_PEER}`],
      otherNetworkRelays: [
        `/ip4/5.6.7.8/tcp/9090/p2p/${FOREIGN_RELAY_PEER}`,
        // Another network lists our configured relay: it must stay dialable.
        `/ip4/1.2.3.4/tcp/9090/p2p/${ACTIVE_RELAY_PEER}`,
        '/ip4/9.9.9.9/tcp/9090/p2p/PEER_ID_SOLARIS',
      ],
      networkIdentity: { networkId: 'shared-genesis', genesisId: 'base-testnet' },
    });

    await node.start();

    const gater = mocks.createLibp2p.mock.calls[0][0].connectionGater;
    const peer = (id: string) => ({ toString: () => id });
    expect(gater.denyDialPeer(peer(FOREIGN_RELAY_PEER))).toBe(true);
    expect(gater.denyDialPeer(peer(ACTIVE_RELAY_PEER))).toBe(false);
    expect(gater.denyInboundEncryptedConnection(peer(FOREIGN_RELAY_PEER))).toBe(true);
    expect(gater.denyOutboundEncryptedConnection(peer(FOREIGN_RELAY_PEER))).toBe(true);
    // libp2p hands this hook to the peer store unbound.
    const { filterMultiaddrForPeer } = gater;
    expect(filterMultiaddrForPeer(peer(FOREIGN_RELAY_PEER), '/ip4/5.6.7.8/tcp/9090')).toBe(false);
    expect(filterMultiaddrForPeer(peer(REMOTE_PEER), '/ip4/5.6.7.9/tcp/9090')).toBe(true);

    // The agent's rejection hook reaches the same live gater.
    expect(gater.denyDialPeer(peer(REMOTE_PEER))).toBe(false);
    expect(node.denyPeerAfterNetworkMismatch(REMOTE_PEER, 300_000)).toBe(true);
    expect(gater.denyDialPeer(peer(REMOTE_PEER))).toBe(true);
    expect(gater.denyInboundEncryptedConnection(peer(REMOTE_PEER))).toBe(true);
    node.clearPeerNetworkMismatchDenial(REMOTE_PEER);
    expect(gater.denyDialPeer(peer(REMOTE_PEER))).toBe(false);
    expect(gater.denyInboundEncryptedConnection(peer(REMOTE_PEER))).toBe(false);
    // A configured relay that fails the proof is refused too (with a warning).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(node.denyPeerAfterNetworkMismatch(ACTIVE_RELAY_PEER, 300_000)).toBe(true);
      expect(gater.denyDialPeer(peer(ACTIVE_RELAY_PEER))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        `configured relay peer=${ACTIVE_RELAY_PEER.slice(-8)} failed the network identity proof`,
      ));
    } finally {
      warn.mockRestore();
    }

    await node.stop();
    expect(node.denyPeerAfterNetworkMismatch(REMOTE_PEER)).toBe(false);
  });

  it('keeps the pre-existing gater when the peer-isolation kill switch is off', async () => {
    const { DKGNode } = await import('../src/node.js');
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [`/ip4/1.2.3.4/tcp/9090/p2p/${ACTIVE_RELAY_PEER}`],
      otherNetworkRelays: [`/ip4/5.6.7.8/tcp/9090/p2p/${FOREIGN_RELAY_PEER}`],
      networkIdentity: { networkId: 'shared-genesis', genesisId: 'base-testnet' },
      networkPeerIsolation: false,
    });

    await node.start();

    const gater = mocks.createLibp2p.mock.calls[0][0].connectionGater;
    // Exactly the pre-#2740 hook set, nothing the isolation policy adds.
    expect(Object.keys(gater).sort()).toEqual(['denyDialMultiaddr', 'denyInboundRelayedConnection']);
    expect(gater.denyDialPeer).toBeUndefined();
    expect(gater.denyInboundEncryptedConnection).toBeUndefined();
    expect(gater.denyOutboundEncryptedConnection).toBeUndefined();
    expect(gater.filterMultiaddrForPeer).toBeUndefined();
    // Only the relay-path gate and the flap guard remain: a direct dial to the
    // other network's relay is left to admission, a circuit through it is not.
    expect(gater.denyDialMultiaddr(`/ip4/5.6.7.8/tcp/9090/p2p/${FOREIGN_RELAY_PEER}`)).toBe(false);
    expect(
      gater.denyDialMultiaddr(`/ip4/5.6.7.8/tcp/9090/p2p/${FOREIGN_RELAY_PEER}/p2p-circuit/p2p/${REMOTE_PEER}`),
    ).toBe(true);
    expect(node.denyPeerAfterNetworkMismatch(REMOTE_PEER)).toBe(false);

    await node.stop();
  });

  it('leaves the gater unchanged without a network identity', async () => {
    const { DKGNode } = await import('../src/node.js');
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      otherNetworkRelays: [`/ip4/5.6.7.8/tcp/9090/p2p/${FOREIGN_RELAY_PEER}`],
    });

    await node.start();

    const gater = mocks.createLibp2p.mock.calls[0][0].connectionGater;
    // Exactly the pre-#2740 hook set, nothing the isolation policy adds.
    expect(Object.keys(gater).sort()).toEqual(['denyDialMultiaddr', 'denyInboundRelayedConnection']);
    expect(gater.denyDialPeer).toBeUndefined();
    expect(gater.denyInboundEncryptedConnection).toBeUndefined();
    expect(gater.denyOutboundEncryptedConnection).toBeUndefined();
    expect(gater.filterMultiaddrForPeer).toBeUndefined();
    expect(node.denyPeerAfterNetworkMismatch(REMOTE_PEER)).toBe(false);

    await node.stop();
  });
});
