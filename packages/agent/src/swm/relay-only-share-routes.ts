// SPDX-License-Identifier: Apache-2.0

/**
 * How a share into a public context graph reaches the nodes that need it when
 * its author is an Edge that connects only to Cores (relay-only).
 *
 * A member sends a share to the graph's GossipSub subscribers and to its
 * followers (#3208). For a relay-only author those are the Cores it is
 * connected to: GossipSub does not run over a relayed connection, and another
 * Edge is a follower only after it asked this one for the graph. Two routes
 * close the gap:
 *
 * 1. A Core that hosts the public graph applies a share into a named
 *    sub-graph, as a subscriber does ({@link coreHostsPublicGraph}). It used to
 *    decline it because it does not subscribe to the graph. The catalog keeps
 *    the root scope, and the share handler's checks all still run. Other
 *    members then pull the share from the Core.
 * 2. The author makes the graph's owner one of the share's followers,
 *    connecting to it through a relay when the two are not connected
 *    ({@link routeShareToGraphOwner}). A pulled copy carries no author seal,
 *    and the owner needs the seal to publish a member's asset to Verified
 *    Memory, so the owner must get the share itself.
 */

import type { ContextGraphSub } from '../dkg-agent-types.js';

/**
 * True on a Core that hosts the public graph, whether or not it subscribes to
 * it. A Core records a graph as hosted (`coreHosted`) only for a public graph,
 * when it signs a StorageACK for it.
 */
export function coreHostsPublicGraph(
  nodeRole: 'core' | 'edge' | undefined,
  subscription: Pick<ContextGraphSub, 'coreHosted'> | undefined,
): boolean {
  return nodeRole === 'core' && subscription?.coreHosted === true;
}

/**
 * Upper bound for the whole route, the owner's lookup and the connection
 * attempts together, before a share goes out without the owner.
 */
export const GRAPH_OWNER_ROUTE_TIMEOUT_MS = 10_000;
/** Owner peers tried, in order, when none is connected. */
export const GRAPH_OWNER_CONNECT_ATTEMPTS = 2;
/** A peer this node could not connect to is not tried again for this long, so later shares do not wait for it. */
export const GRAPH_OWNER_RETRY_AFTER_MS = 60_000;

/** What the owner route uses of the agent. */
export interface GraphOwnerRoutePorts {
  /** The peers of the graph's owner; empty when this node owns the graph or none is known. */
  ownerPeerIds(contextGraphId: string, signal: AbortSignal): Promise<readonly string[]>;
  isConnected(peerId: string): boolean;
  /** Connect to the peer, through a relay when that is the only route; true once it takes shares. */
  connect(peerId: string, signal: AbortSignal): Promise<boolean>;
  /** False while the peer is not to be tried again after a failed connection. */
  mayConnect(peerId: string): boolean;
  connectFailed(peerId: string): void;
  /** Make the peer a follower of the graph, so that the share's fan-out sends to it. */
  noteFollower(contextGraphId: string, peerId: string): void;
}

/**
 * Make the graph's owner a follower of the graph before a share goes out:
 * the owner's connected peers when there are any, otherwise the first of its
 * peers this node can connect to. One deadline bounds the owner's lookup and
 * the connection attempts together; the share goes out without the owner when
 * it passes. A peer a connection failed to is left out for
 * {@link GRAPH_OWNER_RETRY_AFTER_MS}. Returns the peers it made followers;
 * never throws.
 */
export async function routeShareToGraphOwner(
  ports: GraphOwnerRoutePorts,
  contextGraphId: string,
  options: { readonly timeoutMs?: number; readonly attempts?: number } = {},
): Promise<readonly string[]> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? GRAPH_OWNER_ROUTE_TIMEOUT_MS);
  let owners: readonly string[];
  try {
    owners = await untilAborted(ports.ownerPeerIds(contextGraphId, deadline), deadline);
  } catch {
    return [];
  }
  let routed = owners.filter((peerId) => ports.isConnected(peerId));
  if (routed.length === 0) {
    const candidates = owners.filter((peerId) => ports.mayConnect(peerId));
    for (const peerId of candidates.slice(0, options.attempts ?? GRAPH_OWNER_CONNECT_ATTEMPTS)) {
      if (deadline.aborted) break;
      const reached = await untilAborted(ports.connect(peerId, deadline), deadline).catch(() => false);
      if (reached) {
        routed = [peerId];
        break;
      }
      ports.connectFailed(peerId);
    }
  }
  for (const peerId of routed) ports.noteFollower(contextGraphId, peerId);
  return routed;
}

/** `work`, or a rejection as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** Owner peers looked up at most once per graph in this window. */
export const GRAPH_OWNER_PEERS_TTL_MS = 5 * 60_000;
const MAX_CACHED_GRAPHS = 256;

/** One agent's cache of graph owners' peers, and of the peers a connection recently failed to. */
export class GraphOwnerPeers {
  readonly #resolve: (contextGraphId: string, signal?: AbortSignal) => Promise<readonly string[]>;
  readonly #now: () => number;
  readonly #byGraph = new Map<string, { readonly at: number; readonly peerIds: readonly string[] }>();
  readonly #failedAt = new Map<string, number>();

  constructor(
    resolve: (contextGraphId: string, signal?: AbortSignal) => Promise<readonly string[]>,
    now: () => number = Date.now,
  ) {
    this.#resolve = resolve;
    this.#now = now;
  }

  /**
   * The owner's peers; a failed lookup counts as none until the window ends.
   * A lookup the caller gave up on (`signal`) is not remembered.
   */
  async of(contextGraphId: string, signal?: AbortSignal): Promise<readonly string[]> {
    const cached = this.#byGraph.get(contextGraphId);
    if (cached !== undefined && this.#now() - cached.at < GRAPH_OWNER_PEERS_TTL_MS) return cached.peerIds;
    const peerIds = await this.#resolve(contextGraphId, signal).catch((error: unknown): readonly string[] => {
      if (signal?.aborted) throw error;
      return [];
    });
    this.#byGraph.delete(contextGraphId);
    if (this.#byGraph.size >= MAX_CACHED_GRAPHS) this.#byGraph.delete(this.#byGraph.keys().next().value as string);
    this.#byGraph.set(contextGraphId, { at: this.#now(), peerIds });
    return peerIds;
  }

  mayConnect(peerId: string): boolean {
    const failedAt = this.#failedAt.get(peerId);
    return failedAt === undefined || this.#now() - failedAt >= GRAPH_OWNER_RETRY_AFTER_MS;
  }

  connectFailed(peerId: string): void {
    this.#failedAt.delete(peerId);
    if (this.#failedAt.size >= MAX_CACHED_GRAPHS) this.#failedAt.delete(this.#failedAt.keys().next().value as string);
    this.#failedAt.set(peerId, this.#now());
  }
}

const graphOwnerPeersByAgent = new WeakMap<object, GraphOwnerPeers>();

/** The agent's cache of graph owners' peers, created with `resolve` on first use. */
export function graphOwnerPeersOf(
  agent: object,
  resolve: (contextGraphId: string, signal?: AbortSignal) => Promise<readonly string[]>,
): GraphOwnerPeers {
  let peers = graphOwnerPeersByAgent.get(agent);
  if (peers === undefined) {
    peers = new GraphOwnerPeers(resolve);
    graphOwnerPeersByAgent.set(agent, peers);
  }
  return peers;
}
