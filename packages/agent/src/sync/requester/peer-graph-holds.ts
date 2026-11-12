// SPDX-License-Identifier: Apache-2.0
import { readSyncNotServableReply, type SyncNotServable, type SyncNotServableReason } from '../not-servable.js';

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
  /** Which whole-graph fetch is held; see {@link syncPeerGraphHoldScope}. */
  readonly scope: string;
  readonly reason: SyncNotServableReason;
  /** Consecutive refusals; that fetch has not completed from this peer in between. */
  readonly refusals: number;
  readonly heldUntil: number;
}

/**
 * The fetches a hold applies to: a whole-graph durable walk of one phase,
 * either the full walk or the walk from a batch id. It mirrors what a responder
 * tells apart when it refuses a request, so a refused metadata walk does not
 * hold the data walk. Shared-memory sync, exact-asset fetches and recovery are
 * outside it (`undefined`).
 */
export function syncPeerGraphHoldScope(fetch: {
  readonly includeSharedMemory: boolean;
  readonly phase: string;
  readonly assetUals?: readonly string[];
  readonly recovery?: boolean;
  readonly sinceBatchId?: string;
}): string | undefined {
  if (fetch.includeSharedMemory || fetch.assetUals !== undefined || fetch.recovery === true) return undefined;
  return fetch.sinceBatchId === undefined ? fetch.phase : `${fetch.phase} from a batch id`;
}

/**
 * Which graphs this node should not ask which peers for, for now.
 *
 * The reconciler's backoff is per peer: it cannot express "this peer serves
 * every graph but one", and it starts over whenever another graph syncs or the
 * connection changes. A peer that answers a whole-graph sync with "not
 * servable" (or whose store deadline ended the request) would give the same
 * answer to the same request, so that one fetch is held for that one peer: the
 * hold doubles with each consecutive refusal up to a cap, the fetch is sent
 * again when it ends, and it clears once the fetch completes from that peer.
 * Other graphs of the peer and other peers of the graph are not affected.
 *
 * The hold is enforced where every such fetch passes, the page fetch itself:
 * while it is in force the fetch fails at once with
 * {@link SyncPeerGraphHeldError}, without a request, so each caller's own
 * failure handling applies and no caller has to know about holds.
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

  private key(peerId: string, contextGraphId: string, scope: string): string {
    return `${peerId}\u0000${scope}\u0000${contextGraphId}`;
  }

  /**
   * The peer could not serve the fetch. Returns the hold when this starts or
   * extends one, `undefined` when a hold is already in force: a reply to a
   * request that was in flight when the hold began is the same refusal.
   */
  refused(
    peerId: string,
    contextGraphId: string,
    scope: string,
    reply: SyncNotServable,
  ): SyncPeerGraphHold | undefined {
    const key = this.key(peerId, contextGraphId, scope);
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
      scope,
      reason: reply.reason,
      refusals,
      heldUntil: at + Math.ceil(period * (1 + this.random() * SYNC_PEER_GRAPH_HOLD_JITTER)),
    };
    this.entries.delete(key);
    this.entries.set(key, hold);
    this.prune(at);
    return hold;
  }

  /** The fetch completed from the peer: nothing is remembered against it. */
  served(peerId: string, contextGraphId: string, scope: string): void {
    this.entries.delete(this.key(peerId, contextGraphId, scope));
  }

  /** The hold in force for this fetch right now, if any. */
  current(peerId: string, contextGraphId: string, scope: string): SyncPeerGraphHold | undefined {
    if (this.entries.size === 0) return undefined;
    const hold = this.entries.get(this.key(peerId, contextGraphId, scope));
    return hold !== undefined && this.now() < hold.heldUntil ? hold : undefined;
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
  return `Context graph "${hold.contextGraphId}" (${hold.scope}) is not syncable from peer ${hold.peerId.slice(-8)} `
    + `right now (${hold.reason}, ${hold.refusals} in a row); asking again in about ${minutes} min`;
}

/**
 * A fetch that was not sent because its hold is in force. It is this node's own
 * decision, not a failure of the peer or of the transport, and it is worded so
 * that nothing classifies it as either.
 */
export class SyncPeerGraphHeldError extends Error {
  constructor(readonly hold: SyncPeerGraphHold, now = Date.now()) {
    super(`not sent: ${describeSyncPeerGraphHold(hold, now)}`);
    this.name = 'SyncPeerGraphHeldError';
  }
}

/**
 * Feed the outcome of one page fetch to the holds. Only a fetch with a hold
 * scope says something about "this graph from this peer": a refusal starts or
 * extends the hold, a completed walk clears it. The returned promise never
 * rejects, so observing a fetch every waiter has left is safe.
 */
export function observeSyncPageFetch(
  holds: SyncPeerGraphHolds,
  fetch: {
    readonly peerId: string;
    readonly contextGraphId: string;
    /** From {@link syncPeerGraphHoldScope}; `undefined` for a fetch holds do not apply to. */
    readonly scope: string | undefined;
  },
  outcome: Promise<{ readonly completed: boolean }>,
  onHold: (hold: SyncPeerGraphHold) => void,
): Promise<void> {
  const { scope } = fetch;
  if (scope === undefined) return outcome.then(() => {}, () => {});
  return outcome.then(
    (result) => {
      if (result.completed) holds.served(fetch.peerId, fetch.contextGraphId, scope);
    },
    (error: unknown) => {
      const reply = readSyncNotServableReply(error);
      const hold = reply && holds.refused(fetch.peerId, fetch.contextGraphId, scope, reply);
      if (hold) onHold(hold);
    },
  ).catch(() => {
    // Reporting a hold must not turn an observed fetch into an unhandled rejection.
  });
}
