import { afterEach, describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode, announcePublicAddresses } from '../src/node.js';
import { isPublicOrCircuitAddress } from '../src/network/address-policy.js';

const RELAY_PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('isPublicOrCircuitAddress', () => {
  it.each([
    ['/ip4/198.51.100.20/tcp/4001', true],
    ['/ip6/2001:db8::1/tcp/4001', true],
    ['/dns4/relay.example.org/tcp/9090', true],
    [`/ip4/198.51.100.7/tcp/9090/p2p/${RELAY_PEER}/p2p-circuit`, true],
    // A circuit stays in whatever its relay is: the relay watchdog reads it.
    [`/ip4/127.0.0.1/tcp/9090/p2p/${RELAY_PEER}/p2p-circuit`, true],
    ['/ip4/127.0.0.1/tcp/4001', false],
    ['/ip4/10.0.0.4/tcp/4001', false],
    ['/ip4/172.17.0.1/tcp/4001', false],
    ['/ip4/192.168.1.20/tcp/4001', false],
    ['/ip4/100.64.0.9/tcp/4001', false],
    ['/ip4/169.254.3.4/tcp/4001', false],
    ['/ip6/::1/tcp/4001', false],
    ['/ip6/fe80::1/tcp/4001', false],
    ['/ip6/fd00::5/tcp/4001', false],
    ['/ip4/0.0.0.0/tcp/4001', false],
  ])('%s -> %s', (address, expected) => {
    expect(isPublicOrCircuitAddress(address)).toBe(expected);
  });

  it('is the filter libp2p gets, keeping the order of what it passes', () => {
    const addresses = ['/ip4/10.0.0.4/tcp/4001', '/ip4/198.51.100.20/tcp/4001', `/ip4/198.51.100.7/tcp/9090/p2p/${RELAY_PEER}/p2p-circuit`]
      .map((address) => multiaddr(address));
    expect(announcePublicAddresses(addresses).map(String)).toEqual([
      '/ip4/198.51.100.20/tcp/4001',
      `/ip4/198.51.100.7/tcp/9090/p2p/${RELAY_PEER}/p2p-circuit`,
    ]);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('announcePublicAddressesOnly on a node behind a relay', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.stop().catch(() => undefined);
  });

  async function started(config: ConstructorParameters<typeof DKGNode>[0]): Promise<DKGNode> {
    const node = new DKGNode({ enableMdns: false, ...config });
    nodes.push(node);
    await node.start();
    return node;
  }

  async function relayAddress(): Promise<string> {
    const relay = await started({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableRelayServer: true });
    return relay.multiaddrs.find((address) => address.includes('/tcp/'))!;
  }

  it('announces its circuit and no interface address, in multiaddrs and in identify', async () => {
    const relay = await relayAddress();
    const edge = await started({
      listenAddresses: ['/ip4/0.0.0.0/tcp/0'], relayPeers: [relay], announcePublicAddressesOnly: true,
    });
    await waitFor(() => edge.multiaddrs.some((address) => address.includes('/p2p-circuit')));
    expect(edge.multiaddrs.filter((address) => !address.includes('/p2p-circuit'))).toEqual([]);

    // A peer that reaches the edge through the relay learns the circuit only.
    const peer = await started({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'] });
    await peer.libp2p.dial(multiaddr(edge.multiaddrs.find((address) => address.includes('/p2p-circuit'))!));
    const edgeId = peerIdFromString(edge.peerId);
    const identified = async () => ((await peer.libp2p.peerStore.get(edgeId).catch(() => undefined))?.protocols.length ?? 0) > 0;
    await waitFor(identified);
    const learned = (await peer.libp2p.peerStore.get(edgeId)).addresses.map(({ multiaddr: address }) => address.toString());
    expect(learned.length).toBeGreaterThan(0);
    expect(learned.filter((address) => !address.includes('/p2p-circuit'))).toEqual([]);

    // The relay watchdog reads the same self-addresses and sees the reservation.
    const logged: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try {
      await (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick();
    } finally {
      console.log = log;
    }
    expect(logged.filter(([line]) => typeof line === 'string' && line.includes('to force reserve'))).toEqual([]);
  }, 30_000);

  it('announces its interface addresses without the option', async () => {
    const relay = await relayAddress();
    const edge = await started({ listenAddresses: ['/ip4/0.0.0.0/tcp/0'], relayPeers: [relay] });
    await waitFor(() => edge.multiaddrs.some((address) => address.includes('/p2p-circuit')));
    expect(edge.multiaddrs.some((address) => address.startsWith('/ip4/127.0.0.1/'))).toBe(true);
  }, 30_000);

  it('announces an explicit list as given', async () => {
    const node = await started({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      announceAddresses: ['/ip4/10.1.2.3/tcp/4001'],
      announcePublicAddressesOnly: true,
    });
    await waitFor(() => node.multiaddrs.length > 0);
    expect(node.multiaddrs).toEqual([`/ip4/10.1.2.3/tcp/4001/p2p/${node.peerId}`]);
  }, 30_000);
});
