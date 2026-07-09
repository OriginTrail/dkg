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
});
