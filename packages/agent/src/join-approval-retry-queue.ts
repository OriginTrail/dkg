import { RetryQueue, type RetryEntry } from '@origintrail-official/dkg-core';

/**
 * In-memory retry queue for `join-approved` P2P notifications.
 *
 * Background
 * ----------
 * When a curator approves a join request via `DKGAgent.approveJoinRequest`,
 * three things happen, in order:
 *
 *   1. The pending join-request row is flipped from `pending` → `approved`
 *      in the curator's local store.
 *   2. The agent + its delegatee identifiers are written into the context
 *      graph's allowlist (`inviteAgentToContextGraph`). All local.
 *   3. A `join-approved` notification is fired over libp2p to the
 *      invitee's peer (`notifyJoinApproval` → `deliverPrivateJoinNotification`).
 *      This is the ONLY step that crosses the wire to the invitee.
 *
 * Until very recently, step 3 was a best-effort one-shot send: any transient
 * transport failure (relay reset, NAT mapping flap, the invitee's daemon
 * restarting in the brief window between request acceptance and approval
 * delivery) silently dropped the notification. The invitee then has no way
 * to recover on their own — without the `join-approved` message they don't
 * know the curator has acted, and the curator-side delegation alone is not
 * enough: the invitee's own sync attempts can't succeed until they know to
 * pull from the curator using the delegation peer/key the curator just
 * recorded.
 *
 * This queue is the durable retry layer that turns step 3 from "fire once
 * and pray" into "fire, and if the wire drops, keep trying for up to
 * `maxAgeMs` with exponential backoff, opportunistically retrying on every
 * direct re-connect from the invitee's peer". It is intentionally
 * self-contained and pure (no I/O, no clocks, no libp2p dependencies) so
 * its semantics are easy to test in isolation and the call sites in
 * `DKGAgent` stay small.
 *
 * Implementation
 * --------------
 * Thin domain-typed shim over the generic `RetryQueue<TPayload>` primitive
 * in `@origintrail-official/dkg-core`. The shim's job is key derivation
 * (`${cg}::${agent.toLowerCase()}`) and method-name aliasing
 * (`enqueueFailure(cg, agent, ...)` instead of the generic
 * `enqueueFailure(key, payload, ...)`). All retry mechanics — backoff
 * ladder, age-bounded expiry, due-check, mutation semantics — live in
 * the generic class.
 *
 * Sharing the generic primitive matters because the same retry shape
 * applies to other one-shot P2P sends in the system (notably the
 * upcoming invitee-side substrate Messenger outbox for `dkg_send_message` failures,
 * which has the symmetric failure mode of join-approval — see chat
 * thread on PR #510 / issue #518 for the joint design notes).
 */

/** Domain payload retained per pending `(cg, agent)` approval. */
export interface JoinApprovalPayload {
  /** Context graph the approval is for. */
  contextGraphId: string;
  /** Agent address being notified. Preserves caller's case for log readability. */
  agentAddress: string;
}

/**
 * A single `(contextGraphId, agentAddress)` approval delivery pending
 * retry. Domain payload fields live directly on the entry alongside
 * the queue-owned retry metadata (no nested `.payload`), preserving the
 * shape used by `DKGAgent` since this queue's introduction in PR #510.
 */
export type JoinApprovalRetryEntry = RetryEntry<JoinApprovalPayload>;

export interface JoinApprovalRetryQueueOptions {
  /**
   * Backoff ladder in milliseconds. `attempts=1` (first failure) uses
   * `backoffs[0]`, `attempts=N` uses `backoffs[min(N-1, backoffs.length-1)]`.
   * Must be non-empty.
   */
  backoffs?: readonly number[];
  /**
   * Max age (ms) from `firstFailureAt` before an entry is dropped. Default
   * 24h. `dropExpired(now)` is what actually evicts.
   */
  maxAgeMs?: number;
}

/** Default backoff ladder: 10s, 30s, 90s, 5m, 15m, 1h, 4h, 12h. */
export const DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS: readonly number[] = [
  10_000,
  30_000,
  90_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** Default max retry age: 24h since first failure. */
export const DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function joinApprovalRetryKey(contextGraphId: string, agentAddress: string): string {
  return `${contextGraphId}::${agentAddress.toLowerCase()}`;
}

export class JoinApprovalRetryQueue {
  private readonly queue: RetryQueue<JoinApprovalPayload>;

  constructor(options: JoinApprovalRetryQueueOptions = {}) {
    this.queue = new RetryQueue<JoinApprovalPayload>({
      backoffs: options.backoffs ?? DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS,
    });
  }

  /**
   * Mark a `(cg, agent)` delivery as failed. Creates a new entry on first
   * failure, bumps `attempts` and reschedules `nextAttemptAt` on subsequent
   * failures. Returns the resulting entry so the caller can log it.
   */
  enqueueFailure(
    contextGraphId: string,
    agentAddress: string,
    error: string,
    now: number,
  ): JoinApprovalRetryEntry {
    return this.queue.enqueueFailure(
      joinApprovalRetryKey(contextGraphId, agentAddress),
      { contextGraphId, agentAddress },
      error,
      now,
    );
  }

  /**
   * Mark a `(cg, agent)` delivery as successful and drop any pending retry
   * for it. Returns `true` when an entry was actually removed.
   */
  markDelivered(contextGraphId: string, agentAddress: string): boolean {
    return this.queue.markDelivered(joinApprovalRetryKey(contextGraphId, agentAddress));
  }

  /** Return all entries whose `nextAttemptAt` is at or before `now`. */
  due(now: number): JoinApprovalRetryEntry[] {
    return this.queue.due(now);
  }

  /**
   * Drop every entry whose `firstFailureAt` is older than `maxAgeMs` from
   * `now`. Returns the dropped entries so the caller can log them.
   */
  dropExpired(now: number): JoinApprovalRetryEntry[] {
    return this.queue.dropExpired(now);
  }

  /** Get the entry for a `(cg, agent)` pair if any. */
  getEntry(contextGraphId: string, agentAddress: string): JoinApprovalRetryEntry | undefined {
    return this.queue.getEntry(joinApprovalRetryKey(contextGraphId, agentAddress));
  }

  /** Snapshot of all entries for diagnostics. */
  list(): JoinApprovalRetryEntry[] {
    return this.queue.list();
  }

  /** Number of entries currently queued. */
  size(): number {
    return this.queue.size();
  }

  /** Drop everything (for shutdown / tests). */
  clear(): void {
    this.queue.clear();
  }
}
