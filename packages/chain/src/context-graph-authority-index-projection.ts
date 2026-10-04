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
import type { ChainIndexAuthorityAnchor } from './chain-index/chain-index-anchor.js';
import {
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
} from
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
const RETRY_REFRESH_HORIZON_RACE = Symbol('retry-refresh-horizon-race');

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
  | Readonly<{
    kind: 'log';
    dataFetchedAtMs: number;
    /**
     * The anchor this fold was admitted under, kept so a later revalidation
     * can ask the LOG whether anything moved instead of asking the chain.
     *
     * Type-only import: this module keeps no runtime dependency on the index.
     * Optional because a fold recorded before this field existed, or by a
     * caller that has no log source, must still be servable — every consumer
     * treats its absence as "cannot prove it locally", never as a mismatch.
     */
    anchor?: ChainIndexAuthorityAnchor;
  }>;

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
  /** True when the view contains an unpersisted reorgable tail above the durable cursor. */
  readonly requiresAnchorValidation?: boolean;
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

export function isContextGraphAuthorityIndexProjectionFault(
  value: unknown,
): value is ContextGraphAuthorityIndexProjectionFault {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'context-graph-authority-projection-fault';
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
  /**
   * Re-read the anchor before serving a projection that contains an unsettled
   * tail. `undefined` means the provider could not answer; `false` proves a
   * mismatch and invalidates the retained projection.
   */
  readonly validateAnchor?: (
    projection: ContextGraphAuthorityIndexProjection,
  ) => Promise<boolean | undefined>;
  /**
   * An explicitly opted-in incomplete projection may be served only when a
   * fresh external finality read proves it still covers the selected block.
   * This is used for absent name bindings; elapsed time alone cannot prove a
   * graph has not been registered since the projection was built.
   */
  readonly validateIncomplete?: (
    projection: ContextGraphAuthorityIndexProjection,
  ) => Promise<boolean | ContextGraphAuthorityIndexIncompleteProjectionAdmission>;
  /** Today's complete read: head, cursor admission, scan, stabilize. */
  readonly refresh: () => Promise<
    ContextGraphAuthorityIndexCompletedProjection | ContextGraphAuthorityIndexProjectionFault
  >;
  readonly onServed?: (evidence: ContextGraphAuthorityProjectionServedEvidence) => void;
}

/** Admission evidence for one explicitly reusable incomplete projection. */
export type ContextGraphAuthorityIndexIncompleteProjectionAdmission =
  | Readonly<{ admitted: false }>
  | Readonly<{ admitted: true; anchorValidated: boolean }>;

type ContextGraphAuthorityIndexRefreshHorizon = Readonly<{
  number: number;
  hash: string;
}>;

type ContextGraphAuthorityRefreshHorizonConstraint = Readonly<{
  number: number;
  hashes: ReadonlySet<string>;
  rejectAtNumber: boolean;
}>;

type ContextGraphAuthorityRecoveryBoundary = Readonly<{
  repositoryKey: string;
  token: number;
  rejectionRevision: number;
  marker: object;
}>;

export type ContextGraphAuthorityIndexRecoveryProof = object;

/** Physical durable-scan ownership for one tentative publication horizon. */
export interface ContextGraphAuthorityIndexRefreshHorizonLease {
  /** Checkpoint recovery began; a successful scan may replace the old floor. */
  markCheckpointRejected(repositoryKey: string, rejectedToken: number): void;
  /** The store installed or exposed a tombstone after the rejected token. */
  markCheckpointRecovery(
    repositoryKey: string,
    rejectedToken: number,
    recoveryToken: number | undefined,
  ): void;
  /** Record one repository row only after this physical scan admitted it. */
  admitDurableGeneration(
    repositoryKey: string,
    kind: 'missing' | 'tombstone' | 'checkpoint' | 'invalid',
    token: number | undefined,
  ): void;
  /** Record a CAS commit descended from the generation admitted above. */
  commitDurableGeneration(repositoryKey: string, token: number): void;
  /** Opaque physical provenance consumed by every waiter for this flight. */
  recoveryProof(): ContextGraphAuthorityIndexRecoveryProof | undefined;
  /** Settle from the lifecycle-owned physical promise, never a caller wait. */
  commit(outcome: Readonly<{
    checkpointRejected: boolean;
    recoveryProof: ContextGraphAuthorityIndexRecoveryProof | undefined;
  }>): void;
  rollback(): void;
}

/** Every mutable invariant for one physical deployment/contract scope. */
interface ContextGraphAuthorityProjectionScopeState {
  generation: number;
  activeRefreshes: number;
  /** Includes inactive `view()` leases so invalidation cannot orphan them. */
  unsettledRefreshHorizonLeases: number;
  /** Every rejection invalidates lineage evidence observed before it. */
  rejectionRevision: number;
  /** Last successful durable background scan (or successful fork rebuild). */
  committedRefreshHorizon?: ContextGraphAuthorityIndexRefreshHorizon;
  /** Physical scans that fence projections until they succeed or fail. */
  activeRefreshHorizons?: Map<object, ContextGraphAuthorityIndexRefreshHorizon>;
  /** Failed checkpoint recovery disproved every projection through this height. */
  rejectedRefreshThrough?: number;
  /** Greatest rejected generation per durable repository key. */
  rejectedDurableThroughTokens?: Map<string, number>;
  /** Safe tombstone/re-admitted generation per durable repository key. */
  recoveryBoundaries?: Map<string, ContextGraphAuthorityRecoveryBoundary>;
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
  /** Lifecycle epoch prevents a pre-clear lease from resurrecting a floor. */
  #refreshHorizonEpoch = 0;

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

  /** A checkpoint or cached-anchor proof invalidated this projection only. */
  drop(scope: string): void {
    this.dropProjection(scope);
  }

  /** Drop one projection generation without forgetting its durable floor. */
  dropProjection(scope: string): void {
    const state = this.#scopes.get(scope);
    if (state === undefined) return;
    this.#invalidateProjectionState(state);
    this.#deleteScopeIfIdle(scope, state);
  }

  /**
   * Tentatively fence projections at one physical durable-scan horizon.
   * Settlement belongs to the physical promise: caller cancellation neither
   * commits nor rolls this lease back.
   */
  beginRefreshHorizon(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
    active: boolean,
  ): ContextGraphAuthorityIndexRefreshHorizonLease {
    const finalizedHash = normalizeHash(finalized.hash);
    if (!Number.isSafeInteger(finalized.number)
      || finalized.number < 0
      || finalizedHash === undefined) {
      throw new Error('Context Graph authority refresh horizon is invalid');
    }
    const state = this.#scopeState(scope);
    state.unsettledRefreshHorizonLeases += 1;
    const horizon = Object.freeze({
      number: finalized.number,
      hash: finalizedHash,
    });
    const token = Object.freeze({});
    const epoch = this.#refreshHorizonEpoch;
    const startsActive = active;
    const rejectionRevisionAtStart = state.rejectionRevision;
    let activated = false;
    let checkpointRejected = false;
    const rejectedTokens = new Map<string, number>();
    let durableRepositoryKey: string | undefined;
    let durableToken: number | undefined;
    let rootRepositoryKey: string | undefined;
    let rootRejectionRevision: number | undefined;
    let recoveryBoundary: ContextGraphAuthorityRecoveryBoundary | undefined;
    let settled = false;
    const leaseIsCurrent = (): boolean => (
      epoch === this.#refreshHorizonEpoch && this.#scopes.get(scope) === state
    );
    const releaseLease = (): void => {
      if (this.#scopes.get(scope) !== state) return;
      state.unsettledRefreshHorizonLeases -= 1;
      this.#deleteScopeIfIdle(scope, state);
    };
    const assertRepositoryKey = (repositoryKey: string): void => {
      if (repositoryKey.trim().length === 0) {
        throw new Error('Context Graph authority durable repository key is empty');
      }
    };
    const publishRecoveryBoundary = (
      repositoryKey: string,
      boundaryToken: number,
    ): ContextGraphAuthorityRecoveryBoundary | undefined => {
      if (!leaseIsCurrent() || state.rejectedRefreshThrough === undefined) return undefined;
      const rejectedThrough = state.rejectedDurableThroughTokens?.get(repositoryKey) ?? -1;
      if (boundaryToken <= rejectedThrough) return undefined;
      const boundaries = state.recoveryBoundaries ?? new Map();
      const existing = boundaries.get(repositoryKey);
      if (existing !== undefined) return existing;
      const boundary = Object.freeze({
        repositoryKey,
        token: boundaryToken,
        rejectionRevision: state.rejectionRevision,
        marker: Object.freeze({}),
      });
      boundaries.set(repositoryKey, boundary);
      state.recoveryBoundaries = boundaries;
      return boundary;
    };
    const activate = (): void => {
      if (activated || settled || !leaseIsCurrent()) return;
      const before = this.#effectiveRefreshHorizon(state);
      const horizons = state.activeRefreshHorizons ?? new Map();
      horizons.set(token, horizon);
      state.activeRefreshHorizons = horizons;
      activated = true;
      const after = this.#effectiveRefreshHorizon(state);
      // An identical/lower compatible tick must not discard a fresh answer.
      // A higher or conflicting fence must also detach a cold active owner.
      if (!this.#sameRefreshHorizonConstraint(before, after)) {
        const projectionIsObsolete = state.projection !== undefined
          && !this.#finalizedAtOrAboveRefreshHorizon(state.projection.finalized, after);
        const refreshOwnerIsUnfenced = state.refreshing !== undefined;
        if (projectionIsObsolete || refreshOwnerIsUnfenced) {
          state.generation += 1;
          if (projectionIsObsolete) delete state.projection;
          delete state.failedAtMs;
          if (refreshOwnerIsUnfenced) delete state.refreshing;
        }
      }
    };
    if (startsActive) activate();

    return Object.freeze({
      markCheckpointRejected: (repositoryKey: string, rejectedToken: number): void => {
        if (settled) return;
        assertRepositoryKey(repositoryKey);
        if (!Number.isSafeInteger(rejectedToken) || rejectedToken < 1) {
          throw new Error('Context Graph authority rejected durable token is invalid');
        }
        checkpointRejected = true;
        if (!leaseIsCurrent()) return;
        state.rejectionRevision += 1;
        // A proof observed before this rejection—on this durable key or an
        // alternate bootstrap/fallback key—cannot discharge the newer fence.
        delete state.recoveryBoundaries;
        rejectedTokens.set(repositoryKey, Math.max(
          rejectedTokens.get(repositoryKey) ?? -1,
          rejectedToken,
        ));
        const rejectedDurableThroughTokens = state.rejectedDurableThroughTokens ?? new Map();
        const rejectedDurableThroughToken = Math.max(
          rejectedDurableThroughTokens.get(repositoryKey) ?? -1,
          rejectedToken,
        );
        rejectedDurableThroughTokens.set(repositoryKey, rejectedDurableThroughToken);
        state.rejectedDurableThroughTokens = rejectedDurableThroughTokens;
        if (rootRepositoryKey === repositoryKey) rootRepositoryKey = undefined;
        if (rootRepositoryKey === undefined) rootRejectionRevision = undefined;
        recoveryBoundary = undefined;
        state.rejectedRefreshThrough = Math.max(
          state.rejectedRefreshThrough ?? -1,
          state.committedRefreshHorizon?.number ?? -1,
          horizon.number,
        );
        activate();
        // The old durable lineage was disproved now, not only if the rebuild
        // later succeeds. Refuse it throughout recovery and after any failure.
        this.#invalidateProjectionState(state);
      },
      markCheckpointRecovery: (
        repositoryKey: string,
        rejectedToken: number,
        recoveryToken: number | undefined,
      ): void => {
        if (settled || !leaseIsCurrent() || recoveryToken === undefined) return;
        assertRepositoryKey(repositoryKey);
        if (!Number.isSafeInteger(rejectedToken) || rejectedToken < 1
          || !Number.isSafeInteger(recoveryToken) || recoveryToken < 1) {
          throw new Error('Context Graph authority recovery durable token is invalid');
        }
        if (recoveryToken <= rejectedToken) return;
        publishRecoveryBoundary(repositoryKey, recoveryToken);
      },
      admitDurableGeneration: (
        repositoryKey: string,
        kind: 'missing' | 'tombstone' | 'checkpoint' | 'invalid',
        admittedToken: number | undefined,
      ): void => {
        if (settled || !leaseIsCurrent()) return;
        assertRepositoryKey(repositoryKey);
        if (kind === 'missing') {
          if (admittedToken !== undefined) {
            throw new Error('Context Graph authority missing generation has a durable token');
          }
          durableRepositoryKey = repositoryKey;
          durableToken = undefined;
          rootRepositoryKey = repositoryKey;
          rootRejectionRevision = state.rejectionRevision;
          recoveryBoundary = undefined;
          return;
        }
        if (admittedToken === undefined
          || !Number.isSafeInteger(admittedToken)
          || admittedToken < 1) {
          throw new Error('Context Graph authority admitted durable token is invalid');
        }
        if (kind === 'invalid') {
          throw new Error('Context Graph authority invalid durable generation was admitted');
        }
        durableRepositoryKey = repositoryKey;
        durableToken = admittedToken;
        const descendedFromRoot = rootRepositoryKey === repositoryKey;
        const rootIsCurrent = descendedFromRoot
          && rootRejectionRevision === state.rejectionRevision;
        rootRepositoryKey = kind === 'tombstone' ? repositoryKey : undefined;
        rootRejectionRevision = kind === 'tombstone'
          ? state.rejectionRevision
          : undefined;
        recoveryBoundary = undefined;
        if (kind === 'tombstone') {
          recoveryBoundary = publishRecoveryBoundary(repositoryKey, admittedToken);
          return;
        }
        const repositoryHasNoRejectedLineage =
          !state.rejectedDurableThroughTokens?.has(repositoryKey);
        const followsCompletedRecovery = rejectionRevisionAtStart === state.rejectionRevision
          && [...(state.recoveryBoundaries?.values() ?? [])]
            .some((boundary) => boundary.rejectionRevision === state.rejectionRevision);
        const independentlyReadmitted = repositoryHasNoRejectedLineage && (
          rejectedTokens.size > 0
          || followsCompletedRecovery
        );
        const boundary = rootIsCurrent || independentlyReadmitted
          ? publishRecoveryBoundary(repositoryKey, admittedToken)
          : state.recoveryBoundaries?.get(repositoryKey);
        if (boundary !== undefined && admittedToken >= boundary.token) {
          recoveryBoundary = boundary;
        }
      },
      commitDurableGeneration: (repositoryKey: string, committedToken: number): void => {
        if (settled || !leaseIsCurrent()) return;
        assertRepositoryKey(repositoryKey);
        if (!Number.isSafeInteger(committedToken) || committedToken < 1) {
          throw new Error('Context Graph authority committed durable token is invalid');
        }
        durableRepositoryKey = repositoryKey;
        durableToken = committedToken;
        if (rootRepositoryKey === repositoryKey
          && rootRejectionRevision !== state.rejectionRevision) {
          // This lineage was admitted before a newer rejection. Advancing its
          // CAS token—once or across many pages—does not make it independent.
          rootRepositoryKey = undefined;
          rootRejectionRevision = undefined;
          recoveryBoundary = undefined;
        }
        if (rootRepositoryKey === repositoryKey) {
          recoveryBoundary = publishRecoveryBoundary(repositoryKey, committedToken);
        } else if (recoveryBoundary?.repositoryKey !== repositoryKey
          || committedToken < recoveryBoundary.token) {
          recoveryBoundary = undefined;
        }
      },
      recoveryProof: (): ContextGraphAuthorityIndexRecoveryProof | undefined => {
        if (!leaseIsCurrent()
          || recoveryBoundary === undefined
          || durableRepositoryKey !== recoveryBoundary.repositoryKey
          || durableToken === undefined
          || durableToken < recoveryBoundary.token
          || recoveryBoundary.rejectionRevision !== state.rejectionRevision
          || state.recoveryBoundaries?.get(recoveryBoundary.repositoryKey) !== recoveryBoundary) {
          return undefined;
        }
        return recoveryBoundary.marker;
      },
      commit: (outcome: Readonly<{
        checkpointRejected: boolean;
        recoveryProof: ContextGraphAuthorityIndexRecoveryProof | undefined;
      }>): void => {
        if (settled) return;
        settled = true;
        if (!leaseIsCurrent()) {
          releaseLease();
          return;
        }
        if (activated) state.activeRefreshHorizons?.delete(token);
        const replacesCheckpoint = checkpointRejected || outcome.checkpointRejected;
        const recoversRejectedGeneration = state.rejectedRefreshThrough !== undefined
          && outcome.recoveryProof !== undefined
          && [...(state.recoveryBoundaries?.values() ?? [])]
            .some((boundary) => boundary.marker === outcome.recoveryProof);
        if (recoversRejectedGeneration) {
          // A successful rebuild proved the prior durable lineage wrong, so a
          // lower or same-height replacement is intentional rather than lag.
          // A later scan that admitted the resulting tombstone/partial row can
          // carry the same repository-scoped proof and finish that recovery.
          this.#invalidateProjectionState(state);
          state.committedRefreshHorizon = horizon;
          delete state.rejectedRefreshThrough;
          delete state.rejectedDurableThroughTokens;
          delete state.recoveryBoundaries;
        } else if (startsActive && !replacesCheckpoint) {
          const committed = state.committedRefreshHorizon;
          if (committed === undefined
            || horizon.number > committed.number
            || (horizon.number === committed.number && horizon.hash !== committed.hash)) {
            state.committedRefreshHorizon = horizon;
          }
        }
        if (state.activeRefreshHorizons?.size === 0) delete state.activeRefreshHorizons;
        releaseLease();
      },
      rollback: (): void => {
        if (settled) return;
        settled = true;
        if (!leaseIsCurrent()) {
          releaseLease();
          return;
        }
        if (activated) state.activeRefreshHorizons?.delete(token);
        if (state.activeRefreshHorizons?.size === 0) delete state.activeRefreshHorizons;
        releaseLease();
      },
    });
  }

  /** Read-your-writes invalidation keeps durable refresh knowledge intact. */
  dropAll(): void {
    for (const scope of this.#scopes.keys()) this.dropProjection(scope);
  }

  /** Refuse an endpoint view older than the durable refresh already observed. */
  assertAtOrAboveRefreshHorizon(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): void {
    const refreshHorizon = this.#effectiveRefreshHorizon(this.#scopes.get(scope));
    if (refreshHorizon === undefined) return;
    if (this.#finalizedAtOrAboveRefreshHorizon(finalized, refreshHorizon)) return;
    throw new ContextGraphAuthorityIndexRetryableError(
      `Context Graph authority projection anchor ${finalized.number}:${finalized.hash} `
      + `is behind durable refresh horizon ${refreshHorizon.number}:`
      + `${refreshHorizon.rejectAtNumber
        ? '<checkpoint-rejected>'
        : [...refreshHorizon.hashes].join(',')}`,
      'refresh-horizon-ahead',
    );
  }

  /**
   * Hub/contract rotation or adapter teardown: nothing scanned before it may
   * answer, and no pre-clear horizon lease may resurrect state afterward.
   */
  clear(): void {
    this.#refreshHorizonEpoch += 1;
    for (const [scope, state] of this.#scopes) {
      state.generation += 1;
      delete state.committedRefreshHorizon;
      delete state.activeRefreshHorizons;
      delete state.rejectedRefreshThrough;
      delete state.rejectedDurableThroughTokens;
      delete state.recoveryBoundaries;
      delete state.projection;
      delete state.failedAtMs;
      delete state.refreshing;
      this.#deleteScopeIfIdle(scope, state);
    }
  }

  /**
   * Serve ONLY what this cache already holds. Never scans, never refreshes.
   *
   * {@link read} below exists to answer at any cost: a miss waits for an
   * in-flight refresh and then performs one itself, which is a live head read,
   * a paged `eth_getLogs` scan back to the deployment block and a stabilization
   * fence. That is the correct behaviour for a caller that NEEDS the answer.
   *
   * It is the wrong behaviour for a caller that merely PREFERS a local one. A
   * bounded-freshness reader is trying to avoid a single `eth_call`; escalating
   * its miss into a full rescan would cost orders of magnitude more than the
   * read it was trying to skip, and would do so exactly when the index is cold
   * — at startup, after a Hub rotation, on first contact with a graph — which
   * is when the most callers arrive at once.
   *
   * So a miss here is simply a miss. The caller falls back to whatever it would
   * have done anyway, and the index catches up on its own tick.
   *
   * Every admission rule {@link read} applies still applies: the service
   * window, the completeness predicate, and the anchor validation for a
   * projection carrying an unsettled tail. This only removes the escalation.
   */
  async peek<T>(
    input: Omit<ContextGraphAuthorityIndexProjectionReadInput<T>, 'refresh'>,
  ): Promise<Readonly<{ hit: true; value: T } | { hit: false }>> {
    input.signal?.throwIfAborted();
    // `refresh` is structurally required by the shared input and is never
    // reachable from here — `#serve` only ever reads retained state. It is
    // supplied as a thrower rather than a no-op so that a future edit which
    // does reach it fails loudly instead of silently returning nothing.
    const served = await this.#serve(
      {
        ...input,
        refresh: () => {
          throw new Error('peek must never refresh a Context Graph authority projection');
        },
      } as ContextGraphAuthorityIndexProjectionReadInput<T>,
      'backing-off',
    );
    return served.hit
      ? Object.freeze({ hit: true as const, value: served.value })
      : Object.freeze({ hit: false as const });
  }

  async read<T>(input: ContextGraphAuthorityIndexProjectionReadInput<T>): Promise<T> {
    input.signal?.throwIfAborted();
    const cached = await this.#serve(input, 'backing-off');
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
      const published = await this.#serve(input, 'backing-off');
      if (published.hit) return published.value;
    }
    const refreshed = await this.#refresh(input, true);
    return refreshed === RETRY_REFRESH_HORIZON_RACE
      ? this.#refresh(input, false)
      : refreshed;
  }

  async #refresh<T>(
    input: ContextGraphAuthorityIndexProjectionReadInput<T>,
    retryPostRefreshHorizonRace: false,
  ): Promise<T>;
  async #refresh<T>(
    input: ContextGraphAuthorityIndexProjectionReadInput<T>,
    retryPostRefreshHorizonRace: true,
  ): Promise<T | typeof RETRY_REFRESH_HORIZON_RACE>;
  async #refresh<T>(
    input: ContextGraphAuthorityIndexProjectionReadInput<T>,
    retryPostRefreshHorizonRace: boolean,
  ): Promise<T | typeof RETRY_REFRESH_HORIZON_RACE> {
    input.signal?.throwIfAborted();
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
        if (completed.scope !== input.scope) {
          throw new ContextGraphAuthorityIndexRetryableError(
            `Context Graph authority contract changed during refresh: ${input.scope} -> ${completed.scope}`,
          );
        }
        // A refresh that FOLDED stored rows rather than fetching them answers as
        // of the instant that data was fetched, not as of this read. Retaining
        // and reporting it under `now` would reset its age to zero and buy it a
        // further `tickMs` of service as a FRESH cache entry, so a view already
        // `min(max(3T, 15s), 5m)` behind the chain could be served for that
        // capped bound plus T while every consumer was told it was under T old.
        // The age this cache ages by is the age of the DATA.
        projection = Object.freeze({
          ...completed,
          fetchedAtMs: resolveProjectionFetchedAtMs(
            refreshStartedAtMs,
            completed.origin,
          ),
        });
        try {
          this.assertAtOrAboveRefreshHorizon(input.scope, projection.finalized);
        } catch (error) {
          // A background durable refresh can advance after the provider
          // callback's own fence but before this cache publishes. Re-enter the
          // complete provider read once so the typed miss is still classified
          // inside its failover boundary; a second race propagates fail closed.
          if (retryPostRefreshHorizonRace
            && isContextGraphAuthorityIndexRetryableError(error)
            && error.reason === 'refresh-horizon-ahead') {
            return RETRY_REFRESH_HORIZON_RACE;
          }
          throw error;
        }
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
        if (generation === state.generation
          && error.reason !== 'refresh-horizon-ahead') {
          this.dropProjection(input.scope);
        }
        throw error;
      }
      // Only the chain transport boundary proves an availability outage. A
      // plain/deterministic fault must never be hidden behind stale authority
      // or arm a one-tick backoff that would keep hiding it from later reads.
      if (!isChainRpcTransportError(error)) throw error;
      if (generation === state.generation) {
        state.failedAtMs = this.#now();
      }
      const stale = await this.#serve(input, 'refresh-failed');
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
    // Derive the publication key from what was actually scanned. The refresh
    // boundary has already rejected a contract rotation, and this remains the
    // publication-side invariant protecting the state cell.
    if (this.#scopes.get(projection.scope) !== state) return;
    const refreshHorizon = this.#effectiveRefreshHorizon(state);
    if (refreshHorizon !== undefined
      && !this.#finalizedAtOrAboveRefreshHorizon(
        projection.finalized,
        refreshHorizon,
      )) return;
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
    const now = this.#now();
    if (
      previous !== undefined
      && projection.head.number < previous.head.number
      && now - previous.fetchedAtMs < this.tickMs
      && this.#isWithinServiceWindow(previous, now)
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
  async #serve<T>(
    input: ContextGraphAuthorityIndexProjectionReadInput<T>,
    reason: 'backing-off' | 'refresh-failed',
  ): Promise<ProjectionCacheLookup<T>> {
    const state = this.#scopes.get(input.scope);
    if (state === undefined) return PROJECTION_CACHE_MISS;
    const projection = state.projection;
    if (projection === undefined) return PROJECTION_CACHE_MISS;
    const candidateIsCurrent = (): boolean => (
      this.#scopes.get(input.scope) === state && state.projection === projection
    );
    const now = this.#now();
    const ageMs = now - projection.fetchedAtMs;
    if (!this.#isWithinServiceWindow(projection, now)) return PROJECTION_CACHE_MISS;
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
    let anchorValidated = false;
    if (!projected.complete) {
      if (input.validateIncomplete === undefined) return PROJECTION_CACHE_MISS;
      const admission = await input.validateIncomplete(projection);
      input.signal?.throwIfAborted();
      if (!candidateIsCurrent()) return PROJECTION_CACHE_MISS;
      // Preserve the original deep-module callback contract: `true` admits
      // the incomplete projection but still requires its ordinary tail-anchor
      // validation. The structured result lets a validator explicitly prove
      // that same anchor once and avoid a duplicate provider read.
      if (typeof admission === 'boolean') {
        if (!admission) return PROJECTION_CACHE_MISS;
      } else {
        if (!admission.admitted) return PROJECTION_CACHE_MISS;
        anchorValidated = admission.anchorValidated;
      }
    }
    if (projection.requiresAnchorValidation === true && !anchorValidated) {
      if (input.validateAnchor === undefined) return PROJECTION_CACHE_MISS;
      let anchorIsCurrent: boolean | undefined;
      try {
        anchorIsCurrent = await input.validateAnchor(projection);
      } catch {
        // A tail whose anchor could not be checked is not safe to serve. The
        // ordinary refresh path below retains the original transport error.
        input.signal?.throwIfAborted();
        return PROJECTION_CACHE_MISS;
      }
      input.signal?.throwIfAborted();
      if (!candidateIsCurrent()) return PROJECTION_CACHE_MISS;
      if (anchorIsCurrent === undefined) return PROJECTION_CACHE_MISS;
      if (!anchorIsCurrent) {
        // A mismatched anchor proves the tail projection belongs to a fork.
        this.dropProjection(input.scope);
        return PROJECTION_CACHE_MISS;
      }
    }
    if (!candidateIsCurrent()) return PROJECTION_CACHE_MISS;
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

  /** Time-only cache admission shared by serving and lower-head publication. */
  #isWithinServiceWindow(
    projection: ContextGraphAuthorityIndexProjection,
    now: number,
  ): boolean {
    const ageMs = now - projection.fetchedAtMs;
    // A wall clock that stepped backwards proves no age at all.
    return ageMs >= 0
      && ageMs <= this.staleMs
      && Number.isSafeInteger(projection.head.timestampSeconds)
      && projection.head.timestampSeconds >= 0
      && now - projection.head.timestampSeconds * 1_000
        <= this.#headTimestampToleranceMs;
  }

  #scopeState(scope: string): ContextGraphAuthorityProjectionScopeState {
    let state = this.#scopes.get(scope);
    if (state === undefined) {
      state = {
        generation: 0,
        activeRefreshes: 0,
        unsettledRefreshHorizonLeases: 0,
        rejectionRevision: 0,
      };
      this.#scopes.set(scope, state);
    }
    return state;
  }

  #invalidateProjectionState(state: ContextGraphAuthorityProjectionScopeState): void {
    state.generation += 1;
    delete state.projection;
    delete state.failedAtMs;
    delete state.refreshing;
  }

  #effectiveRefreshHorizon(
    state: ContextGraphAuthorityProjectionScopeState | undefined,
  ): ContextGraphAuthorityRefreshHorizonConstraint | undefined {
    if (state === undefined) return undefined;
    let number = -1;
    const hashes = new Set<string>();
    const include = (horizon: ContextGraphAuthorityIndexRefreshHorizon | undefined): void => {
      if (horizon === undefined || horizon.number < number) return;
      if (horizon.number > number) {
        number = horizon.number;
        hashes.clear();
      }
      hashes.add(horizon.hash);
    };
    include(state.committedRefreshHorizon);
    for (const horizon of state.activeRefreshHorizons?.values() ?? []) include(horizon);
    const rejectedThrough = state.rejectedRefreshThrough ?? -1;
    const rejectAtNumber = rejectedThrough >= number;
    if (rejectedThrough > number) {
      number = rejectedThrough;
      hashes.clear();
    }
    return number < 0 ? undefined : Object.freeze({ number, hashes, rejectAtNumber });
  }

  #sameRefreshHorizonConstraint(
    left: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
    right: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
  ): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.number !== right.number
      || left.rejectAtNumber !== right.rejectAtNumber
      || left.hashes.size !== right.hashes.size) return false;
    for (const hash of left.hashes) if (!right.hashes.has(hash)) return false;
    return true;
  }

  #finalizedAtOrAboveRefreshHorizon(
    finalized: Readonly<{ number: number; hash: string }>,
    refreshHorizon: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
  ): boolean {
    if (refreshHorizon === undefined) return true;
    const finalizedHash = normalizeHash(finalized.hash);
    if (!Number.isSafeInteger(finalized.number)
      || finalized.number < 0
      || finalizedHash === undefined) return false;
    if (finalized.number > refreshHorizon.number) return true;
    return finalized.number === refreshHorizon.number
      && !refreshHorizon.rejectAtNumber
      && refreshHorizon.hashes.size === 1
      && refreshHorizon.hashes.has(finalizedHash);
  }

  #deleteScopeIfIdle(
    scope: string,
    state: ContextGraphAuthorityProjectionScopeState,
  ): void {
    if (
      state.activeRefreshes === 0
      && state.unsettledRefreshHorizonLeases === 0
      && state.committedRefreshHorizon === undefined
      && state.activeRefreshHorizons === undefined
      && state.rejectedRefreshThrough === undefined
      && state.rejectedDurableThroughTokens === undefined
      && state.recoveryBoundaries === undefined
      && state.projection === undefined
      && state.refreshing === undefined
      && state.failedAtMs === undefined
      && this.#scopes.get(scope) === state
    ) this.#scopes.delete(scope);
  }
}
