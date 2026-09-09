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
 *     `packages/node-ui/src/protocol-outbox-store.ts`). Adds inflight-lock + backoff +
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
  BoundedProtocolOutboxStore,
  IdempotencyCheckResult,
  MessageDirection,
  MessageIdempotencyStore,
  LegacyProtocolOutboxStore,
  ProtocolOutboxEntry,
  ProtocolOutboxMetadata,
  ProtocolOutboxPage,
  ProtocolOutboxPageBudget,
  ProtocolOutboxQueueStats,
  ProtocolOutboxStore,
  ProtocolOutboxPersistence,
  ProtocolOutboxPayloadInspection,
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

function compareDueEntries(a: ProtocolOutboxEntry, b: ProtocolOutboxEntry): number {
  return a.nextAttemptAt - b.nextAttemptAt
    || a.firstFailureAt - b.firstFailureAt
    || Buffer.compare(Buffer.from(a.peer), Buffer.from(b.peer))
    || Buffer.compare(Buffer.from(a.protocol), Buffer.from(b.protocol))
    || Buffer.compare(Buffer.from(a.messageId), Buffer.from(b.messageId));
}

function entryMetadata(entry: ProtocolOutboxEntry): ProtocolOutboxMetadata {
  const { payload, ...metadata } = entry;
  return { ...metadata, payloadBytes: payload.byteLength };
}

export function validateProtocolOutboxPageBudget(budget: ProtocolOutboxPageBudget): void {
  for (const name of ['maxEntries', 'maxPayloadBytes'] as const) {
    if (!Number.isSafeInteger(budget[name]) || budget[name] <= 0) {
      throw new RangeError(`Outbox ${name} must be a positive safe integer`);
    }
  }
}

function comparePendingEntries(a: ProtocolOutboxEntry, b: ProtocolOutboxEntry): number {
  return a.firstFailureAt - b.firstFailureAt
    || a.protocol.localeCompare(b.protocol)
    || a.messageId.localeCompare(b.messageId);
}

function normalizeDuePageLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 0 || limit > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Outbox duePage limit must be finite and non-negative');
  }
  return Math.floor(limit);
}

interface ProtocolOutboxStorePolicy extends ProtocolOutboxOptions {
  backoffFor: (attempts: number) => number;
}

type PolicyAwareProtocolOutboxStore = ProtocolOutboxPersistence & {
  configurePolicy?: (policy: ProtocolOutboxStorePolicy) => void;
};

/**
 * Keep compatibility at the constructor boundary. Internally the outbox only
 * sees the current boolean peer-presence contract, while a legacy snapshot
 * store is adapted once with all method receivers preserved.
 */
function normalizeOutboxStore(store: CompatibleProtocolOutboxStore): ProtocolOutboxStore {
  if (typeof store.hasPendingFor === 'function') return store as ProtocolOutboxStore;

  const legacy = store as LegacyProtocolOutboxStore;
  const normalized: ProtocolOutboxStore = {
    enqueue: legacy.enqueue.bind(legacy),
    markDelivered: legacy.markDelivered.bind(legacy),
    hasEntry: legacy.hasEntry.bind(legacy),
    due: legacy.due.bind(legacy),
    dropExpired: legacy.dropExpired.bind(legacy),
    size: legacy.size.bind(legacy),
    list: legacy.list.bind(legacy),
    getEntry: legacy.getEntry.bind(legacy),
    hasPendingFor: (peer) => legacy.pendingFor(peer).length > 0,
    pendingFor: legacy.pendingFor.bind(legacy),
  };
  if (legacy.duePage) normalized.duePage = legacy.duePage.bind(legacy);
  const policy = legacy as PolicyAwareProtocolOutboxStore;
  if (policy.configurePolicy) (normalized as PolicyAwareProtocolOutboxStore).configurePolicy = policy.configurePolicy.bind(legacy);
  return normalized;
}

class ProtocolOutboxAttempts<Store extends ProtocolOutboxPersistence> {
  protected readonly store: Store;
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

  constructor(store: Store, options: ProtocolOutboxOptions = {}) {
    this.store = store;
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

  /** Total entries currently queued. */
  size(): number {
    return this.store.size();
  }

  /** Compute backoff for a given attempt count. Exposed for testing. */
  backoffFor(attempts: number): number {
    const idx = Math.min(Math.max(attempts - 1, 0), this.backoffs.length - 1);
    return this.backoffs[idx];
  }
}

/** Compatibility facade for explicit payload snapshots and legacy stores. */
export class ProtocolOutbox extends ProtocolOutboxAttempts<ProtocolOutboxStore> {
  constructor(store: CompatibleProtocolOutboxStore, options: ProtocolOutboxOptions = {}) {
    super(normalizeOutboxStore(store), options);
  }

  /** All due entries in deterministic retry order. */
  due(now: number): ProtocolOutboxEntry[] {
    return [...this.store.due(now)].sort(compareDueEntries);
  }

  /**
   * Explicit payload snapshot; omitting the limit preserves the all-due API.
   * Automatic drains use readDuePage instead. A supplied count limit never
   * falls back to loading an unlimited backlog.
   */
  duePage(now: number, limit?: number): ProtocolOutboxEntry[] {
    if (limit === undefined) return this.due(now);
    const normalizedLimit = normalizeDuePageLimit(limit);
    if (normalizedLimit === 0) return [];

    if (!this.store.duePage) {
      throw new Error('Custom outbox store must implement duePage for count-limited payload reads');
    }
    const snapshot = this.store.duePage(now, normalizedLimit);
    const ordered = [...snapshot].sort(compareDueEntries);
    return ordered.slice(0, normalizedLimit);
  }

  hasPendingFor(peer: string): boolean {
    return this.store.hasPendingFor(peer);
  }

  /**
   * Compatibility/diagnostic snapshot for a peer. This does not participate in
   * retry selection; scheduled drains remain exclusively `readDuePage`-driven.
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

  /**
   * Snapshot of every entry currently in the underlying store. Used
   * only for explicit payload inspection. Returns
   * entries in store order — callers that need per-peer FIFO should
   * sort by `firstFailureAt`.
   */
  list(): ProtocolOutboxEntry[] {
    return this.store.list();
  }

  /**
   * Look up a single entry. Used by diagnostics + by stale-snapshot
   * guards. Returns `undefined` if no such entry exists.
   */
  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined {
    return this.store.getEntry(peer, protocol, messageId);
  }
}

/** Compile-time completeness keeps JavaScript validation owned by the store contract. */
const BOUNDED_STORE_METHODS = {
  readDuePage: true, listMetadata: true, dropExpiredMetadata: true,
  recordRetryFailure: true, queueStats: true, hasPendingFor: true,
  enqueue: true, markDelivered: true, hasEntry: true, size: true,
} satisfies Record<keyof BoundedProtocolOutboxStore, true>;

export function assertBoundedProtocolOutboxStore(store: unknown): asserts store is BoundedProtocolOutboxStore {
  for (const method of Object.keys(BOUNDED_STORE_METHODS)) {
    if (store === null || (typeof store !== 'object' && typeof store !== 'function') || typeof (store as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`Custom outbox store must implement ${method} for byte-bounded Messenger retries`);
    }
  }
}

export function protocolOutboxPayloadInspection(
  store: BoundedProtocolOutboxStore,
): ProtocolOutboxPayloadInspection | undefined {
  const candidate = store as BoundedProtocolOutboxStore & Partial<ProtocolOutboxPayloadInspection>;
  return typeof candidate.list === 'function' && typeof candidate.getEntry === 'function'
    ? candidate as BoundedProtocolOutboxStore & ProtocolOutboxPayloadInspection
    : undefined;
}

/** Automatic retries depend only on bounded access and common persistence. */
export class BoundedProtocolOutbox extends ProtocolOutboxAttempts<BoundedProtocolOutboxStore> {
  private readonly inspection?: ProtocolOutboxPayloadInspection;

  constructor(store: BoundedProtocolOutboxStore, options: ProtocolOutboxOptions = {}) {
    assertBoundedProtocolOutboxStore(store);
    super(store, options);
    this.inspection = protocolOutboxPayloadInspection(store);
  }

  readDuePage(now: number, budget: ProtocolOutboxPageBudget): ProtocolOutboxPage {
    validateProtocolOutboxPageBudget(budget);
    return this.store.readDuePage(now, budget);
  }

  listMetadata(peer?: string): ProtocolOutboxMetadata[] {
    return this.store.listMetadata(peer);
  }

  dropExpiredMetadata(now: number): ProtocolOutboxMetadata[] {
    return this.store.dropExpiredMetadata(now);
  }

  recordRetryFailure(peer: string, protocol: string, messageId: string, error: string, now: number): ProtocolOutboxMetadata | undefined {
    return this.store.recordRetryFailure(peer, protocol, messageId, error, now);
  }

  queueStats(now: number, maxPayloadBytes: number): ProtocolOutboxQueueStats {
    return this.store.queueStats(now, maxPayloadBytes);
  }

  hasPendingFor(peer: string): boolean {
    return this.store.hasPendingFor(peer);
  }

  /** Explicitly expose whether this store supplied payload inspection. */
  payloadInspection(): ProtocolOutboxPayloadInspection | undefined {
    return this.inspection;
  }
}

/**
 * Reference in-memory implementation of `ProtocolOutboxStore`. Used
 * by tests + by the substrate before the SQLite-backed store is
 * wired in `lifecycle.ts` (PR-2). The SQLite-backed implementation
 * lives in `packages/node-ui/src/protocol-outbox-store.ts` and has the same semantics
 * — this class exists as the executable spec for the contract.
 *
 * Implements the same backoff ladder the wrapper `ProtocolOutbox`
 * uses so the test fixture is self-contained.
 */
export class InMemoryProtocolOutboxStore implements BoundedProtocolOutboxStore, ProtocolOutboxStore {
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
      this.advanceRetry(existing, error, now);
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

  private dueEntries(now: number): ProtocolOutboxEntry[] {
    return Array.from(this.entries.values())
      .filter(entry => entry.nextAttemptAt <= now)
      .sort(compareDueEntries);
  }

  due(now: number): ProtocolOutboxEntry[] {
    return this.dueEntries(now).map(cloneOutboxEntry);
  }

  duePage(now: number, limit: number): ProtocolOutboxEntry[] {
    limit = normalizeDuePageLimit(limit);
    return this.dueEntries(now).slice(0, limit).map(cloneOutboxEntry);
  }

  readDuePage(now: number, budget: ProtocolOutboxPageBudget): ProtocolOutboxPage {
    validateProtocolOutboxPageBudget(budget);
    let skippedOversizedEntries = 0;
    const candidates = this.dueEntries(now)
      .filter(entry => {
        if (entry.payload.byteLength <= budget.maxPayloadBytes) return true;
        skippedOversizedEntries++;
        return false;
      });
    const entries: ProtocolOutboxEntry[] = [];
    let payloadBytes = 0;
    let byteBudgetExhausted = false;
    for (const entry of candidates) {
      if (entries.length === budget.maxEntries) break;
      if (payloadBytes + entry.payload.byteLength > budget.maxPayloadBytes) {
        byteBudgetExhausted = true;
        break;
      }
      payloadBytes += entry.payload.byteLength;
      entries.push(cloneOutboxEntry(entry));
    }
    return { entries, skippedOversizedEntries, byteBudgetExhausted };
  }

  listMetadata(peer?: string): ProtocolOutboxMetadata[] {
    return Array.from(this.entries.values())
      .filter(entry => peer === undefined || entry.peer === peer)
      .map(entryMetadata);
  }

  private removeExpired<T>(now: number, project: (entry: ProtocolOutboxEntry) => T): T[] {
    const dropped: T[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailureAt > this.maxAgeMs) {
        dropped.push(project(entry));
        this.entries.delete(key);
      }
    }
    return dropped;
  }

  dropExpiredMetadata(now: number): ProtocolOutboxMetadata[] {
    return this.removeExpired(now, entryMetadata);
  }

  recordRetryFailure(peer: string, protocol: string, messageId: string, error: string, now: number): ProtocolOutboxMetadata | undefined {
    const entry = this.entries.get(InMemoryProtocolOutboxStore.key(peer, protocol, messageId));
    if (!entry) return undefined;
    this.advanceRetry(entry, error, now);
    return entryMetadata(entry);
  }

  private advanceRetry(entry: ProtocolOutboxEntry, error: string, now: number): void {
    entry.attempts += 1;
    entry.lastAttemptAt = now;
    entry.nextAttemptAt = now + this.backoffFor(entry.attempts);
    entry.lastError = error;
  }

  queueStats(now: number, maxPayloadBytes: number): ProtocolOutboxQueueStats {
    let queuedBytes = 0;
    let oldestDueAgeMs = 0;
    let oversizedDueEntries = 0;
    for (const entry of this.entries.values()) {
      queuedBytes += entry.payload.byteLength;
      if (entry.nextAttemptAt <= now) {
        oldestDueAgeMs = Math.max(oldestDueAgeMs, now - entry.nextAttemptAt);
        if (entry.payload.byteLength > maxPayloadBytes) oversizedDueEntries++;
      }
    }
    return { queuedEntries: this.entries.size, queuedBytes, oldestDueAgeMs, oversizedDueEntries };
  }

  dropExpired(now: number): ProtocolOutboxEntry[] {
    return this.removeExpired(now, cloneOutboxEntry);
  }

  size(): number {
    return this.entries.size;
  }

  list(): ProtocolOutboxEntry[] {
    return Array.from(this.entries.values()).map(cloneOutboxEntry);
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
