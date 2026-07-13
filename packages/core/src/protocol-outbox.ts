/**
 * Generic, protocol-agnostic, store-backed retry outbox for short
 * peer-to-peer messages. The Universal Messenger substrate's
 * sender-side reliability primitive (rc.9 plan PR-1).
 *
 * Generalises `packages/agent/src/message-outbox.ts` (chat-specific,
 * in-memory) into:
 *
 *   - **protocol-agnostic** — keyed by `(peer, protocol, messageId)`
 *     so a single instance serves every Messenger-routed protocol.
 *
 *   - **store-backed** — composes any `ProtocolOutboxStore` (in-memory
 *     `InMemoryProtocolOutboxStore` for tests; SQLite-backed
 *     `SqliteProtocolOutboxStore` for the daemon, defined in
 *     `packages/node-ui/src/db.ts`). Adds inflight-lock + backoff +
 *     prune logic on top of the raw storage primitive.
 *
 *   - **stale-snapshot-safe** — preserves the `hasEntry` guard from
 *     PR #538 (rc9 outbox-dup fix). Generalised as a contract test
 *     the substrate must pass: between `tryBeginAttempt` and the
 *     wire send, the caller MUST re-check `hasEntry` because a
 *     sibling flush may have completed delivery during the interleave.
 *
 * The class itself is pure plumbing — no I/O, no clocks. All
 * `now: number` values are supplied by the caller so tests can drive
 * deterministic timestamps. The actual wire I/O lives in
 * `Messenger.sendToPeer` (PR-2); this class just stores + schedules.
 */

import type {
  CompatibleProtocolOutboxStore,
  IdempotencyCheckResult,
  MessageDirection,
  MessageIdempotencyStore,
  LegacyProtocolOutboxStore,
  ProtocolOutboxEntry,
  ProtocolOutboxMetadata,
  ProtocolOutboxStore,
} from './messenger-types.js';
import { RESPONSE_CACHE_BYTES } from './messenger-types.js';

export interface ProtocolOutboxOptions {
  /**
   * Backoff ladder in milliseconds. `attempts = 1` (first failure)
   * uses `backoffs[0]`, `attempts = N` uses
   * `backoffs[min(N-1, backoffs.length-1)]`. Must be non-empty.
   *
   * Defaults to `DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS` (5s → 2h ladder,
   * matched to chat's pre-substrate ladder so the substrate doesn't
   * regress timing on chat retries).
   */
  backoffs?: readonly number[];
  /**
   * Max age (ms) from `firstFailureAt` before an entry is dropped on
   * the next `dropExpired(now)` call. Defaults to 24h.
   */
  maxAgeMs?: number;
}

/**
 * Default backoff ladder for the Universal Messenger outbox. Matches
 * the chat-specific ladder from `packages/agent/src/message-outbox.ts`
 * (5s → 15s → 30s → 60s → 5m → 30m → 2h) so the chat pilot migration
 * in PR-3 preserves the same retry timing the rc9 soak validated.
 *
 * Tighter ladders (e.g. for interactive callers) or looser ladders
 * (e.g. for storage-ack fan-out) can override per-instance via
 * `ProtocolOutboxOptions.backoffs`.
 */
export const DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS: readonly number[] = [
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

/** Default max retry age: 24h since first failure. */
export const DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function inflightKey(peer: string, protocol: string, messageId: string): string {
  return `${peer}\x00${protocol}\x00${messageId}`;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneOutboxEntry(entry: ProtocolOutboxEntry): ProtocolOutboxEntry {
  return { ...entry, payload: cloneBytes(entry.payload) };
}

function cloneOutboxMetadata(entry: ProtocolOutboxMetadata): ProtocolOutboxMetadata {
  const {
    peer,
    protocol,
    messageId,
    attempts,
    firstFailureAt,
    lastAttemptAt,
    nextAttemptAt,
    lastError,
  } = entry;
  return {
    peer,
    protocol,
    messageId,
    attempts,
    firstFailureAt,
    lastAttemptAt,
    nextAttemptAt,
    lastError,
  };
}

function compareDueEntries(a: ProtocolOutboxEntry, b: ProtocolOutboxEntry): number {
  return a.nextAttemptAt - b.nextAttemptAt
    || a.firstFailureAt - b.firstFailureAt
    || a.peer.localeCompare(b.peer)
    || a.protocol.localeCompare(b.protocol)
    || a.messageId.localeCompare(b.messageId);
}

function comparePendingEntries(a: ProtocolOutboxEntry, b: ProtocolOutboxEntry): number {
  return a.firstFailureAt - b.firstFailureAt
    || a.protocol.localeCompare(b.protocol)
    || a.messageId.localeCompare(b.messageId);
}

function normalizeDuePageLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.floor(limit));
}

interface ProtocolOutboxStorePolicy extends ProtocolOutboxOptions {
  backoffFor: (attempts: number) => number;
}

type PolicyAwareProtocolOutboxStore = CompatibleProtocolOutboxStore & {
  configurePolicy?: (policy: ProtocolOutboxStorePolicy) => void;
};

/**
 * Keep compatibility at the constructor boundary. Internally the outbox only
 * sees the current metadata + boolean peer-presence contract, while legacy
 * stores are adapted once with all method receivers preserved.
 */
function normalizeOutboxStore(store: CompatibleProtocolOutboxStore): ProtocolOutboxStore {
  const normalized: ProtocolOutboxStore = {
    enqueue: store.enqueue.bind(store),
    markDelivered: store.markDelivered.bind(store),
    hasEntry: store.hasEntry.bind(store),
    due: store.due.bind(store),
    dropExpired: store.dropExpired.bind(store),
    dropExpiredMetadata: store.dropExpiredMetadata
      ? store.dropExpiredMetadata.bind(store)
      : (now) => store.dropExpired(now).map(cloneOutboxMetadata),
    size: store.size.bind(store),
    list: store.list.bind(store),
    listMetadata: store.listMetadata
      ? store.listMetadata.bind(store)
      : () => store.list().map(cloneOutboxMetadata),
    getEntry: store.getEntry.bind(store),
    hasPendingFor: store.hasPendingFor
      ? store.hasPendingFor.bind(store)
      : (peer) => (store as LegacyProtocolOutboxStore).pendingFor(peer).length > 0,
  };
  if (store.duePage) normalized.duePage = store.duePage.bind(store);
  if (store.pendingFor) normalized.pendingFor = store.pendingFor.bind(store);
  return normalized;
}

export class ProtocolOutbox {
  private readonly store: ProtocolOutboxStore;
  private readonly backoffs: readonly number[];
  /**
   * Per-key inflight set to prevent concurrent retry attempts for the
   * same `(peer, protocol, messageId)`. Overlapping scheduler callers or
   * another explicit sender can otherwise interleave around a stale due
   * snapshot and duplicate the same wire attempt.
   *
   * `tryBeginAttempt` is an atomic check-and-set: the second
   * concurrent attempter sees `false` and exits without dialing.
   *
   * Lifted into the generic substrate from `MessageOutbox` (rc9 #521
   * fix); the in-memory set is per-process — daemon restart resets
   * it, which is fine because all in-flight sends die with the
   * process anyway and the persistent outbox itself survives.
   */
  private readonly inflight = new Set<string>();

  constructor(store: CompatibleProtocolOutboxStore, options: ProtocolOutboxOptions = {}) {
    const backoffs = options.backoffs ?? DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS;
    if (backoffs.length === 0) {
      throw new Error('ProtocolOutbox: backoffs must be non-empty');
    }
    this.backoffs = backoffs;
    (store as PolicyAwareProtocolOutboxStore).configurePolicy?.({
      backoffs,
      maxAgeMs: options.maxAgeMs ?? DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
      backoffFor: (attempts) => this.backoffFor(attempts),
    });
    this.store = normalizeOutboxStore(store);
  }

  /**
   * Atomic check-and-set for the per-key inflight guard. Returns
   * `true` if the caller now owns the in-flight slot and should
   * proceed with the wire send; returns `false` if another caller is
   * already attempting it and the current caller should exit.
   *
   * MUST be paired with `endAttempt(...)` in a try/finally — leaking
   * an inflight entry would permanently block future retries for
   * that key.
   */
  tryBeginAttempt(peer: string, protocol: string, messageId: string): boolean {
    const key = inflightKey(peer, protocol, messageId);
    if (this.inflight.has(key)) return false;
    this.inflight.add(key);
    return true;
  }

  /** Release the per-key inflight slot. Idempotent. */
  endAttempt(peer: string, protocol: string, messageId: string): void {
    this.inflight.delete(inflightKey(peer, protocol, messageId));
  }

  /**
   * Enqueue a failed send. First failure creates the entry with
   * `attempts = 1`; subsequent failures bump `attempts` and reschedule
   * `nextAttemptAt = now + backoff(attempts)`. Returns the resulting
   * entry so the caller can surface delivery-state to the application.
   */
  enqueueFailure(
    peer: string,
    protocol: string,
    messageId: string,
    payload: Uint8Array,
    error: string,
    now: number,
  ): ProtocolOutboxEntry {
    return this.store.enqueue(peer, protocol, messageId, payload, error, now);
  }

  /**
   * Mark an entry as successfully delivered and remove it from the
   * outbox. Returns `true` when an entry was actually removed.
   *
   * Callers MUST also call `endAttempt(...)` (via the try/finally
   * pattern) to release the inflight slot — this method only touches
   * the persistent store.
   */
  markDelivered(peer: string, protocol: string, messageId: string): boolean {
    return this.store.markDelivered(peer, protocol, messageId);
  }

  /**
   * Whether an entry for `(peer, protocol, messageId)` is still in
   * the outbox. The stale-snapshot guard (rc9 #538): between
   * `tryBeginAttempt` and the wire send, a sibling flush may have
   * completed delivery + called `markDelivered`. Callers MUST check
   * `hasEntry` immediately before the wire send and skip if `false`.
   * The generic substrate's contract test verifies this.
   */
  hasEntry(peer: string, protocol: string, messageId: string): boolean {
    return this.store.hasEntry(peer, protocol, messageId);
  }

  /** All due entries in deterministic retry order. */
  due(now: number): ProtocolOutboxEntry[] {
    return this.duePage(now);
  }

  /**
   * Return a canonical retry page while preserving legacy `due(now)` stores.
   * Stores may opt into the bounded fast path; the fallback sorts before it
   * caps so an older store cannot bypass either the order or the batch bound.
   */
  duePage(now: number, limit?: number): ProtocolOutboxEntry[] {
    const normalizedLimit = normalizeDuePageLimit(limit);
    if (normalizedLimit === 0) return [];

    const snapshot = normalizedLimit !== undefined && this.store.duePage
      ? this.store.duePage(now, normalizedLimit)
      : this.store.due(now);
    const ordered = [...snapshot].sort(compareDueEntries);
    return normalizedLimit === undefined ? ordered : ordered.slice(0, normalizedLimit);
  }

  hasPendingFor(peer: string): boolean {
    return this.store.hasPendingFor(peer);
  }

  /**
   * Compatibility/diagnostic snapshot for a peer. This does not participate in
   * retry selection; scheduled drains remain exclusively `duePage`-driven.
   */
  pendingFor(peer: string): ProtocolOutboxEntry[] {
    const pendingFor = this.store.pendingFor;
    const snapshot = pendingFor
      ? pendingFor.call(this.store, peer)
      : this.store.list().filter((entry) => entry.peer === peer);
    return [...snapshot].sort(comparePendingEntries).map(cloneOutboxEntry);
  }

  /** Drop entries older than the store's configured max-age. */
  dropExpired(now: number): ProtocolOutboxEntry[] {
    return this.store.dropExpired(now);
  }

  /** Metadata-only expiration, with a compatibility fallback for legacy stores. */
  dropExpiredMetadata(now: number): ProtocolOutboxMetadata[] {
    return this.store.dropExpiredMetadata(now).map(cloneOutboxMetadata);
  }

  /** Total entries currently queued. */
  size(): number {
    return this.store.size();
  }

  /**
   * Snapshot of every full entry currently in the underlying store.
   * Returns entries in store order; callers that need per-peer FIFO
   * should sort by `firstFailureAt`.
   */
  list(): ProtocolOutboxEntry[] {
    return this.store.list();
  }

  /** Metadata-only diagnostics snapshot, with a compatibility fallback. */
  listMetadata(): ProtocolOutboxMetadata[] {
    return this.store.listMetadata().map(cloneOutboxMetadata);
  }

  /**
   * Look up a single entry. Used by diagnostics + by stale-snapshot
   * guards. Returns `undefined` if no such entry exists.
   */
  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined {
    return this.store.getEntry(peer, protocol, messageId);
  }

  /** Compute backoff for a given attempt count. Exposed for testing. */
  backoffFor(attempts: number): number {
    const idx = Math.min(Math.max(attempts - 1, 0), this.backoffs.length - 1);
    return this.backoffs[idx];
  }
}

/**
 * Reference in-memory implementation of `ProtocolOutboxStore`. Used
 * by tests + by the substrate before the SQLite-backed store is
 * wired in `lifecycle.ts` (PR-2). The SQLite-backed implementation
 * lives in `packages/node-ui/src/db.ts` and has the same semantics
 * — this class exists as the executable spec for the contract.
 *
 * Implements the same backoff ladder the wrapper `ProtocolOutbox`
 * uses so the test fixture is self-contained.
 */
export class InMemoryProtocolOutboxStore implements ProtocolOutboxStore {
  private readonly entries = new Map<string, ProtocolOutboxEntry>();
  private backoffs: readonly number[] = DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS;
  private maxAgeMs = DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS;

  constructor(options: ProtocolOutboxOptions = {}) {
    this.configurePolicy(options);
  }

  private static key(peer: string, protocol: string, messageId: string): string {
    return `${peer}\x00${protocol}\x00${messageId}`;
  }

  private backoffFor(attempts: number): number {
    const idx = Math.min(Math.max(attempts - 1, 0), this.backoffs.length - 1);
    return this.backoffs[idx];
  }

  configurePolicy(options: ProtocolOutboxOptions = {}): void {
    const backoffs = options.backoffs ?? this.backoffs;
    if (backoffs.length === 0) {
      throw new Error('ProtocolOutbox: backoffs must be non-empty');
    }
    this.backoffs = backoffs;
    this.maxAgeMs = options.maxAgeMs ?? this.maxAgeMs;
  }

  enqueue(
    peer: string,
    protocol: string,
    messageId: string,
    payload: Uint8Array,
    error: string,
    now: number,
  ): ProtocolOutboxEntry {
    const key = InMemoryProtocolOutboxStore.key(peer, protocol, messageId);
    const existing = this.entries.get(key);
    if (existing) {
      existing.attempts += 1;
      existing.lastAttemptAt = now;
      existing.nextAttemptAt = now + this.backoffFor(existing.attempts);
      existing.lastError = error;
      return cloneOutboxEntry(existing);
    }
    const entry: ProtocolOutboxEntry = {
      peer,
      protocol,
      messageId,
      payload: cloneBytes(payload),
      attempts: 1,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt: now + this.backoffFor(1),
      lastError: error,
    };
    this.entries.set(key, entry);
    return cloneOutboxEntry(entry);
  }

  markDelivered(peer: string, protocol: string, messageId: string): boolean {
    return this.entries.delete(InMemoryProtocolOutboxStore.key(peer, protocol, messageId));
  }

  hasEntry(peer: string, protocol: string, messageId: string): boolean {
    return this.entries.has(InMemoryProtocolOutboxStore.key(peer, protocol, messageId));
  }

  hasPendingFor(peer: string): boolean {
    return Array.from(this.entries.values()).some((entry) => entry.peer === peer);
  }

  pendingFor(peer: string): ProtocolOutboxEntry[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.peer === peer)
      .sort((a, b) => a.firstFailureAt - b.firstFailureAt)
      .map(cloneOutboxEntry);
  }

  due(now: number): ProtocolOutboxEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.nextAttemptAt <= now)
      .sort(compareDueEntries)
      .map(cloneOutboxEntry);
  }

  duePage(now: number, limit: number): ProtocolOutboxEntry[] {
    return this.due(now).slice(0, limit);
  }

  dropExpired(now: number): ProtocolOutboxEntry[] {
    const dropped: ProtocolOutboxEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailureAt > this.maxAgeMs) {
        dropped.push(cloneOutboxEntry(entry));
        this.entries.delete(key);
      }
    }
    return dropped;
  }

  dropExpiredMetadata(now: number): ProtocolOutboxMetadata[] {
    const dropped: ProtocolOutboxMetadata[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailureAt > this.maxAgeMs) {
        dropped.push(cloneOutboxMetadata(entry));
        this.entries.delete(key);
      }
    }
    return dropped;
  }

  size(): number {
    return this.entries.size;
  }

  list(): ProtocolOutboxEntry[] {
    return Array.from(this.entries.values()).map(cloneOutboxEntry);
  }

  listMetadata(): ProtocolOutboxMetadata[] {
    return Array.from(this.entries.values()).map(cloneOutboxMetadata);
  }

  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined {
    const entry = this.entries.get(InMemoryProtocolOutboxStore.key(peer, protocol, messageId));
    return entry ? cloneOutboxEntry(entry) : undefined;
  }
}

/**
 * Reference in-memory implementation of `MessageIdempotencyStore`.
 * Same role as `InMemoryProtocolOutboxStore` — executable spec for
 * tests + a fallback the substrate can use before the SQLite-backed
 * store is wired.
 */

interface IdempotencyRecord {
  responseBlob: Uint8Array | undefined;
  ts: number;
}

export class InMemoryMessageIdempotencyStore implements MessageIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  /**
   * Clock used for `ts` values. Default `Date.now()`; tests can
   * override via the options for determinism. Mirrors the
   * SQLite-backed store, which stamps `ts = now` at record time.
   */
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  private static key(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
  ): string {
    return `${peer}\x00${protocol}\x00${messageId}\x00${direction}`;
  }

  check(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
  ): IdempotencyCheckResult {
    const rec = this.records.get(InMemoryMessageIdempotencyStore.key(peer, protocol, messageId, direction));
    if (!rec) return { seen: false };
    return rec.responseBlob !== undefined
      ? { seen: true, cachedResponse: cloneBytes(rec.responseBlob) }
      : { seen: true };
  }

  record(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
    response?: Uint8Array,
  ): void {
    const key = InMemoryMessageIdempotencyStore.key(peer, protocol, messageId, direction);
    if (this.records.has(key)) {
      // Idempotent re-record: no-op (matches SQLite ON CONFLICT DO NOTHING).
      return;
    }
    const blob =
      response !== undefined && response.length <= RESPONSE_CACHE_BYTES
        ? cloneBytes(response)
        : undefined;
    this.records.set(key, { responseBlob: blob, ts: this.clock() });
  }

  pruneOlderThan(tsMs: number): number {
    let dropped = 0;
    for (const [key, rec] of this.records) {
      if (rec.ts < tsMs) {
        this.records.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}
