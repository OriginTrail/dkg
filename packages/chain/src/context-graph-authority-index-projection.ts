// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphAuthorityIndexStateRevision,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexId } from
  './context-graph-authority-index-id.js';
import { waitForAuthorityIndexOperation } from
  './context-graph-authority-index-activity.js';

/** Default `chain.indexTickMs`: how long one completed projection answers reads. */
export const DEFAULT_CONTEXT_GRAPH_AUTHORITY_INDEX_TICK_MS = 6_000;

/** Canonical cache/index scope for one physical authority contract deployment. */
export function contextGraphAuthorityIndexScope(
  deploymentId: string,
  contractAddress: string,
): string {
  return [deploymentId, contractAddress.toLowerCase()].join(':');
}

/**
 * Floor of the stale-if-error window. The window is `max(3T, floor)`: three
 * missed refreshes for an operator-sized T, but never so short that one slow
 * failover pass (a 5s stall timeout per endpoint) already exhausts it.
 */
export const CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS = 15_000;

/**
 * How old, in CHAIN time, the head of a cached projection may be before the
 * cache stops answering for it (security review S2).
 *
 * `fetchedAtMs` only proves when this node ASKED. A responsive but lagging
 * endpoint answers promptly with an old head, so a fetch-time guard alone
 * would pin that old authority for a whole window while calling it fresh. The
 * head's own block timestamp is the only evidence of what the answer is an
 * answer ABOUT.
 *
 * Deliberately generous: it has to absorb the block interval (2s Base, 5s
 * Gnosis, 12s NeuroWeb with occasional multi-slot stalls), wall-clock skew
 * between this host and the chain, and the stale-if-error window above. Five
 * minutes equals the RFC-64 accepted-authority refresh interval, so the cache
 * can never be the stalest link in that path. It also caps the useful value of
 * `chain.indexTickMs`: a larger T is accepted but stops paying past this age.
 *
 * ONE-SIDED on purpose. A head stamped in the future (a devnet after
 * `evm_increaseTime`, or plain clock skew) cannot be a lagging endpoint's
 * answer, so it is never the defect this guard exists for.
 *
 * Out of tolerance means "not servable FROM THE CACHE", never "the chain is
 * broken": an automine devnet that mined nothing for an hour legitimately has
 * an hour-old head. Such a read simply takes today's uncached path, and only a
 * FAILED refresh is refused the stale answer.
 */
export const CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

/** In-flight refreshes one caller waits out before it reads for itself. */
const MAX_REFRESH_WAITS = 2;

/** Normalize `chain.indexTickMs`; an omitted value defaults, an invalid one throws. */
export function resolveContextGraphAuthorityIndexTickMs(value: unknown): number {
  if (value === undefined) return DEFAULT_CONTEXT_GRAPH_AUTHORITY_INDEX_TICK_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('chain.indexTickMs must be a positive integer');
  }
  return value;
}

export interface ContextGraphAuthorityIndexProjectionOptions {
  /** `chain.indexTickMs` (T). Validated by the owner of this cache. */
  readonly tickMs?: number;
  readonly headTimestampToleranceMs?: number;
  /** Injected wall clock; late-bound so a faked `Date` is honoured. */
  readonly now?: () => number;
}

/**
 * How one finalized authority read was answered. `scan` exercised the RPC pool
 * now; `cache` was answered by a projection still inside its configured tick;
 * `stale-cache` was answered DESPITE a failed refresh and therefore proves
 * nothing about the pool.
 */
export interface ContextGraphAuthorityProjectionServedEvidence {
  readonly source: 'scan' | 'cache' | 'stale-cache';
  /** Wall-clock age of the projection's head read when it was served. */
  readonly ageMs: number;
}

/**
 * Read-only view of ONE complete contract-wide checkpoint.
 *
 * The checkpoint (durable prefix plus the in-memory tail reduced above the
 * reorg holdback) stays private, exactly as it does behind the index's own
 * purpose-specific reads: a caller can project states out of it but can never
 * hand it to `exportSnapshot`, which serves the durable cursor only.
 *
 * These are the SAME projections `ContextGraphAuthorityIndex` runs on a fresh
 * scan, so a state, revision or policy digest read through a cached view is
 * byte-identical to the one a fresh scan at that head produces.
 */
export class ContextGraphAuthorityIndexView {
  readonly #checkpoint: ContextGraphAuthorityIndexCheckpoint;

  constructor(checkpoint: ContextGraphAuthorityIndexCheckpoint) {
    this.#checkpoint = checkpoint;
    Object.freeze(this);
  }

  has(contextGraphId: ContextGraphAuthorityIndexId): boolean {
    return this.#checkpoint.states.some((state) => state.contextGraphId === contextGraphId);
  }

  /** ABSENT is explicit: it throws, and is never a public/inactive/zero default. */
  resolve(contextGraphId: ContextGraphAuthorityIndexId): ContextGraphAuthorityIndexState {
    const state = this.#checkpoint.states.find((candidate) => (
      candidate.contextGraphId === contextGraphId
    ));
    if (state === undefined) {
      throw new Error(`Context Graph ${contextGraphId} has no finalized creation event`);
    }
    return state;
  }

  revisions(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
  ): ReadonlyMap<ContextGraphAuthorityIndexId, string> {
    const revisions = new Map<ContextGraphAuthorityIndexId, string>();
    for (const [contextGraphId, state] of this.states(contextGraphIds)) {
      revisions.set(contextGraphId, contextGraphAuthorityIndexStateRevision(state));
    }
    return revisions;
  }

  states(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
  ): ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState> {
    const targetIds = new Set<ContextGraphAuthorityIndexId>(contextGraphIds);
    const states = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState>();
    for (const state of this.#checkpoint.states) {
      if (targetIds.has(state.contextGraphId)) states.set(state.contextGraphId, state);
    }
    return states;
  }

  /**
   * `nameHashes` are already normalized and non-zero. Missing targets are
   * omitted; any duplicate finalized commitment fails the projection closed.
   */
  statesByNameHashes(
    nameHashes: readonly string[],
  ): ReadonlyMap<string, ContextGraphAuthorityIndexState> {
    const targets = new Set<string>(nameHashes);
    const states = new Map<string, ContextGraphAuthorityIndexState>();
    const counts = new Map<string, number>();
    for (const state of this.#checkpoint.states) {
      if (!targets.has(state.nameHash)) continue;
      counts.set(state.nameHash, (counts.get(state.nameHash) ?? 0) + 1);
      states.set(state.nameHash, state);
    }
    for (const [nameHash, count] of counts) {
      if (count <= 1) continue;
      throw new Error(
        `Context Graph name hash ${nameHash} is ambiguous across ` +
        `${count} finalized Context Graphs`,
      );
    }
    return states;
  }
}

/** What one completed refresh hands over: scanned AND past its final fence. */
export interface ContextGraphAuthorityIndexCompletedProjection {
  /** Deployment (chainId + Hub) + physical ContextGraphStorage address. */
  readonly scope: string;
  readonly chainId: string;
  readonly contractAddress: string;
  /** The anchor the view is pinned to; the head itself at the default depth. */
  readonly finalized: Readonly<{ number: number; hash: string }>;
  /** The head the endpoint reported, with its CHAIN time in seconds. */
  readonly head: Readonly<{ number: number; hash: string; timestampSeconds: number }>;
  readonly view: ContextGraphAuthorityIndexView;
}

export interface ContextGraphAuthorityIndexProjection
  extends ContextGraphAuthorityIndexCompletedProjection {
  /** Taken BEFORE the refresh started, so age is never under-reported. */
  readonly fetchedAtMs: number;
}

export interface ContextGraphAuthorityIndexProjectionReadInput {
  readonly scope: string;
  /** Bounds only THIS caller's wait; it never reaches another caller's refresh. */
  readonly signal?: AbortSignal;
  /**
   * False when a CACHED projection cannot answer this read, which forces a
   * fresh one. Callers use it for absent targets: a graph registered seconds
   * ago must become visible at today's speed, so absence is only ever reported
   * from a projection that was scanned for this read.
   */
  readonly accepts: (projection: ContextGraphAuthorityIndexProjection) => boolean;
  /** Today's complete read: head, cursor admission, scan, stabilize. */
  readonly refresh: () => Promise<ContextGraphAuthorityIndexCompletedProjection>;
  readonly onServed?: (evidence: ContextGraphAuthorityProjectionServedEvidence) => void;
}

/**
 * Last COMPLETED projection per scope, in front of the reader-driven scan.
 *
 * Reads used to drive the scan: every authority read re-resolved the head,
 * re-admitted the durable cursor, re-read the tail and re-stabilized, although
 * the answer changes only when an authority event is mined. This keeps the one
 * result those steps produce and answers from it for `tickMs`.
 *
 * COALESCING WITHOUT SHARED OWNERSHIP. A refresh stays what it is today: the
 * initiating caller's own read, bound to that caller's signal, deadline and
 * request class. It is deliberately NOT moved into an
 * `AbortableKeyedSingleFlight`, because nothing about it is shareable except
 * its RESULT. Concurrent callers therefore wait for the in-flight refresh to
 * SETTLE and then look at the cache again. If it published, they are answered
 * from it (one refresh for N callers). If its initiator aborted, timed out or
 * failed, they inherit none of that: each simply runs its own read, which is
 * exactly what it would have done before this cache existed.
 *
 * FAIL CLOSED. A failed refresh may be papered over by the previous projection
 * only while that projection is at most `max(3T, 15s)` old by fetch time AND
 * its head is within the chain-time tolerance. Past either bound the refresh's
 * OWN error is rethrown untouched, so typed transport failures
 * (`RPC_ENDPOINTS_EXHAUSTED`) keep reaching the RFC-64 circuit breaker. A
 * failure is never turned into an absent, public or zero answer.
 */
export class ContextGraphAuthorityIndexProjectionCache {
  readonly tickMs: number;
  readonly staleMs: number;
  readonly #headTimestampToleranceMs: number;
  readonly #now: () => number;
  readonly #projections = new Map<string, ContextGraphAuthorityIndexProjection>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #failedAtMs = new Map<string, number>();
  /** Bumped by every drop; an older refresh may answer its caller, never publish. */
  #epoch = 0;

  constructor(options: ContextGraphAuthorityIndexProjectionOptions = {}) {
    this.tickMs = resolveContextGraphAuthorityIndexTickMs(options.tickMs);
    this.staleMs = Math.max(3 * this.tickMs, CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS);
    this.#headTimestampToleranceMs = options.headTimestampToleranceMs
      ?? CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS;
    if (!Number.isSafeInteger(this.#headTimestampToleranceMs)
      || this.#headTimestampToleranceMs < 1) {
      throw new Error('Context Graph authority head timestamp tolerance must be a positive integer');
    }
    this.#now = options.now ?? (() => Date.now());
  }

  /** A checkpoint tombstone or a fork proved this scope's projection wrong. */
  drop(scope: string): void {
    this.#epoch += 1;
    this.#projections.delete(scope);
    this.#failedAtMs.delete(scope);
  }

  /**
   * Hub/contract rotation, adapter teardown, or a local transaction that
   * changed authority: nothing scanned before it may answer, and a refresh
   * already in flight may not publish.
   */
  clear(): void {
    this.#epoch += 1;
    this.#projections.clear();
    this.#failedAtMs.clear();
    this.#refreshing.clear();
  }

  async read(
    input: ContextGraphAuthorityIndexProjectionReadInput,
  ): Promise<ContextGraphAuthorityIndexProjection> {
    input.signal?.throwIfAborted();
    const cached = this.#serve(input, 'backing-off');
    if (cached !== undefined) return cached;
    // Twice, so that when an initiator leaves, its waiters coalesce behind the
    // first of them to take over instead of all scanning side by side. Bounded,
    // so no caller can be starved by a train of refreshes it cannot use: past
    // the bound it reads for itself, exactly as it did before this cache.
    for (let waits = 0; waits < MAX_REFRESH_WAITS; waits += 1) {
      const refreshing = this.#refreshing.get(input.scope);
      if (refreshing === undefined) break;
      // `refreshing` never rejects: the initiator's abort, timeout or failure
      // is its own. This waiter only learns that the refresh settled.
      await waitForAuthorityIndexOperation(refreshing, input.signal);
      const published = this.#serve(input, 'backing-off');
      if (published !== undefined) return published;
    }
    return this.#refresh(input);
  }

  async #refresh(
    input: ContextGraphAuthorityIndexProjectionReadInput,
  ): Promise<ContextGraphAuthorityIndexProjection> {
    const epoch = this.#epoch;
    const fetchedAtMs = this.#now();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    // A waiter that found the previous refresh unusable runs beside a newer
    // initiator instead of queueing behind it a second time.
    const initiates = !this.#refreshing.has(input.scope);
    if (initiates) this.#refreshing.set(input.scope, settled);
    try {
      const projection: ContextGraphAuthorityIndexProjection = Object.freeze({
        ...await input.refresh(),
        fetchedAtMs,
      });
      if (epoch === this.#epoch) this.#publish(input.scope, projection);
      input.onServed?.(Object.freeze({
        source: 'scan',
        ageMs: Math.max(0, this.#now() - fetchedAtMs),
      }));
      return projection;
    } catch (error) {
      // A caller that left did not observe an RPC failure.
      if (input.signal?.aborted) throw error;
      if (epoch === this.#epoch) this.#failedAtMs.set(input.scope, this.#now());
      const stale = this.#serve(input, 'refresh-failed');
      if (stale !== undefined) return stale;
      throw error;
    } finally {
      if (initiates && this.#refreshing.get(input.scope) === settled) {
        this.#refreshing.delete(input.scope);
      }
      settle();
    }
  }

  #publish(scope: string, projection: ContextGraphAuthorityIndexProjection): void {
    // Keyed by what was actually scanned. A refresh that resolved another
    // contract than the one this read was keyed by answers its caller only.
    if (projection.scope !== scope) return;
    // No chain time, no cache: the S2 guard could never be evaluated.
    if (!Number.isSafeInteger(projection.head.timestampSeconds)
      || projection.head.timestampSeconds < 0) return;
    // A lagging sibling endpoint must not replace a newer head and then be
    // pinned for a whole tick. Its caller is still answered, as before.
    const previous = this.#projections.get(scope);
    if (previous !== undefined && projection.head.number < previous.head.number) return;
    this.#projections.set(scope, projection);
    this.#failedAtMs.delete(scope);
  }

  /**
   * `backing-off`: before any RPC. Serves a fresh projection, or — while the
   * last refresh failed less than one tick ago — the still-admissible stale
   * one, so an outage costs one failed pass per tick instead of one per read.
   * `refresh-failed`: this caller's own refresh just failed.
   */
  #serve(
    input: ContextGraphAuthorityIndexProjectionReadInput,
    reason: 'backing-off' | 'refresh-failed',
  ): ContextGraphAuthorityIndexProjection | undefined {
    const projection = this.#projections.get(input.scope);
    if (projection === undefined) return undefined;
    const now = this.#now();
    const ageMs = now - projection.fetchedAtMs;
    // A wall clock that stepped backwards proves no age at all.
    if (ageMs < 0 || ageMs > this.staleMs) return undefined;
    if (now - projection.head.timestampSeconds * 1_000 > this.#headTimestampToleranceMs) {
      return undefined;
    }
    if (!input.accepts(projection)) return undefined;
    const fresh = ageMs < this.tickMs;
    if (!fresh && reason === 'backing-off') {
      const failedAtMs = this.#failedAtMs.get(input.scope);
      if (failedAtMs === undefined) return undefined;
      const sinceFailureMs = now - failedAtMs;
      if (sinceFailureMs < 0 || sinceFailureMs >= this.tickMs) return undefined;
    }
    input.onServed?.(Object.freeze({
      source: fresh ? 'cache' : 'stale-cache',
      ageMs,
    }));
    return projection;
  }
}
