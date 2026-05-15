/**
 * Generic in-memory retry queue with exponential backoff and age-based
 * expiry.
 *
 * Background
 * ----------
 * Several DKG transports have the same failure shape: a one-shot wire
 * send that, on a transient transport error, silently drops the request
 * with no recovery loop. Examples found while bringing up the agent-to-
 * agent debug channel (PR #510):
 *
 *   * Curator-side `notifyJoinApproval` (the original case — fixed by
 *     wiring `JoinApprovalRetryQueue` into `DKGAgent` in PR #510).
 *   * Invitee-side `dkg_send_message` chat sends (symmetric failure
 *     discovered during two-laptop testing — Miles' `MessageOutbox`
 *     follow-up will use this same primitive).
 *
 * Both want: persistent across retries, age-bounded, exponentially backed
 * off, opportunistically retried when the recipient becomes reachable
 * again (`connection:open`), and operator-inspectable (via diagnostic
 * HTTP routes).
 *
 * `RetryQueue<TPayload>` is the shared primitive. Specific call sites
 * wrap it with a domain-typed surface (key derivation, semantic method
 * names) — see `JoinApprovalRetryQueue` in `@origintrail-official/dkg-agent`
 * for the reference specialization.
 *
 * Design notes
 * ------------
 *
 *   * Keying. Entries are keyed by a caller-supplied `string`. The queue
 *     does not derive keys itself — callers are expected to wrap with a
 *     domain-typed shim that converts their natural (multi-field) key
 *     into a canonical string. Keeping the key opaque to the queue keeps
 *     the storage shape uniform across very different payload types.
 *
 *   * Entry shape. `RetryEntry<TPayload>` is the intersection
 *     `TPayload & RetryMetadata`. The payload's fields live directly on
 *     the entry (not nested under `.payload`), so consumers can access
 *     `entry.someDomainField` and `entry.attempts` uniformly without
 *     extra plumbing. The trade-off is that payload field names must
 *     not collide with retry-metadata field names (`attempts`,
 *     `firstFailureAt`, `lastAttemptAt`, `nextAttemptAt`, `lastError`).
 *     This matches how the original `JoinApprovalRetryEntry` was shaped
 *     before the factor-out, so existing call sites in `DKGAgent` keep
 *     working byte-identically.
 *
 *   * Backoff. Configurable backoff array, used as `backoffs[min(attempts-1,
 *     last)]`. There is no default backoff — callers must supply one,
 *     because the right ladder depends entirely on the call site's
 *     failure characteristics (a 10s→...→12h ladder makes sense for
 *     join-approvals where the operator might be away from the laptop,
 *     but a chat-outbox might want something tighter for caller-visible
 *     UX). See `DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS` in
 *     `@origintrail-official/dkg-agent` for an example.
 *
 *   * Expiry. Entries older than `maxAgeMs` (since the FIRST failure)
 *     are dropped on the next `dropExpired()` tick. The dropped entries
 *     are returned so the caller can log them — useful diagnostic when
 *     a peer never comes back and the operator wants to know "did we
 *     ever give up on this?".
 *
 *   * Clock injection. All `nextAttemptAt` / `firstFailureAt` values are
 *     supplied by the caller as plain numbers, so tests can drive the
 *     queue with deterministic timestamps. The queue itself never calls
 *     `Date.now()`.
 *
 *   * In-memory only. By design, for now — see the persistence follow-up
 *     issue OriginTrail/dkg#518 which lifts a `RetryQueueStorage<TPayload>`
 *     port into this class so both queues get SQLite-backed durability
 *     in one place. The current in-memory shape is intentionally small
 *     so the persistence retrofit is a localized change.
 */

/**
 * Retry-tracking fields attached to every entry alongside the caller's
 * domain payload. The queue owns these; the caller owns the payload.
 */
export interface RetryMetadata {
  /** Number of delivery attempts made so far (every attempt that failed). */
  attempts: number;
  /** Timestamp (ms since epoch) of the first failed attempt. Used for `maxAgeMs` expiry. */
  firstFailureAt: number;
  /** Timestamp (ms since epoch) of the most recent failed attempt. */
  lastAttemptAt: number;
  /** Timestamp (ms since epoch) at which the next attempt is due. */
  nextAttemptAt: number;
  /** Short string describing the last failure (for logs + diagnostics). */
  lastError: string;
}

/**
 * A single retry entry. Combines the caller-supplied payload (domain
 * data needed to redo the operation) with the queue-owned retry
 * metadata. Field names from `TPayload` and `RetryMetadata` must not
 * collide.
 */
export type RetryEntry<TPayload extends object> = TPayload & RetryMetadata;

export interface RetryQueueOptions {
  /**
   * Backoff ladder in milliseconds. `attempts=1` (first failure) uses
   * `backoffs[0]`, `attempts=N` uses `backoffs[min(N-1, backoffs.length-1)]`.
   * Must be non-empty.
   */
  backoffs: readonly number[];
  /**
   * Max age (ms) from `firstFailureAt` before an entry is dropped.
   * `dropExpired(now)` is what actually evicts.
   */
  maxAgeMs: number;
}

export class RetryQueue<TPayload extends object> {
  private readonly entries = new Map<string, RetryEntry<TPayload>>();
  private readonly backoffs: readonly number[];
  private readonly maxAgeMs: number;

  constructor(options: RetryQueueOptions) {
    if (options.backoffs.length === 0) {
      throw new Error('RetryQueue: backoffs must be non-empty');
    }
    this.backoffs = options.backoffs;
    this.maxAgeMs = options.maxAgeMs;
  }

  /**
   * Mark a delivery as failed. Creates a new entry on first failure for
   * this key, bumps `attempts` and reschedules `nextAttemptAt` on
   * subsequent failures with the same key. Returns the resulting entry
   * so the caller can log it.
   *
   * On repeat failures the existing entry is mutated in place (so any
   * outstanding reference held by the caller stays live and reflects
   * the current state); the payload fields are NOT overwritten with the
   * new payload arg, because the existing entry already represents the
   * authoritative state for this key. If the caller needs to update
   * payload data on retry (uncommon — normally the retry payload is
   * stable per key) they should `markDelivered` + `enqueueFailure`
   * explicitly.
   */
  enqueueFailure(key: string, payload: TPayload, error: string, now: number): RetryEntry<TPayload> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.attempts += 1;
      existing.lastAttemptAt = now;
      existing.nextAttemptAt = now + this.backoffFor(existing.attempts);
      existing.lastError = error;
      return existing;
    }
    const entry: RetryEntry<TPayload> = {
      ...payload,
      attempts: 1,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt: now + this.backoffFor(1),
      lastError: error,
    } as RetryEntry<TPayload>;
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Mark a delivery as successful and drop any pending retry for its
   * key. Returns `true` when an entry was actually removed.
   */
  markDelivered(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Return all entries whose `nextAttemptAt` is at or before `now`. */
  due(now: number): RetryEntry<TPayload>[] {
    const out: RetryEntry<TPayload>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.nextAttemptAt <= now) out.push(entry);
    }
    return out;
  }

  /**
   * Drop every entry whose `firstFailureAt` is older than `maxAgeMs`
   * from `now`. Returns the dropped entries so the caller can log them.
   */
  dropExpired(now: number): RetryEntry<TPayload>[] {
    const dropped: RetryEntry<TPayload>[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailureAt > this.maxAgeMs) {
        dropped.push(entry);
        this.entries.delete(key);
      }
    }
    return dropped;
  }

  /** Get the entry for a key if any. Returns the live reference. */
  getEntry(key: string): RetryEntry<TPayload> | undefined {
    return this.entries.get(key);
  }

  /**
   * Snapshot of all entries for diagnostics. Returns shallow copies so
   * the caller can mutate them without affecting queue state.
   */
  list(): RetryEntry<TPayload>[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  /** Number of entries currently queued. */
  size(): number {
    return this.entries.size;
  }

  /** Drop everything (for shutdown / tests). */
  clear(): void {
    this.entries.clear();
  }

  private backoffFor(attempts: number): number {
    const idx = Math.min(Math.max(attempts - 1, 0), this.backoffs.length - 1);
    return this.backoffs[idx];
  }
}
