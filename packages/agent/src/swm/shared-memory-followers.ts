// SPDX-License-Identifier: Apache-2.0

/**
 * Peers known to follow a context graph's shared memory without GossipSub.
 *
 * A public context graph has no roster. The recipients of a share into one
 * were the peers GossipSub reports as subscribed to the graph's topic.
 * GossipSub does not run over a relayed connection, so a peer that this node
 * reaches only through a relay was never among them, and a share never went
 * to it.
 *
 * Such a peer still asks this node for the graph's shared memory over the
 * request/response sync protocol, which does run through a relay. A request
 * that this node authorized is the evidence kept here: the peer may read the
 * graph, and it follows it. The share then goes to it over the same direct
 * protocol as to any other recipient.
 *
 * A direct send is a follower's only path, so the fan-out treats followers
 * apart from subscribers: it does not narrow them, does not drop them when a
 * graph has too many subscribers for direct sends, and does not send them a
 * share they are certain to refuse (see `publishWorkspaceGossip`).
 */

/** Where a share goes: the root of its graph (`null`) or a named sub-graph. */
export interface WorkspaceShareScope {
  readonly subGraphName: string | null;
}

/**
 * How long one authorized request keeps a peer among the followers. A node
 * that follows a graph asks its connected peers again every few minutes, so a
 * follower that stays is refreshed long before this passes.
 */
export const SHARED_MEMORY_FOLLOWER_TTL_MS = 30 * 60_000;
/** Followers kept for one graph. The longest silent one makes room. */
export const SHARED_MEMORY_FOLLOWERS_PER_GRAPH_LIMIT = 64;
/** Graphs with followers kept at once. The one silent the longest makes room. */
export const SHARED_MEMORY_FOLLOWED_GRAPHS_LIMIT = 1024;

export interface SharedMemoryFollowersOptions {
  readonly ttlMs?: number;
  readonly perGraphLimit?: number;
  readonly graphLimit?: number;
  /** Defaults to `Date.now`; tests pass their own clock. */
  readonly now?: () => number;
}

export class SharedMemoryFollowers {
  /** Graph id to (peer id to the time of its last authorized request), both in insertion order. */
  readonly #byGraph = new Map<string, Map<string, number>>();
  readonly #ttlMs: number;
  readonly #perGraphLimit: number;
  readonly #graphLimit: number;
  readonly #now: () => number;

  constructor(options: SharedMemoryFollowersOptions = {}) {
    this.#ttlMs = options.ttlMs ?? SHARED_MEMORY_FOLLOWER_TTL_MS;
    this.#perGraphLimit = options.perGraphLimit ?? SHARED_MEMORY_FOLLOWERS_PER_GRAPH_LIMIT;
    this.#graphLimit = options.graphLimit ?? SHARED_MEMORY_FOLLOWED_GRAPHS_LIMIT;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Record that `peerId` asked for the shared memory of `contextGraphId` and
   * was authorized. The recipients of a share read the followers at the
   * moment of the share, so nothing else has to be told.
   */
  note(contextGraphId: string, peerId: string): void {
    const now = this.#now();
    let peers = this.#byGraph.get(contextGraphId);
    if (peers === undefined) {
      peers = new Map();
    } else {
      // Re-inserting moves both to the end: the first entry is always the one silent the longest.
      this.#byGraph.delete(contextGraphId);
      peers.delete(peerId);
    }
    peers.set(peerId, now);
    this.#byGraph.set(contextGraphId, peers);
    while (peers.size > this.#perGraphLimit) {
      peers.delete(peers.keys().next().value as string);
    }
    while (this.#byGraph.size > this.#graphLimit) {
      this.#byGraph.delete(this.#byGraph.keys().next().value as string);
    }
  }

  /** The peers whose last authorized request for the graph is within the TTL. */
  followers(contextGraphId: string): string[] {
    const peers = this.#byGraph.get(contextGraphId);
    if (peers === undefined) return [];
    const oldest = this.#now() - this.#ttlMs;
    for (const [peerId, lastSeen] of peers) {
      if (lastSeen >= oldest) break;
      peers.delete(peerId);
    }
    if (peers.size === 0) {
      this.#byGraph.delete(contextGraphId);
      return [];
    }
    return [...peers.keys()];
  }

  /** Graphs that currently have an entry; for tests and diagnostics. */
  get graphCount(): number {
    return this.#byGraph.size;
  }
}

/**
 * A peer asked this node to replay a graph's catalog heads. It follows the
 * graph when the request names the policy this node has accepted for it: the
 * peer then holds the same policy, and its receiver for the graph is active.
 * A request for a graph this node holds no policy for, or under another
 * policy, records nothing. Returns whether the peer was recorded.
 */
export function noteCatalogHeadReplayFollower(
  followers: SharedMemoryFollowers,
  acceptedPolicyDigest: string | undefined,
  request: { readonly contextGraphId: string; readonly policyDigest: string },
  peerId: string,
): boolean {
  if (acceptedPolicyDigest === undefined || acceptedPolicyDigest !== request.policyDigest) return false;
  followers.note(request.contextGraphId, peerId);
  return true;
}

const FOLLOWERS_BY_AGENT = new WeakMap<object, SharedMemoryFollowers>();

/**
 * The followers one agent knows. Kept beside the agent rather than on it: the
 * sync responder and the recipient enumerator are wired at different times,
 * and some hosts are built without the agent's own fields.
 */
export function sharedMemoryFollowersOf(agent: object): SharedMemoryFollowers {
  let followers = FOLLOWERS_BY_AGENT.get(agent);
  if (followers === undefined) {
    followers = new SharedMemoryFollowers();
    FOLLOWERS_BY_AGENT.set(agent, followers);
  }
  return followers;
}
