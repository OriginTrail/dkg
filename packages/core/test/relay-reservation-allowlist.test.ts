/**
 * On real libp2p nodes over loopback TCP: a node with a network identity
 * holds reservations on its configured relays only, also after one of them
 * drops out while another relay-capable peer is known.
 *
 * Before the guard in relay-client-transport.ts, libp2p moved the freed slot to
 * that other peer (its pass over the peer store asks no filter), the node
 * announced a circuit address its own gate refuses, and the configured relay
 * never got the slot back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode } from '../src/node.js';
import type { DKGNodeConfig } from '../src/types.js';

const NETWORK_A = { networkId: 'network-a', genesisId: 'genesis-a' };
const HOP_PROTOCOL = '/libp2p/circuit/relay/0.2.0/hop';
const TEST_TIMEOUT_MS = 60_000;

const started: DKGNode[] = [];
const ORIG_CONSOLE_LOG = console.log;

async function startNode(config: DKGNodeConfig = {}): Promise<DKGNode> {
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
    networkIdentity: NETWORK_A,
    ...config,
  });
  started.push(node);
  await node.start();
  return node;
}

function tcpAddr(node: DKGNode): string {
  const addr = node.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/ws') && !a.includes('/p2p-circuit'));
  if (!addr) throw new Error('node has no TCP listen address');
  return addr;
}

/** Peer ids of the relays the node currently announces a circuit address through. */
function reservedRelays(node: DKGNode): string[] {
  const relays = new Set<string>();
  for (const addr of node.multiaddrs) {
    const match = addr.match(/\/p2p\/([^/]+)\/p2p-circuit/);
    if (match) relays.add(match[1]!);
  }
  return [...relays].sort();
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

/** The node has identified `peerId` as a relay: libp2p's pass over the peer store will offer it. */
async function knowsAsRelay(node: DKGNode, peerId: string): Promise<boolean> {
  try {
    return (await node.libp2p.peerStore.get(peerIdFromString(peerId))).protocols.includes(HOP_PROTOCOL);
  } catch {
    return false;
  }
}

afterEach(async () => {
  console.log = ORIG_CONSOLE_LOG;
  for (const node of started.splice(0)) {
    await node.stop().catch(() => {});
  }
});

describe('relay reservations stay on the configured relays', () => {
  it('keeps a freed slot for a configured relay, not for another relay-capable peer', async () => {
    const relay1 = await startNode({ enableRelayServer: true });
    const relay2 = await startNode({ enableRelayServer: true });
    // Same network, runs a relay server, but is not in the edge's relay list.
    const outsider = await startNode({ enableRelayServer: true });
    const relay1Addr = multiaddr(tcpAddr(relay1));
    const relay1Id = peerIdFromString(relay1.peerId);

    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    const edge = await startNode({
      relayPeers: [tcpAddr(relay1), tcpAddr(relay2)],
      relayReservationCount: 2,
    });
    const bothConfigured = [relay1.peerId, relay2.peerId].sort();
    expect(await waitFor(() => reservedRelays(edge).length === 2, 10_000)).toBe(true);
    expect(reservedRelays(edge)).toEqual(bothConfigured);

    // The edge meets the outsider as it meets any other node of its network.
    await edge.libp2p.dial(multiaddr(tcpAddr(outsider)));
    expect(await waitFor(() => knowsAsRelay(edge, outsider.peerId), 5_000)).toBe(true);

    // A configured relay drops out: the edge loses the connection and cannot
    // dial it again. (The refusal the node applies to a peer of another
    // network keeps it away here without stopping the relay.)
    expect(edge.denyPeerAfterNetworkMismatch(relay1.peerId, 10 * 60_000)).toBe(true);
    await edge.libp2p.hangUp(relay1Id);
    expect(await waitFor(() => !reservedRelays(edge).includes(relay1.peerId), 10_000)).toBe(true);

    // libp2p offers the outsider for the freed slot; the node declines it. A
    // reservation there would be made within a round trip of the offer, so
    // the pause shows it is not coming.
    expect(await waitFor(() => logs.some((line) => line.includes('Relay reservation skipped')
      && line.includes(outsider.peerId.slice(-8))), 10_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(reservedRelays(edge)).toEqual([relay2.peerId]);
    expect(outsider.getRelayStats()?.reservationCount).toBe(0);

    // The relay is back and gets its slot again.
    edge.clearPeerNetworkMismatchDenial(relay1.peerId);
    await edge.libp2p.dial(relay1Addr);
    expect(await waitFor(() => reservedRelays(edge).length === 2, 15_000)).toBe(true);
    expect(reservedRelays(edge)).toEqual(bothConfigured);
    expect(outsider.getRelayStats()?.reservationCount).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('still reserves on any relay-capable peer when the node has no network identity', async () => {
    const relay = await startNode({ enableRelayServer: true, networkIdentity: undefined });
    const outsider = await startNode({ enableRelayServer: true, networkIdentity: undefined });
    const outsiderId = outsider.peerId;
    const edge = await startNode({
      networkIdentity: undefined,
      relayPeers: [tcpAddr(relay)],
    });
    expect(await waitFor(() => reservedRelays(edge).length === 1, 10_000)).toBe(true);

    await edge.libp2p.dial(multiaddr(tcpAddr(outsider)));
    expect(await waitFor(() => knowsAsRelay(edge, outsiderId), 5_000)).toBe(true);

    await relay.stop();
    expect(await waitFor(() => reservedRelays(edge).includes(outsiderId), 10_000)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
