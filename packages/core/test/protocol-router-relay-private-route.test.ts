import { afterEach, describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter } from '../src/protocol-router.js';

// The router keeps a stream off a limited connection while the peer lists a
// direct address it could be upgraded to, because an upgrade (DCUtR) closes
// the circuit under the stream. DCUtR dials public addresses and DNS names
// only. Here the peer's one direct address is a private one that the
// requester CAN reach (both run on loopback), and the requester's router runs
// with `publicDirectAddressesOnly`: a slow request crosses the circuit, no
// stream is dialed, nothing upgrades the connection, and the circuit stays.

const PROTOCOL = '/test/relay-private-route/1.0.0';
const RESPONSE_DELAY_MS = 1_500;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('a reachable private address beside an open circuit', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const node of nodes.splice(0)) await node.stop().catch(() => undefined);
  });

  async function started(config: ConstructorParameters<typeof DKGNode>[0]): Promise<DKGNode> {
    const node = new DKGNode({ enableMdns: false, listenAddresses: ['/ip4/127.0.0.1/tcp/0'], ...config });
    nodes.push(node);
    await node.start();
    return node;
  }

  it('carries a slow request over the circuit, and nothing upgrades or closes it', async () => {
    const relay = await started({ enableRelayServer: true });
    const relayAddress = relay.multiaddrs.find((address) => address.includes('/tcp/'))!;
    const target = await started({ relayPeers: [relayAddress] });
    const requester = await started({ relayPeers: [relayAddress] });
    await waitFor(() => target.multiaddrs.some((address) => address.includes('/p2p-circuit')));

    const targetRouter = new ProtocolRouter(target);
    targetRouter.register(PROTOCOL, async (data) => {
      await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
      return data;
    });
    const requesterRouter = new ProtocolRouter(requester, { publicDirectAddressesOnly: true });

    await requester.libp2p.dial(multiaddr(`${relayAddress}/p2p-circuit/p2p/${target.peerId}`));
    const targetId = peerIdFromString(target.peerId);
    const listed = async () => (await requester.libp2p.peerStore.get(targetId).catch(() => undefined))?.addresses
      .map(({ multiaddr: address }) => address.toString()) ?? [];
    await waitFor(async () => (await listed()).some((address) => address.startsWith('/ip4/127.0.0.1/') && !address.includes('/p2p-circuit')));

    const dials: string[] = [];
    const dialProtocol = requester.libp2p.dialProtocol.bind(requester.libp2p);
    requester.libp2p.dialProtocol = ((peer, protocols, options) => {
      if (peer.toString() === target.peerId) dials.push(String(protocols));
      return dialProtocol(peer, protocols, options);
    }) as typeof requester.libp2p.dialProtocol;
    const circuit = requester.libp2p.getConnections(targetId).find((connection) => connection.limits != null)!;
    expect(circuit, 'the requester holds a circuit to the target').toBeDefined();

    const response = await requesterRouter.send(target.peerId, PROTOCOL, new Uint8Array([7]), 15_000);
    expect([...response]).toEqual([7]);
    expect(dials, 'streams dialed to the target').toEqual([]);

    // Give an upgrade the time it would take, then look at the connections.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const open = requester.libp2p.getConnections(targetId).filter((connection) => connection.status === 'open');
    expect(open.filter((connection) => connection.limits == null), 'direct connections to the target').toEqual([]);
    expect(circuit.status, 'the circuit the request crossed').toBe('open');
    targetRouter.unregister(PROTOCOL);
  }, 30_000);
});
