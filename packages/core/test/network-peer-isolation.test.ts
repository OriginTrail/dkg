/**
 * End-to-end proof, on real libp2p nodes over loopback TCP, that a node with a
 * network identity never opens a connection to another DKG network's relay:
 * not directly, not as the first hop of a circuit, and not by re-learning its
 * address from discovery. 2026-09-23 Base-mainnet evidence: the relay-path gate
 * refused circuits through testnet relays, yet kad-dht / circuit-relay
 * discovery kept dialing those relays directly (38 direct opens in 12 min).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode } from '../src/node.js';
import type { DKGNodeConfig } from '../src/types.js';

const NETWORK_A = { networkId: 'network-a', genesisId: 'genesis-a' };
const TEST_TIMEOUT_MS = 30_000;

const started: DKGNode[] = [];

async function startNode(config: DKGNodeConfig = {}): Promise<DKGNode> {
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
    ...config,
  });
  started.push(node);
  await node.start();
  return node;
}

function tcpAddr(node: DKGNode): string {
  const addr = node.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/ws'));
  if (!addr) throw new Error('node has no TCP listen address');
  return addr;
}

function connectionsTo(node: DKGNode, peerId: string) {
  return node.libp2p.getConnections(peerIdFromString(peerId));
}

/**
 * `'connected'` or the dial error's name. Asserting on a string keeps a failing
 * expectation from pretty-printing a live libp2p Connection (whose component
 * proxy throws when inspected).
 */
async function dialOutcome(dial: Promise<unknown>): Promise<string> {
  return dial.then(() => 'connected', (err: unknown) => (err as Error).name);
}

async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.stop().catch(() => {});
  }
});

describe('network peer isolation on real libp2p nodes', () => {
  it('never dials another network\'s relay directly or as a circuit hop', async () => {
    const foreignRelay = await startNode({ enableRelayServer: true });
    const bystander = await startNode();
    const relayAddr = tcpAddr(foreignRelay);
    const local = await startNode({
      networkIdentity: NETWORK_A,
      otherNetworkRelays: [relayAddr],
    });

    expect(await dialOutcome(local.libp2p.dial(multiaddr(relayAddr)))).toBe('DialDeniedError');
    expect(await dialOutcome(
      local.libp2p.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${bystander.peerId}`)),
    )).toBe('DialDeniedError');

    await settle();
    // The relay never saw a connection: the circuit was refused before its
    // first hop, and the direct dial never left the gater.
    expect(foreignRelay.libp2p.getConnections()).toHaveLength(0);
    expect(connectionsTo(local, foreignRelay.peerId)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('does not re-learn a foreign relay or circuits through it from discovery', async () => {
    const foreignRelay = await startNode({ enableRelayServer: true });
    const bystander = await startNode();
    const relayAddr = tcpAddr(foreignRelay);
    const local = await startNode({
      networkIdentity: NETWORK_A,
      otherNetworkRelays: [relayAddr],
    });
    const relayId = peerIdFromString(foreignRelay.peerId);
    const bystanderId = peerIdFromString(bystander.peerId);

    // What kad-dht closer-peer handling and identify do with learned addresses.
    await local.libp2p.peerStore.merge(relayId, { multiaddrs: [multiaddr(relayAddr)] });
    await local.libp2p.peerStore.merge(bystanderId, {
      multiaddrs: [
        multiaddr(`${relayAddr}/p2p-circuit`),
        multiaddr(tcpAddr(bystander)),
      ],
    });

    expect((await local.libp2p.peerStore.get(relayId)).addresses).toHaveLength(0);
    const bystanderAddrs = (await local.libp2p.peerStore.get(bystanderId)).addresses
      .map(({ multiaddr: ma }) => ma.toString());
    expect(bystanderAddrs).toEqual([tcpAddr(bystander).replace(`/p2p/${bystander.peerId}`, '')]);

    // A dial by peer id — what discovery, kad-dht and the reconnect queue
    // issue — is refused before any address is tried.
    expect(await dialOutcome(local.libp2p.dial(relayId))).toBe('DialDeniedError');
    await settle();
    expect(foreignRelay.libp2p.getConnections()).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('refuses inbound connections from another network\'s relay', async () => {
    const foreignRelay = await startNode({ enableRelayServer: true });
    const local = await startNode({
      networkIdentity: NETWORK_A,
      otherNetworkRelays: [tcpAddr(foreignRelay)],
    });

    // The dialer's optimistic upgrade may resolve before our side aborts the
    // secured connection, so assert on the outcome, not the dial promise.
    await dialOutcome(foreignRelay.libp2p.dial(multiaddr(tcpAddr(local))));

    await settle(500);
    expect(connectionsTo(local, foreignRelay.peerId)).toHaveLength(0);
    expect(connectionsTo(foreignRelay, local.peerId)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('refuses an identity-rejected peer until it proves membership again', async () => {
    const mismatched = await startNode();
    const local = await startNode({ networkIdentity: NETWORK_A });
    const mismatchedId = peerIdFromString(mismatched.peerId);
    const mismatchedAddr = multiaddr(tcpAddr(mismatched));

    expect(await dialOutcome(local.libp2p.dial(mismatchedAddr))).toBe('connected');
    expect(local.denyPeerAfterNetworkMismatch(mismatched.peerId)).toBe(true);
    await local.libp2p.hangUp(mismatchedId);

    expect(await dialOutcome(local.libp2p.dial(mismatchedAddr))).toBe('DialDeniedError');
    // During the admission quarantine an inbound connection could only sit
    // open unverified, so it is refused as well.
    await dialOutcome(mismatched.libp2p.dial(multiaddr(tcpAddr(local))));
    await settle(500);
    expect(connectionsTo(local, mismatched.peerId)).toHaveLength(0);

    // Passing the identity proof lifts both directions.
    local.clearPeerNetworkMismatchDenial(mismatched.peerId);
    expect(await dialOutcome(mismatched.libp2p.dial(multiaddr(tcpAddr(local))))).toBe('connected');
    await settle();
    expect(connectionsTo(local, mismatched.peerId).length).toBeGreaterThan(0);
    await local.libp2p.hangUp(mismatchedId);
    await settle();
    expect(await dialOutcome(local.libp2p.dial(mismatchedAddr))).toBe('connected');
  }, TEST_TIMEOUT_MS);

  it('keeps the legacy behaviour without a network identity', async () => {
    const relay = await startNode({ enableRelayServer: true });
    const plain = await startNode({ otherNetworkRelays: [tcpAddr(relay)] });

    expect(await dialOutcome(plain.libp2p.dial(multiaddr(tcpAddr(relay))))).toBe('connected');
  }, TEST_TIMEOUT_MS);

  it('keeps the legacy behaviour when the operator turns peer isolation off', async () => {
    const relay = await startNode({ enableRelayServer: true });
    const local = await startNode({
      networkIdentity: NETWORK_A,
      otherNetworkRelays: [tcpAddr(relay)],
      networkPeerIsolation: false,
    });

    expect(await dialOutcome(local.libp2p.dial(multiaddr(tcpAddr(relay))))).toBe('connected');
    expect(local.denyPeerAfterNetworkMismatch(relay.peerId)).toBe(false);
  }, TEST_TIMEOUT_MS);
});
