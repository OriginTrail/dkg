// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphAuthorityIndexStateRevision,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexId } from
  './context-graph-authority-index-id.js';
import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';
import { isChainRpcTransportError } from './chain-rpc-transport-error.js';
import { isContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';
import { waitForSignal } from './wait-for-signal.js';

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
 * Floor of the stale-if-error window. The window starts at `max(3T, floor)`:
 * three missed refreshes for an operator-sized T, but never so short that one
 * slow failover pass (a 5s stall timeout per endpoint) already exhausts it.
 */
export const CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS = 15_000;

/** Shared stale-if-error budget for both the projection cache and one-log anchor. */
export function resolveContextGraphAuthorityIndexStaleMs(tickMs: number): number {
  return Math.min(
    Math.max(3 * tickMs, CONTEXT_GRAPH_AUTHORITY_INDEX_STALE_FLOOR_MS),
    CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
  );
}

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
 * `chain.indexTickMs`: both fresh-cache reuse and stale-if-error are capped at
 * this age even when an operator configures a larger T.
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
const ZERO_HASH = `0x${'00'.repeat(32)}`;

type ProjectionCacheLookup<T> =
  | Readonly<{ hit: false }>
  | Readonly<{ hit: true; value: T }>;
const PROJECTION_CACHE_MISS: ProjectionCacheLookup<never> = Object.freeze({ hit: false });

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
 * How one finalized authority read was answered.
 *
 *  - `scan` exercised the RPC pool NOW. This is the only member that is a
 *    first-hand statement about the pool's liveness.
 *  - `cache` was answered by a projection still inside its configured tick.
 *    Second-hand, but its provenance is exact: some earlier `scan` of this
 *    same read class produced it, and {@link ageMs} dates that scan.
 *  - `log` was FOLDED out of the node-local chain event log's stored rows.
 *    It contacted no endpoint at all — that is the entire point of it — so it
 *    proves nothing whatever about the pool. The only fetch instant it can
 *    offer belongs to the background chain-index tick, which is a DIFFERENT
 *    actor running a DIFFERENT read policy (`watchdogPointRead`, capped) in a
 *    provider session this read never opened. A consumer must not read it as
 *    liveness; see the RFC-64 authority circuit breaker, which treats it as no
 *    signal.
 *  - `stale-cache` was answered DESPITE a failed refresh, and is therefore
 *    evidence AGAINST the pool.
 *
 * ONLY `scan` and `cache` carry pool liveness. A consumer that switches on
 * this field must default to the non-proof side, so that a member added later
 * cannot be mistaken for health by omission.
 */
export interface ContextGraphAuthorityProjectionServedEvidence {
  readonly source: 'scan' | 'cache' | 'log' | 'stale-cache';
  /**
   * How old the DATA behind this answer is, in wall-clock milliseconds.
   *
   * For a refresh that asked the chain that is the time since the refresh
   * began — captured before any RPC, so scan duration is included and the age
   * is over-reported rather than under. For a `log` fold it is the time since
   * the TICK asked for the head it committed, which can be up to
   * `min(max(3T, 15s), 5m)` more — and which is stamped before that tick's own
   * head RPC, so the tick's pass duration is inside it under the identical
   * discipline. Both are the same statement: nothing was observed about the
   * chain more recently than this.
   *
   * It dates the OBSERVATION, never the observer. On a `log` fold the instant
   * it points at belongs to the background tick, so it cannot be read as "this
   * read reached the pool then" — that is what {@link source} is for.
   */
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

  /** Missing and zero-hash targets are omitted; duplicates fail closed. */
  statesByNameHashes(
    nameHashes: readonly string[],
  ): ReadonlyMap<string, ContextGraphAuthorityIndexState> {
    const targets = new Set<string>();
    for (const rawNameHash of nameHashes) {
      const nameHash = normalizeHash(rawNameHash);
      if (nameHash === undefined) {
        throw new Error('Context Graph authority index name hash is invalid');
      }
      if (nameHash !== ZERO_HASH) targets.add(nameHash);
    }
    if (targets.size === 0) return new Map();
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

/** Where a completed projection obtained the chain data it contains. */
export type ContextGraphAuthorityIndexProjectionOrigin =
  | Readonly<{ kind: 'scan' }>
  | Readonly<{ kind: 'log'; dataFetchedAtMs: number }>;

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
  /**
   * Whether this refresh fetched the data itself or folded stored log rows.
   *
   * The discriminant is authoritative provenance. A log timestamp that is
   * invalid or in the future is still a log answer; only its effective age
   * falls back to the refresh-start instant. This prevents malformed timing
   * metadata from being relabelled as evidence of a live RPC scan.
   */
  readonly origin: ContextGraphAuthorityIndexProjectionOrigin;
}

export interface ContextGraphAuthorityIndexProjection
  extends ContextGraphAuthorityIndexCompletedProjection {
  /**
   * When this view's data was fetched: the OLDER of the instant taken before
   * the refresh started and any instant the refresh itself reported. Age is
   * therefore never under-reported, whichever side produced the view.
   */
  readonly fetchedAtMs: number;
}

/** A caller projection fault deferred past refresh/transport classification. */
export interface ContextGraphAuthorityIndexProjectionFault {
  readonly kind: 'context-graph-authority-projection-fault';
  readonly fault: unknown;
}

export function contextGraphAuthorityIndexProjectionFault(
  fault: unknown,
): ContextGraphAuthorityIndexProjectionFault {
  return Object.freeze({ kind: 'context-graph-authority-projection-fault' as const, fault });
}

function isContextGraphAuthorityIndexProjectionFault(
  value: ContextGraphAuthorityIndexCompletedProjection | ContextGraphAuthorityIndexProjectionFault,
): value is ContextGraphAuthorityIndexProjectionFault {
  return 'kind' in value && value.kind === 'context-graph-authority-projection-fault';
}

/**
 * Stamp a completed refresh, producing the projection it is judged, retained,
 * reported and aged by. THE ONLY WAY a `fetchedAtMs` is ever produced.
 *
 * `floorAtMs` is taken before any RPC — `#refresh`'s own pre-refresh instant,
 * or, for the log fast path's synthetic candidate, the instant that read was
 * asked. A scan is therefore never younger than it. A refresh that folded
 * stored rows may prove its data is OLDER, and only older is ever believed: a
 * reported instant at or after the floor would move age towards zero, which is
 * the one direction `dataFetchedAtMs` exists to forbid. A value that is not a
 * safe integer proves nothing at all and falls back with it.
 *
 * EXPORTED so the log fast path in `evm-context-graph-authority-index-reader`
 * can build the candidate it runs the caller's projection against through this
 * function instead of restating the rule. The two must not be able to disagree:
 * the candidate a read is ADMITTED by and the projection the cache then ages
 * and reports are the same view, and a second copy of the expression could
 * drift from this one silently (it already had: `Math.min` believed a NaN or
 * fractional `dataFetchedAtMs` that this resolver rejects). The floors differ —
 * the reader's `askedAtMs` precedes the cache's stamp — and only ever in the
 * over-reporting direction, which is the safe one.
 */
export function resolveProjectionFetchedAtMs(
  refreshStartedAtMs: number,
  origin: ContextGraphAuthorityIndexProjectionOrigin,
): number {
  return origin.kind === 'log'
    && Number.isSafeInteger(origin.dataFetchedAtMs)
    && origin.dataFetchedAtMs < refreshStartedAtMs
    ? origin.dataFetchedAtMs
    : refreshStartedAtMs;
}

/**
 * Whether this view was FOLDED out of stored rows instead of fetched.
 *
 * Provenance is explicit and independent of timestamp validity. It survives
 * publication because the retained projection carries the same discriminant.
 */
function projectionFoldedStoredRows(
  projection: ContextGraphAuthorityIndexCompletedProjection,
): boolean {
  return projection.origin.kind === 'log';
}

export interface ContextGraphAuthorityIndexProjectionReadInput<T> {
  readonly scope: string;
  /** Bounds only THIS caller's wait; it never reaches another caller's refresh. */
  readonly signal?: AbortSignal;
  /**
   * Pure projection of one candidate cache entry. It runs at most once per
   * candidate, but a logical read may see a cached candidate, a projection
   * published by an in-flight refresh, and its own fresh scan. An incomplete
   * cached result forces a refresh; projection exceptions propagate and never
   * become cache misses or extra paid scans.
   */
  readonly project: (
    projection: ContextGraphAuthorityIndexProjection,
  ) => Readonly<{ complete: boolean; value: T }>;
  /** Today's complete read: head, cursor admission, scan, stabilize. */
  readonly refresh: () => Promise<
    ContextGraphAuthorityIndexCompletedProjection | ContextGraphAuthorityIndexProjectionFault
  >;
  readonly onServed?: (evidence: ContextGraphAuthorityProjectionServedEvidence) => void;
}

/** Every mutable invariant for one physical deployment/contract scope. */
interface ContextGraphAuthorityProjectionScopeState {
  generation: number;
  activeRefreshes: number;
  projection?: ContextGraphAuthorityIndexProjection;
  refreshing?: Promise<void>;
  failedAtMs?: number;
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
 * FAIL CLOSED. Only a typed chain-transport availability failure may be
 * papered over by the previous projection, and only while that projection is
 * at most `min(max(3T, 15s), 5m)` old by fetch time AND its head is within the
 * chain-time tolerance. Deterministic refresh faults propagate immediately
 * and do not arm backoff. Past either age bound the refresh's OWN transport
 * error is rethrown untouched, so typed failures keep reaching the RFC-64
 * circuit breaker. A failure is never turned into an absent, public or zero
 * answer.
 */
export class ContextGraphAuthorityIndexProjectionCache {
  readonly tickMs: number;
  readonly staleMs: number;
  readonly #headTimestampToleranceMs: number;
  readonly #now: () => number;
  /** One state cell per scope, including every refresh currently in flight. */
  readonly #scopes = new Map<string, ContextGraphAuthorityProjectionScopeState>();

  constructor(options: ContextGraphAuthorityIndexProjectionOptions = {}) {
    this.tickMs = resolveContextGraphAuthorityIndexTickMs(options.tickMs);
    this.staleMs = resolveContextGraphAuthorityIndexStaleMs(this.tickMs);
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
    const state = this.#scopes.get(scope);
    if (state === undefined) return;
    state.generation += 1;
    delete state.projection;
    delete state.failedAtMs;
    delete state.refreshing;
    this.#deleteScopeIfIdle(scope, state);
  }

  /**
   * Hub/contract rotation, adapter teardown, or a local transaction that
   * changed authority: nothing scanned before it may answer, and a refresh
   * already in flight may not publish.
   */
  clear(): void {
    for (const [scope, state] of this.#scopes) {
      state.generation += 1;
      delete state.projection;
      delete state.failedAtMs;
      delete state.refreshing;
      this.#deleteScopeIfIdle(scope, state);
    }
  }

  async read<T>(input: ContextGraphAuthorityIndexProjectionReadInput<T>): Promise<T> {
    input.signal?.throwIfAborted();
    const cached = this.#serve(input, 'backing-off');
    if (cached.hit) return cached.value;
    // Twice, so that when an initiator leaves, its waiters coalesce behind the
    // first of them to take over instead of all scanning side by side. Bounded,
    // so no caller can be starved by a train of refreshes it cannot use: past
    // the bound it reads for itself, exactly as it did before this cache.
    for (let waits = 0; waits < MAX_REFRESH_WAITS; waits += 1) {
      const refreshing = this.#scopes.get(input.scope)?.refreshing;
      if (refreshing === undefined) break;
      // `refreshing` never rejects: the initiator's abort, timeout or failure
      // is its own. This waiter only learns that the refresh settled.
      await waitForSignal(refreshing, input.signal);
      const published = this.#serve(input, 'backing-off');
      if (published.hit) return published.value;
    }
    return this.#refresh(input);
  }

  async #refresh<T>(input: ContextGraphAuthorityIndexProjectionReadInput<T>): Promise<T> {
    const state = this.#scopeState(input.scope);
    state.activeRefreshes += 1;
    const generation = state.generation;
    const refreshStartedAtMs = this.#now();
    let projection: ContextGraphAuthorityIndexProjection | undefined;
    let projectionFault: ContextGraphAuthorityIndexProjectionFault | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    // A waiter that found the previous refresh unusable runs beside a newer
    // initiator instead of queueing behind it a second time.
    const initiates = state.refreshing === undefined;
    if (initiates) state.refreshing = settled;
    try {
      const refreshed = await input.refresh();
      if (isContextGraphAuthorityIndexProjectionFault(refreshed)) {
        projectionFault = refreshed;
      } else {
        const completed = refreshed;
        // A refresh that FOLDED stored rows rather than fetching them answers as
        // of the instant that data was fetched, not as of this read. Retaining
        // and reporting it under `now` would reset its age to zero and buy it a
        // further `tickMs` of service as a FRESH cache entry, so a view already
        // `max(3T, 15s)` behind the chain could be served for `max(3T, 15s) + T`
        // while every consumer was told it was under T old. The age this cache
        // ages by is the age of the DATA.
        projection = Object.freeze({
          ...completed,
          fetchedAtMs: resolveProjectionFetchedAtMs(
            refreshStartedAtMs,
            completed.origin,
          ),
        });
        if (generation === state.generation) {
          this.#publish(state, projection);
        }
        // `scan` is a claim about the POOL, not about where the answer came
        // from, so a fold may not make it. The log path reaches SQLite and
        // nothing else; reporting it as a scan let a consumer read local rows as
        // proof that every endpoint was alive, which is the one thing a fold
        // cannot witness.
        input.onServed?.(Object.freeze({
          source: projectionFoldedStoredRows(completed) ? 'log' : 'scan',
          ageMs: Math.max(0, this.#now() - projection.fetchedAtMs),
        }));
      }
    } catch (error) {
      // A caller that left did not observe an RPC failure.
      if (input.signal?.aborted) throw error;
      // Admission rejected the chain view itself (for example a finalized
      // head behind the durable cursor). That is not a transport outage the
      // old authority projection may paper over: invalidate the retained view
      // and propagate the typed failure.
      if (isContextGraphAuthorityIndexRetryableError(error)) {
        if (generation === state.generation) this.drop(input.scope);
        throw error;
      }
      // Only the chain transport boundary proves an availability outage. A
      // plain/deterministic fault must never be hidden behind stale authority
      // or arm a one-tick backoff that would keep hiding it from later reads.
      if (!isChainRpcTransportError(error)) throw error;
      if (generation === state.generation) {
        state.failedAtMs = this.#now();
      }
      const stale = this.#serve(input, 'refresh-failed');
      if (stale.hit) return stale.value;
      throw error;
    } finally {
      if (initiates && state.refreshing === settled) delete state.refreshing;
      state.activeRefreshes -= 1;
      settle();
      this.#deleteScopeIfIdle(input.scope, state);
    }
    // A caller's pure projection can reject a perfectly valid log fold. That
    // fault travels as data through the provider session and refresh catch,
    // then is restored here, outside both transport classifiers. It is neither
    // an outage nor a servable projection, so it is not published or reported.
    if (projectionFault !== undefined) throw projectionFault.fault;
    if (projection === undefined) {
      throw new Error('Context Graph authority refresh settled without a projection');
    }
    // Projection faults are caller/read-shape faults, not refresh failures;
    // never turn them into stale-if-error service or provider backoff.
    return input.project(projection).value;
  }

  #publish(
    state: ContextGraphAuthorityProjectionScopeState,
    projection: ContextGraphAuthorityIndexProjection,
  ): void {
    // Derive the publication key from what was actually scanned. A refresh
    // that resolved another contract than the initiating read answers its
    // caller only; it cannot publish through that read's state cell.
    if (this.#scopes.get(projection.scope) !== state) return;
    // No chain time, no cache: the S2 guard could never be evaluated.
    if (!Number.isSafeInteger(projection.head.timestampSeconds)
      || projection.head.timestampSeconds < 0) return;
    // A lagging sibling endpoint must not displace a still-fresh newer head.
    // Once that retained head has reached T, however, keeping it would strand
    // the cache forever on a legitimate reorg/reset: every stabilized lower
    // scan would be answered to its caller but refused publication.
    //
    // The difference may now be NEGATIVE — a fold from the log is stamped with
    // the tick's head-fetch instant, which can predate a live scan already
    // retained. That is the same case, read correctly: older data at a lower
    // head does not displace newer, and the caller is still answered.
    const previous = state.projection;
    if (
      previous !== undefined
      && projection.head.number < previous.head.number
      && projection.fetchedAtMs - previous.fetchedAtMs < this.tickMs
    ) {
      delete state.failedAtMs;
      return;
    }
    state.projection = projection;
    delete state.failedAtMs;
  }

  /**
   * `backing-off`: before any RPC. Serves a fresh projection, or — while the
   * last refresh failed less than one tick ago — the still-admissible stale
   * one, so an outage costs one failed pass per tick instead of one per read.
   * `refresh-failed`: this caller's own refresh just failed.
   */
  #serve<T>(
    input: ContextGraphAuthorityIndexProjectionReadInput<T>,
    reason: 'backing-off' | 'refresh-failed',
  ): ProjectionCacheLookup<T> {
    const state = this.#scopes.get(input.scope);
    const projection = state?.projection;
    if (projection === undefined) return PROJECTION_CACHE_MISS;
    const now = this.#now();
    const ageMs = now - projection.fetchedAtMs;
    // A wall clock that stepped backwards proves no age at all.
    if (ageMs < 0 || ageMs > this.staleMs) return PROJECTION_CACHE_MISS;
    if (now - projection.head.timestampSeconds * 1_000 > this.#headTimestampToleranceMs) {
      return PROJECTION_CACHE_MISS;
    }
    const fresh = ageMs < this.tickMs;
    if (!fresh && reason === 'backing-off') {
      const failedAtMs = state?.failedAtMs;
      if (failedAtMs === undefined) return PROJECTION_CACHE_MISS;
      const sinceFailureMs = now - failedAtMs;
      if (sinceFailureMs < 0 || sinceFailureMs >= this.tickMs) {
        return PROJECTION_CACHE_MISS;
      }
    }
    const projected = input.project(projection);
    if (!projected.complete) return PROJECTION_CACHE_MISS;
    // A RETAINED fold is still a fold. Labelling it `cache` here would relaunder
    // exactly what `#refresh` above stopped: `cache` tells a consumer that some
    // scan of this read class produced the entry and that `ageMs` dates that
    // scan, and neither is true of rows the tick folded. `stale-cache` wins when
    // it applies, because "a refresh FAILED" is the stronger statement — it is
    // evidence against the pool, where a fold is merely silent about it.
    input.onServed?.(Object.freeze({
      source: !fresh
        ? 'stale-cache'
        : (projectionFoldedStoredRows(projection) ? 'log' : 'cache'),
      ageMs,
    }));
    return { hit: true, value: projected.value };
  }

  #scopeState(scope: string): ContextGraphAuthorityProjectionScopeState {
    let state = this.#scopes.get(scope);
    if (state === undefined) {
      state = { generation: 0, activeRefreshes: 0 };
      this.#scopes.set(scope, state);
    }
    return state;
  }

  #deleteScopeIfIdle(
    scope: string,
    state: ContextGraphAuthorityProjectionScopeState,
  ): void {
    if (
      state.activeRefreshes === 0
      && state.projection === undefined
      && state.refreshing === undefined
      && state.failedAtMs === undefined
      && this.#scopes.get(scope) === state
    ) this.#scopes.delete(scope);
  }
}
