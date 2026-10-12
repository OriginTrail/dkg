// SPDX-License-Identifier: Apache-2.0
import { readSyncNotServable, type SyncNotServable, type SyncNotServableReason } from '../not-servable.js';

/** First hold after a peer could not serve a whole-graph sync of a graph. */
export const SYNC_PEER_GRAPH_HOLD_BASE_MS = 10 * 60_000;
/** The hold doubles with each consecutive refusal up to this cap. */
export const SYNC_PEER_GRAPH_HOLD_MAX_MS = 60 * 60_000;
/** A hold is lengthened by up to this fraction, never shortened. */
export const SYNC_PEER_GRAPH_HOLD_JITTER = 0.2;
const SYNC_PEER_GRAPH_HOLD_MAX_ENTRIES = 4_096;

export interface SyncPeerGraphHold {
  readonly peerId: string;
  readonly contextGraphId: string;
  readonly reason: SyncNotServableReason;
  /** Consecutive refusals; the graph has not synced from this peer in between. */
  readonly refusals: number;
  readonly heldUntil: number;
}

/**
 * Which graphs this node should not ask which peers for, for now.
 *
 * The reconciler's backoff is per peer: it cannot express "this peer serves
 * every graph but one", and it starts over whenever another graph syncs or the
 * connection changes. A peer that answers a whole-graph sync with "not
 * servable" (or whose store deadline ended the request) would give the same
 * answer to the same request, so that one graph is held for that one peer: the
 * hold doubles with each consecutive refusal up to a cap, the graph is asked
 * for again when it ends, and it clears once the graph syncs from that peer.
 * Other graphs of the peer and other peers of the graph are not affected.
 */
export class SyncPeerGraphHolds {
  private readonly entries = new Map<string, SyncPeerGraphHold>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(options: {
    now?: () => number;
    random?: () => number;
    baseMs?: number;
    maxMs?: number;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.baseMs = options.baseMs ?? SYNC_PEER_GRAPH_HOLD_BASE_MS;
    this.maxMs = options.maxMs ?? SYNC_PEER_GRAPH_HOLD_MAX_MS;
  }

  private key(peerId: string, contextGraphId: string): string {
    return `${peerId}\u0000${contextGraphId}`;
  }

  /**
   * The peer could not serve the graph. Returns the hold when this starts or
   * extends one, `undefined` when a hold is already in force: a reply to a
   * request that was in flight when the hold began is the same refusal.
   */
  refused(peerId: string, contextGraphId: string, reply: SyncNotServable): SyncPeerGraphHold | undefined {
    const key = this.key(peerId, contextGraphId);
    const at = this.now();
    const previous = this.entries.get(key);
    if (previous && at < previous.heldUntil) return undefined;
    const refusals = (previous?.refusals ?? 0) + 1;
    const own = Math.min(this.baseMs * 2 ** Math.min(refusals - 1, 30), this.maxMs);
    // The responder's own time left is honoured up to the cap, so a peer cannot
    // put a graph out of reach for longer than this node would by itself.
    const period = Math.min(Math.max(own, reply.retryAfterMs ?? 0), this.maxMs);
    const hold: SyncPeerGraphHold = {
      peerId,
      contextGraphId,
      reason: reply.reason,
      refusals,
      heldUntil: at + Math.ceil(period * (1 + this.random() * SYNC_PEER_GRAPH_HOLD_JITTER)),
    };
    this.entries.delete(key);
    this.entries.set(key, hold);
    this.prune(at);
    return hold;
  }

  /** The graph synced from the peer: nothing is remembered against it. */
  served(peerId: string, contextGraphId: string): void {
    this.entries.delete(this.key(peerId, contextGraphId));
  }

  /** The graphs among `contextGraphIds` held for this peer right now. */
  heldAmong(peerId: string, contextGraphIds: readonly string[]): string[] {
    if (this.entries.size === 0) return [];
    const at = this.now();
    return contextGraphIds.filter((contextGraphId) => {
      const hold = this.entries.get(this.key(peerId, contextGraphId));
      return hold !== undefined && at < hold.heldUntil;
    });
  }

  /** Holds in force, for diagnostics. */
  snapshot(): SyncPeerGraphHold[] {
    const at = this.now();
    return [...this.entries.values()].filter((hold) => at < hold.heldUntil);
  }

  private prune(at: number): void {
    // An ended hold is kept so the next refusal extends it; one that was not
    // followed by another attempt within a whole cap is forgotten.
    for (const [key, hold] of this.entries) {
      if (at >= hold.heldUntil + this.maxMs) this.entries.delete(key);
    }
    while (this.entries.size > SYNC_PEER_GRAPH_HOLD_MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

const holdsByOwner = new WeakMap<object, SyncPeerGraphHolds>();

/** The holds of one agent; they live as long as the agent object. */
export function syncPeerGraphHoldsFor(owner: object): SyncPeerGraphHolds {
  let holds = holdsByOwner.get(owner);
  if (!holds) {
    holds = new SyncPeerGraphHolds();
    holdsByOwner.set(owner, holds);
  }
  return holds;
}

export function describeSyncPeerGraphHold(hold: SyncPeerGraphHold, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((hold.heldUntil - now) / 60_000));
  return `Context graph "${hold.contextGraphId}" is not syncable from peer ${hold.peerId.slice(-8)} right now `
    + `(${hold.reason}, ${hold.refusals} in a row); asking again in about ${minutes} min`;
}

/**
 * Feed the outcome of one page fetch to the holds. Only a whole-graph durable
 * fetch says something about "this graph from this peer": a refusal starts or
 * extends the hold, a completed data phase clears it. The returned promise
 * never rejects, so observing a fetch every waiter has left is safe.
 */
export function observeSyncPageFetch(
  holds: SyncPeerGraphHolds,
  fetch: {
    readonly peerId: string;
    readonly contextGraphId: string;
    readonly phase: string;
    readonly wholeGraphDurable: boolean;
  },
  outcome: Promise<{ readonly completed: boolean }>,
  onHold: (hold: SyncPeerGraphHold) => void,
): Promise<void> {
  return outcome.then(
    (result) => {
      if (fetch.wholeGraphDurable && fetch.phase === 'data' && result.completed) {
        holds.served(fetch.peerId, fetch.contextGraphId);
      }
    },
    (error: unknown) => {
      if (!fetch.wholeGraphDurable) return;
      const reply = readSyncNotServable(error);
      const hold = reply && holds.refused(fetch.peerId, fetch.contextGraphId, reply);
      if (hold) onHold(hold);
    },
  );
}
