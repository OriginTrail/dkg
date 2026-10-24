// SPDX-License-Identifier: Apache-2.0

/**
 * How a share into a public context graph reaches the nodes that need it when
 * its author is an Edge that connects only to Cores (relay-only).
 *
 * A member sends a share to the graph's GossipSub subscribers and to its
 * followers (#3208). For a relay-only author those are the Cores it is
 * connected to: GossipSub does not run over a relayed connection, and another
 * Edge is a follower only after it asked this one for the graph. Three routes
 * close the gap:
 *
 * 1. A Core that hosts the public graph applies a share into a named
 *    sub-graph, as a subscriber does ({@link coreHostsPublicGraph}). It used to
 *    decline it because it does not subscribe to the graph. The catalog keeps
 *    the root scope, and the share handler's checks all still run. Other
 *    members then pull the share from the Core. A pulled copy carries no
 *    author seal, and the owner needs the seal to publish a member's asset to
 *    Verified Memory, so the owner must get the member's signed share itself:
 *    the Core passes it on, the bytes unchanged, to the owner's peers it is
 *    connected to (`owner-share-forward.ts`). That is how the share reaches
 *    the owner when the member cannot find the owner.
 * 2. The fallback: the author makes the graph's owner one of the share's
 *    followers, connecting to it through a relay when the two are not
 *    connected ({@link routeShareToGraphOwner}), for a Core that does not pass
 *    shares on and an owner it is not connected to. An Edge keeps no `agents`
 *    phonebook, so it looks the owner's wallet up in a Core's phonebook on
 *    demand when it cannot map the owner to a peer.
 * 3. When none of a share's recipients is a Core, which is the case while no
 *    Core subscribes to the graph yet, the author sends the share to the Cores
 *    it is connected to as well ({@link needsHoldingCores}), as it sends
 *    followers. A Core that hosts the graph keeps the share for the others,
 *    who pull it from there; one that does not refuses it, and is left out of
 *    that graph's shares for a while, unless it applied one of them lately
 *    ({@link ShareHolderRefusals}).
 */

import { createHash } from 'node:crypto';
import { resolveWithinAbort } from '@origintrail-official/dkg-core';
import { rememberBounded } from '../bounded-map.js';
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
/**
 * A peer this node could not connect to, and an owner that was not found, are
 * not tried again for this long, so later shares do not wait for them.
 */
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
  const owners = await resolveWithinAbort(
    (signal) => ports.ownerPeerIds(contextGraphId, signal ?? deadline),
    deadline,
  ).catch(() => null) ?? [];
  let routed = owners.filter((peerId) => ports.isConnected(peerId));
  if (routed.length === 0) {
    const candidates = owners.filter((peerId) => ports.mayConnect(peerId));
    for (const peerId of candidates.slice(0, options.attempts ?? GRAPH_OWNER_CONNECT_ATTEMPTS)) {
      if (deadline.aborted) break;
      const reached = await resolveWithinAbort(
        (signal) => ports.connect(peerId, signal ?? deadline),
        deadline,
      ).catch(() => false);
      if (reached === true) {
        routed = [peerId];
        break;
      }
      ports.connectFailed(peerId);
    }
  }
  for (const peerId of routed) ports.noteFollower(contextGraphId, peerId);
  return routed;
}

/** Owner peers that were found are reused for this long. */
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
   * The owner's peers. Peers that were found are reused for
   * {@link GRAPH_OWNER_PEERS_TTL_MS}. An owner that was not found (none known,
   * or the lookup failed or ran out of time) is looked up again after
   * {@link GRAPH_OWNER_RETRY_AFTER_MS}: an Edge's phonebook can learn it at any
   * time, and in between shares do not wait for the lookup.
   */
  async of(contextGraphId: string, signal?: AbortSignal): Promise<readonly string[]> {
    const cached = this.#byGraph.get(contextGraphId);
    const reuseFor = cached?.peerIds.length === 0 ? GRAPH_OWNER_RETRY_AFTER_MS : GRAPH_OWNER_PEERS_TTL_MS;
    if (cached !== undefined && this.#now() - cached.at < reuseFor) return cached.peerIds;
    const peerIds = await this.#resolve(contextGraphId, signal).catch((): readonly string[] => []);
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

/** Connected Cores one share goes to when none of its recipients is a Core. */
export const SHARE_HOLDER_CORES_MAX = 4;
/** A Core that refused a share of a graph is not sent that graph's shares of the same scope for this long. */
export const SHARE_HOLDER_REFUSAL_TTL_MS = 10 * 60_000;
/** A Core that applied a share of a graph less than this long ago hosts the graph's shares of that scope. */
export const SHARE_HOLDER_ACCEPT_TTL_MS = 10 * 60_000;
/** Refusals, and apart from them accepts, remembered at most. */
const SHARE_HOLDER_MEMORY_MAX = 1024;

/**
 * Whether a share also goes to the connected Cores: shares by an Edge into a
 * public graph, when none of the share's recipients is a Core. Asked on "no
 * Core", not on "no recipient": a routed owner or a follower must not keep
 * the share from the Cores, which hold it for the members connected only to
 * Cores.
 */
export function needsHoldingCores(input: {
  readonly authorRole: 'core' | 'edge' | undefined;
  readonly publicShare: boolean;
  readonly recipients: readonly string[];
  readonly isCore: (peerId: string) => boolean;
}): boolean {
  return (input.authorRole ?? 'edge') === 'edge'
    && input.publicShare
    && !input.recipients.some((peerId) => input.isCore(peerId));
}

/**
 * The connected Cores a share goes to: not a recipient already, not one that
 * refused the graph's share lately, at most {@link SHARE_HOLDER_CORES_MAX}.
 * They are taken in an order fixed per graph, so that a graph's shares go to
 * the same Cores each time while different graphs spread over the Cores.
 */
export function chooseHoldingCores(input: {
  readonly contextGraphId: string;
  readonly candidates: readonly string[];
  readonly exclude: ReadonlySet<string>;
  readonly refused: (peerId: string) => boolean;
  readonly max?: number;
}): string[] {
  const rank = (peerId: string): string => createHash('sha256').update(`${input.contextGraphId}\0${peerId}`).digest('hex');
  return [...new Set(input.candidates)]
    .filter((peerId) => !input.exclude.has(peerId) && !input.refused(peerId))
    .map((peerId) => ({ peerId, rank: rank(peerId) }))
    .sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0))
    .slice(0, input.max ?? SHARE_HOLDER_CORES_MAX)
    .map(({ peerId }) => peerId);
}

function refusalKey(contextGraphId: string, subGraphName: string | null, peerId: string): string {
  return `${contextGraphId}\0${subGraphName === null ? 'root' : 'named'}\0${peerId}`;
}

/**
 * Cores that refused a share of a graph, by the scope it went to: a Core that
 * does not host the graph refuses all of its sub-graph shares, and a Core whose
 * catalog owns the root refuses root shares only.
 *
 * A refusal alone does not show which. A receiver answers every share it
 * will never apply with the same one-byte refusal: one for a graph or scope it
 * does not host, and one it rejects on its own merits, such as an outdated or
 * conflicting version of an asset or another publisher's asset. Its reason
 * stays in the receiver's log, so the sender cannot tell the two apart without
 * a change to the protocol. So a Core that applied a share of the graph and
 * scope within {@link SHARE_HOLDER_ACCEPT_TTL_MS} hosts them: a refusal from it
 * is about that share alone, and the sender keeps it to that share (the share's
 * delivery tracking drops the Core). Only a refusal from a Core with no recent
 * accept leaves the Core out of the graph's shares of that scope, and an accept
 * ends a refusal noted before it, as when the answers to two shares arrive out
 * of order. What remains: the first share a Core ever gets of a graph may be
 * refused on its merits and leave the Core out for a while, and a Core that
 * stops hosting the graph is still sent its shares until its last accept is
 * that old, each refusal then kept to its share.
 *
 * Bounded; the oldest refusal, or accept, makes room.
 */
export class ShareHolderRefusals {
  readonly #now: () => number;
  readonly #refusedAt = new Map<string, number>();
  readonly #acceptedAt = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The Core applied a share of the graph into this scope: it hosts them. */
  noteAccepted(contextGraphId: string, subGraphName: string | null, peerId: string): void {
    const key = refusalKey(contextGraphId, subGraphName, peerId);
    this.#refusedAt.delete(key);
    rememberBounded(this.#acceptedAt, key, this.#now(), SHARE_HOLDER_MEMORY_MAX);
  }

  /** The Core refused a share of the graph into this scope; left out only when it applied none of them lately. */
  noteRefused(contextGraphId: string, subGraphName: string | null, peerId: string): void {
    const key = refusalKey(contextGraphId, subGraphName, peerId);
    if (this.#recent(this.#acceptedAt, key, SHARE_HOLDER_ACCEPT_TTL_MS)) return;
    rememberBounded(this.#refusedAt, key, this.#now(), SHARE_HOLDER_MEMORY_MAX);
  }

  refused(contextGraphId: string, subGraphName: string | null, peerId: string): boolean {
    return this.#recent(this.#refusedAt, refusalKey(contextGraphId, subGraphName, peerId), SHARE_HOLDER_REFUSAL_TTL_MS);
  }

  /** Refusals held; for tests. */
  get size(): number {
    return this.#refusedAt.size;
  }

  /** Accepts held; for tests. */
  get acceptsHeld(): number {
    return this.#acceptedAt.size;
  }

  /** Whether `key` was noted in `memory` less than `ttlMs` ago; an older note is forgotten. */
  #recent(memory: Map<string, number>, key: string, ttlMs: number): boolean {
    const at = memory.get(key);
    if (at === undefined) return false;
    if (this.#now() - at < ttlMs) return true;
    memory.delete(key);
    return false;
  }
}

const shareHolderRefusalsByAgent = new WeakMap<object, ShareHolderRefusals>();

/** The agent's memory of Cores that refused a share, created on first use (with `now`, for tests). */
export function shareHolderRefusalsOf(agent: object, now?: () => number): ShareHolderRefusals {
  let refusals = shareHolderRefusalsByAgent.get(agent);
  if (refusals === undefined) {
    refusals = new ShareHolderRefusals(now);
    shareHolderRefusalsByAgent.set(agent, refusals);
  }
  return refusals;
}
