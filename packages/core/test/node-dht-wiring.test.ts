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
});
