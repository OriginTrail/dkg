/**
 * Storage port interfaces for the Universal Messenger substrate (rc.9
 * plan PR-1). Defined in `packages/core` so `packages/agent`'s
 * `Messenger` class can depend on these abstract ports without
 * pulling in `packages/node-ui` (which holds the concrete SQLite
 * implementations against `DashboardDB`).
 *
 * Two stores, two concerns:
 *
 *   * `MessageIdempotencyStore` — receiver-side dedup + sender-side
 *     "did we already deliver this?" cache. Keyed by
 *     `(peer, protocol, messageId, direction)`. Records optionally
 *     cache the original response bytes so a retry of an already-
 *     delivered request can return the same response without re-
 *     invoking the application handler (idempotent re-delivery).
 *
 *   * `ProtocolOutboxStore` — sender-side durable retry queue. Keyed
 *     by `(peer, protocol, messageId)`. Holds the envelope-wrapped
 *     payload bytes + retry metadata (attempts, last error, next
 *     attempt time) so a daemon crash mid-retry doesn't drop the
 *     message (the rc9 chat outbox lost in-flight entries on every
 *     daemon restart — durable across-restart retry is the floor
 *     this substrate sets).
 *
 * Both stores are keyed by `protocol` (the libp2p protocol string,
 * e.g. `/dkg/10.0.1/message`) so a single `message_idempotency` or
 * `protocol_outbox` table can hold entries from every protocol
 * without collisions. The substrate's design constraint is that
 * adding a new short-message protocol requires no new storage —
 * just calling `Messenger.register(protocolId, handler)`.
 *
 * Response caching policy (locked in PR-2 design, documented here
 * because it constrains the store shape):
 *
 *   * Responses up to `RESPONSE_CACHE_BYTES` (= 256 KiB) bytes are
 *     stored in `response_blob` with `response_size = blob.length`.
 *
 *   * Responses larger than the limit are stored "mark-only" — the
 *     row is inserted but `response_blob` is left NULL and
 *     `response_size` records the actual byte size. The receiver-
 *     side handler wrapper, on a duplicate receive whose original
 *     response was mark-only, signals `RESPONSE_GONE` to the sender;
 *     the sender's caller can decide whether to re-issue with a
 *     fresh `messageId` (acceptable for `/query-remote` where SPARQL
 *     is idempotent at the app layer) or surface a terminal error.
 *
 * No per-protocol or per-call knob (`cacheResponse` / `responseCacheBytes`
 * from earlier plan iterations) — the fixed 256 KiB limit comfortably
 * covers chat acks, skill results, swm keys, access verdicts, join
 * verdicts; only `/query-remote` results might exceed it.
 *
 * Caller responsibilities:
 *   - Caller never normalises keys. The store is opaque about peer ID
 *     encoding — pass whatever string the libp2p caller already uses
 *     (typically `peerId.toString()`, the rc9 PR #533 lesson).
 *   - Caller supplies `now: number` for time-related queries (`due`,
 *     `dropExpired`); the store does not call `Date.now()` so tests
 *     can drive deterministic timestamps.
 *   - All write methods are synchronous (SQLite better-sqlite3 is
 *     sync). The implementations may use prepared statements + WAL
 *     for throughput but the API stays simple.
 */

/**
 * Fixed inline cache limit for response bodies in
 * `message_idempotency.response_blob`. Responses exceeding this size
 * are stored mark-only (blob NULL, size recorded) and trigger
 * `RESPONSE_GONE` on duplicate receive.
 *
 * 256 KiB chosen because it comfortably covers chat acks, skill
 * results, swm keys, access verdicts, join verdicts. Only
 * `/query-remote` SPARQL results may exceed it, and `/query-remote`
 * is idempotent at the app layer so the `RESPONSE_GONE` re-issue
 * path is acceptable for that one caller.
 */
export const RESPONSE_CACHE_BYTES = 256 * 1024;

/**
 * Discriminator returned in `IdempotencyCheckResult.cachedResponse`
 * when the original response was stored mark-only (too big to cache).
 * The receiver's handler wrapper emits the literal string
 * `'RESPONSE_GONE'` (not a special value) so it surfaces cleanly to
 * the sender as a typed protocol-level signal rather than getting
 * confused with a normal payload.
 */
export const RESPONSE_GONE_MARKER = 'RESPONSE_GONE';

/** Direction marker for idempotency entries. */
export type MessageDirection = 'in' | 'out';

/**
 * Result of `MessageIdempotencyStore.check`. Two-shape return: either
 * we've never seen this `(peer, protocol, messageId, direction)`
 * triple before, or we have — in which case the cached response (if
 * any) is returned. A `seen: true` result with `cachedResponse:
 * undefined` means "we processed this message but the response was
 * too large to cache and got marked-only" — the caller should treat
 * it as a `RESPONSE_GONE` signal.
 */
export type IdempotencyCheckResult =
  | { seen: false }
  | { seen: true; cachedResponse?: Uint8Array };

export interface MessageIdempotencyStore {
  /**
   * Returns whether the `(peer, protocol, messageId, direction)` triple
   * has been recorded before, plus the cached response if any.
   *
   * Synchronous: better-sqlite3 reads return immediately. The
   * receiver-side handler wrapper calls this on every inbound message
   * to decide whether to invoke the handler or return the cached
   * response.
   */
  check(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
  ): IdempotencyCheckResult;

  /**
   * Records a `(peer, protocol, messageId, direction)` triple with
   * optional response body. Pass `response: undefined` to record
   * "seen but no response cached" (i.e. mark-only for too-big
   * responses). Pass a response shorter than
   * `RESPONSE_CACHE_BYTES` to cache it inline.
   *
   * Idempotent: re-recording the same triple is a no-op (PRIMARY KEY
   * conflict resolved via `ON CONFLICT DO NOTHING` — Codex #534
   * lesson: never use blanket `INSERT OR IGNORE` which would swallow
   * unrelated constraint violations).
   *
   * The store decides mark-only vs inline based on `response.length`
   * vs `RESPONSE_CACHE_BYTES`. Callers don't pass the threshold.
   */
  record(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
    response?: Uint8Array,
  ): void;

  /**
   * Drop every idempotency record older than `tsMs`. Returns the
   * number of rows dropped, useful for periodic-prune diagnostics.
   * Called by a background tick to bound table growth (24h TTL by
   * default).
   */
  pruneOlderThan(tsMs: number): number;
}

/**
 * A single durable outbox entry. The `payload` is the
 * envelope-wrapped bytes (i.e. the `ReliableEnvelope` proto output
 * from `Messenger.sendToPeer`), not the raw application payload —
 * this lets retries replay byte-identical wire frames without re-
 * encoding the envelope.
 */
export interface ProtocolOutboxEntry {
  peer: string;
  protocol: string;
  messageId: string;
  payload: Uint8Array;
  attempts: number;
  firstFailureAt: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  lastError: string;
}

export interface ProtocolOutboxStore {
  /**
   * Insert or update an outbox entry for `(peer, protocol, messageId)`.
   * First failure creates the entry with `attempts = 1`. Subsequent
   * failures bump `attempts`, update `lastAttemptAt`/`lastError`, and
   * schedule `nextAttemptAt = now + backoff(attempts)`.
   *
   * Returns the resulting entry so the caller can log it / surface
   * delivery-state to the application.
   */
  enqueue(
    peer: string,
    protocol: string,
    messageId: string,
    payload: Uint8Array,
    error: string,
    now: number,
  ): ProtocolOutboxEntry;

  /**
   * Remove the outbox entry for `(peer, protocol, messageId)`.
   * Returns `true` if an entry was actually removed (i.e. this was a
   * retry success, not a first-attempt success).
   */
  markDelivered(peer: string, protocol: string, messageId: string): boolean;

  /**
   * Whether an entry exists for `(peer, protocol, messageId)`. Used
   * by the stale-snapshot guard in `Messenger.processOutboxOnConnect`
   * — between `tryBeginAttempt` (inflight lock) and the wire send,
   * a sibling flush may have already delivered + removed the entry,
   * and we must not double-send. The rc9 #538 fix lifted into the
   * generic substrate.
   */
  hasEntry(peer: string, protocol: string, messageId: string): boolean;

  /**
   * All entries for a specific peer, regardless of `nextAttemptAt`.
   * Used by `processOutboxOnConnect`: a reconnection is the signal
   * we were waiting for, so attempt now even if backoff isn't due
   * yet. Sorted by `firstFailureAt` ascending for FIFO per-peer
   * drain.
   */
  pendingFor(peer: string): ProtocolOutboxEntry[];

  /**
   * Entries whose `nextAttemptAt <= now`, ordered by `nextAttemptAt`,
   * `firstFailureAt`, then `(peer, protocol, messageId)` ascending. `limit` is
   * normalized by the canonical outbox due policy to a non-negative integer
   * (or omitted for all rows). The STORE owns this normalization and ordering
   * contract, including for direct calls. Used by the periodic retry scheduler.
   */
  due(now: number, limit?: number): ProtocolOutboxEntry[];

  /**
   * Drop entries whose `firstFailureAt` is older than the
   * configured max-age. Returns the dropped entries so the caller
   * can log them ("we gave up on this after 24h" diagnostic).
   */
  dropExpired(now: number): ProtocolOutboxEntry[];

  /** Total entries currently queued. For diagnostics + tests. */
  size(): number;

  /**
   * Snapshot of every entry in the store. Used by the diagnostics
   * surface (`/api/chat/outbox`, `dkg_outbox_status` MCP tool) so
   * operators can see what's pending after a long recipient outage.
   * Order is implementation-defined; callers that need per-peer
   * FIFO should sort by `firstFailureAt`.
   */
  list(): ProtocolOutboxEntry[];

  /**
   * Look up a specific entry by `(peer, protocol, messageId)`.
   * Returns `undefined` when no such entry exists. Used by
   * diagnostics + by callers that need full retry metadata (e.g.
   * surfacing `nextAttemptAt` in an HTTP response after a queued
   * send).
   */
  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined;
}


/**
 * Durable per-author KA-number allocator (OT-RFC-43 Option-1
 * deterministic KA identity, B2 allocator core).
 *
 * The locked design decision: the allocation namespace is the
 * *attested author* address, and a KA's full id is packed as
 * `kaId = (uint160(author) << 96) | uint96(number)`. This store owns
 * only the `number` half — a strictly-monotonic, never-reclaimed
 * sequence *per author address* — so a daemon crash mid-publish never
 * re-hands a number that may already have been minted on-chain under
 * that author.
 *
 * The store keys by author address (lowercased by the implementation),
 * not by node/operator identity: two nodes attesting the same author
 * draw from the same logical sequence, which is why startup
 * reconciliation against observed on-chain state (`reconcileFloor`) is
 * required before a cold node may allocate (RFC §4.5 cold-start
 * refusal — enforced by the wrapping `KaNumberAllocator`, not here).
 *
 * Allocation state is durable like `protocol_outbox`: it is NEVER
 * pruned. Reclaiming a number would risk minting a duplicate kaId.
 *
 * **Counter width (codex PR #976 F6):** every counter value crosses
 * this interface as a `bigint`, not a JS `number`. The on-chain field
 * is a `uint96` (max `2^96 - 1 ≈ 7.9e28`) and the design contemplates
 * far-future high-throughput authors. Even though `1000 alloc/s × 1M
 * years ≈ 2^55` keeps real load comfortably under `Number.MAX_SAFE_
 * INTEGER (2^53 - 1)`, returning `number` would silently lose precision
 * past that point — `allocate()`, `peekNext()`, and `observed + 1`
 * would all start to skip or duplicate kaIds. Using `bigint` end-to-end
 * is a defence-in-depth invariant: the interface cannot accidentally
 * be wired through a `Number()` cast at a call site. SQLite's signed
 * `INTEGER` (2^63 - 1) remains the hard ceiling for the implementation
 * — orders of magnitude past any realistic load, and many orders past
 * the `2^53` precision cliff that motivated this typing.
 */
export interface KaNumberStore {
  /**
   * Atomically consume and return the next number for `authorAddress`.
   * The first call for an author returns `0n`; subsequent calls return
   * `1n, 2n, 3n, …` strictly monotonically. Implementations lowercase
   * the address and perform the read-and-increment in a single atomic
   * statement (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) so two
   * concurrent allocations never collide on the same number.
   */
  allocate(authorAddress: string): bigint;

  /**
   * Raise the stored next-number for `authorAddress` to *at least*
   * `nextNumberFloor`, never lowering it. Called at startup with
   * `observedHighestMinted + 1n` so a node that lost local state (or is
   * cold) cannot re-issue a number the chain already used under that
   * author. Idempotent and monotonic: replaying an old floor is a
   * no-op.
   */
  reconcileFloor(authorAddress: string, nextNumberFloor: bigint): void;

  /**
   * The number the *next* `allocate(authorAddress)` would return,
   * without consuming it. Returns `0n` when the author has never been
   * seen. For diagnostics / reconciliation comparisons.
   */
  peekNext(authorAddress: string): bigint;
}
