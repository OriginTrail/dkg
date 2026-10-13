/**
 * Relay-only network fixture: DKG agents in one process whose only route to
 * each other is a circuit through a relay, as for edge nodes behind NATs.
 *
 * Two things make that hard on one host, and this file owns both.
 *
 *  - The relay. A `DKGNode` with `enableRelayServer: true` runs the relay
 *    server a Core node runs, with the Core's per-circuit data and duration
 *    limits (`packages/core/src/node.ts`). libp2p marks every connection it
 *    relays as limited (`connection.limits`).
 *
 *  - No direct path. Agents on one host can always reach each other's listen
 *    port, and libp2p takes that route the first time anything dials a peer to
 *    which only a limited connection is open: identify has told each side the
 *    other's listen address by then. So each agent here announces, in place of
 *    its listen address, a loopback port that drops every connection, plus its
 *    circuit address through the relay. A peer then knows what it knows about a
 *    node behind a NAT: a direct address that does not work and a relay address
 *    that does. The real listen port is never announced, and an agent with
 *    relay peers runs no mDNS, so no peer can learn it.
 *
 * The relay is a plain node, not a Core agent: it relays and does nothing else.
 * No agent learns of another through it, so the topology stays what a suite
 * builds. (The agents still try DKG protocols against it and are refused; that
 * shows up as warnings about the relay's peer id and is harmless.)
 *
 * What it deliberately does NOT own: the agents (see `real-chain-agent.ts`) and
 * the scenario. A suite builds its agents with `addressing()`, connects them
 * with `connectThroughRelay`, and proves the link with `expectRelayOnlyLink`
 * before it concludes anything from what crossed it.
 *
 * Two things a suite should know about such a link (both are libp2p's, measured
 * with bare nodes as well):
 *  - a request does not always take milliseconds. While the only connection to
 *    a peer is limited, libp2p dials the peer again for every new stream; when
 *    both ends do that at the same moment the dial fails, at once or after a
 *    six-second handshake timeout, and only then is the open circuit reused.
 *    Bounds for anything that crosses the link need room for that;
 *  - `connection.limits.seconds` is not seconds here (see `LinkConnection`).
 */
import { createServer, type Server } from 'node:net';
import { expect } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { DKGNode } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../../src/index.js';
import { pollUntil } from './real-chain-agent.js';

/** The two agent options that put an agent behind the relay. */
export interface RelayOnlyAddressing {
  readonly relayPeers: string[];
  readonly announceAddresses: string[];
}

/** One open connection of `from` to `to`, as libp2p reports it. */
export interface LinkConnection {
  readonly address: string;
  readonly direction: string;
  /** The remote address goes through this fixture's relay. */
  readonly relayed: boolean;
  /** libp2p's marker for a connection with granted limits (`connection.limits`). */
  readonly limited: boolean;
  /** Bytes the relay still lets through; counts down with traffic in either direction. */
  readonly bytesLeft: bigint | undefined;
  /**
   * The duration limit as the agent reads it. With a js-libp2p relay this is NOT
   * seconds of real time: the relay sends its limit in milliseconds and the
   * client reads the field as seconds, so a 30-minute grant reads as 1,800,000.
   */
  readonly secondsLeft: number | undefined;
}

const LOOPBACK = '127.0.0.1';
/** What a Core's relay lets through one circuit (`defaultDataLimit` in `packages/core/src/node.ts`). */
const CORE_RELAY_DATA_LIMIT_BYTES = 256n * 1024n * 1024n;
/** A connection that has carried less than this still shows the grant it started with. */
const FRESH_GRANT_SLACK_BYTES = 1024n * 1024n;

export class RelayOnlyNetwork {
  private readonly deadPorts: Server[] = [];

  private constructor(
    private readonly relay: DKGNode,
    /** `/ip4/127.0.0.1/tcp/<port>/p2p/<relay peer id>`. */
    readonly relayAddress: string,
  ) {}

  static async start(): Promise<RelayOnlyNetwork> {
    const relay = new DKGNode({
      listenAddresses: [`/ip4/${LOOPBACK}/tcp/0`],
      enableMdns: false,
      enableRelayServer: true,
    });
    await relay.start();
    const relayAddress = relay.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/ws'));
    expect(relayAddress, 'the relay listens on TCP').toBeDefined();
    return new RelayOnlyNetwork(relay, relayAddress!);
  }

  get relayPeerId(): string {
    return this.relay.peerId;
  }

  /**
   * Addressing for ONE agent: reserve on the relay, and announce a dead direct
   * address plus the circuit address. Each call opens its own dead port.
   */
  async addressing(): Promise<RelayOnlyAddressing> {
    const deadPort = await this.openDeadPort();
    return {
      relayPeers: [this.relayAddress],
      announceAddresses: [`/ip4/${LOOPBACK}/tcp/${deadPort}`, `${this.relayAddress}/p2p-circuit`],
    };
  }

  /** The address that reaches `agent` through the relay. */
  circuitAddressOf(agent: DKGAgent): string {
    return `${this.relayAddress}/p2p-circuit/p2p/${agent.peerId}`;
  }

  async stop(): Promise<void> {
    try { await this.relay.stop(); } catch { /* already stopped */ }
    await Promise.all(this.deadPorts.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  }

  /** A port that accepts and at once drops every connection: a direct dial that goes nowhere. */
  private async openDeadPort(): Promise<number> {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK, () => resolve());
    });
    this.deadPorts.push(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the dead port has no TCP address');
    return address.port;
  }
}

/** Every open connection `from` holds to `to`. */
export function linkConnections(network: RelayOnlyNetwork, from: DKGAgent, to: DKGAgent): LinkConnection[] {
  const throughRelay = `/p2p/${network.relayPeerId}/p2p-circuit`;
  return from.node.libp2p.getConnections(peerIdFromString(to.peerId))
    .filter((connection) => connection.status === 'open')
    .map((connection) => {
      const address = connection.remoteAddr.toString();
      return {
        address,
        direction: connection.direction,
        relayed: address.includes(throughRelay),
        limited: connection.limits != null,
        bytesLeft: connection.limits?.bytes,
        secondsLeft: connection.limits?.seconds,
      };
    });
}

/** One line per connection, for assertion messages. */
export function describeLink(connections: readonly LinkConnection[]): string {
  if (connections.length === 0) return 'no connection';
  return connections.map((connection) => (
    `${connection.relayed ? 'relayed' : 'DIRECT'} ${connection.limited ? 'limited' : 'UNLIMITED'} ` +
    `${connection.direction} bytesLeft=${connection.bytesLeft ?? 'none'} secondsLeft=${connection.secondsLeft ?? 'none'} ` +
    connection.address
  )).join('; ');
}

/**
 * Dial `to` from `from` through the relay, then wait until both ends hold the
 * circuit and identify has told each end which protocols the other speaks. The
 * dial is retried within `timeoutMs`: `to` is reachable only once its
 * reservation on the relay exists, which its start does not wait for.
 */
export async function connectThroughRelay(
  network: RelayOnlyNetwork,
  from: DKGAgent,
  to: DKGAgent,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let dialed = false;
  while (!dialed && Date.now() < deadline) {
    try {
      await from.connectTo(network.circuitAddressOf(to));
      dialed = true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(dialed, `dial through the relay: ${lastError instanceof Error ? lastError.message : String(lastError)}`).toBe(true);
  const bothEnds = await pollUntil(
    () => linkConnections(network, from, to).length > 0 && linkConnections(network, to, from).length > 0,
    (connected) => connected,
    Math.max(1_000, deadline - Date.now()),
    100,
  );
  expect(bothEnds, 'both ends hold the circuit').toBe(true);
  for (const [local, remote] of [[from, to], [to, from]] as const) {
    const advertised = await pollUntil(
      () => local.node.libp2p.peerStore.get(peerIdFromString(remote.peerId))
        .then((peer) => peer.protocols.length)
        .catch(() => 0),
      (count) => count > 0,
      Math.max(1_000, deadline - Date.now()),
      100,
    );
    expect(advertised, 'identify completed over the circuit').toBeGreaterThan(0);
  }
}

/**
 * The precondition of every relay-only scenario, checked at both ends: at least
 * one connection, every connection through the relay, every connection limited.
 * A direct connection, or one libp2p does not mark limited, fails here.
 */
export function expectRelayOnlyLink(
  network: RelayOnlyNetwork,
  a: DKGAgent,
  b: DKGAgent,
  when: string,
): { readonly aToB: LinkConnection[]; readonly bToA: LinkConnection[] } {
  const aToB = linkConnections(network, a, b);
  const bToA = linkConnections(network, b, a);
  for (const [side, connections] of [['first agent', aToB], ['second agent', bToA]] as const) {
    const seen = `${when}, ${side}: ${describeLink(connections)}`;
    expect(connections.length, `a connection exists (${seen})`).toBeGreaterThan(0);
    expect(connections.filter((connection) => !connection.relayed), `no direct connection (${seen})`).toEqual([]);
    expect(connections.filter((connection) => !connection.limited), `every connection is limited (${seen})`).toEqual([]);
  }
  return { aToB, bToA };
}

/**
 * The circuits of a link are the ones a Core grants: a data limit of 256 MiB,
 * hardly used yet, and a duration limit. Meant for a link that has just been
 * made; the byte counter of an older one has moved on.
 */
export function expectFreshCoreGrant(connections: readonly LinkConnection[], when: string): void {
  for (const connection of connections) {
    const seen = `${when}: ${describeLink([connection])}`;
    expect(connection.bytesLeft, `a data limit is granted (${seen})`).toBeDefined();
    expect(
      connection.bytesLeft! <= CORE_RELAY_DATA_LIMIT_BYTES
        && connection.bytesLeft! > CORE_RELAY_DATA_LIMIT_BYTES - FRESH_GRANT_SLACK_BYTES,
      `the data limit is the Core's 256 MiB (${seen})`,
    ).toBe(true);
    expect(connection.secondsLeft, `a duration limit is granted (${seen})`).toBeGreaterThan(0);
  }
}
