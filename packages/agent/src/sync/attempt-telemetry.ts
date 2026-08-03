// SPDX-License-Identifier: Apache-2.0
/**
 * W1 sync measurement — the record sites for I1–I6.
 *
 * Both request lanes report through the helpers here (never through each
 * other's transport): the legacy page lane calls them from the send-only
 * bracket in `p2p/sync-transport.ts`, and the OT-RFC-59 changelog lane calls
 * them from its own `sendToPeer` closure. Routing changelog through
 * `sendSyncRequest` to share the instrumentation would drag `withRetry`,
 * single-use payload semantics and the legacy busy validator along with it.
 *
 * ## Two rules this module exists to enforce
 *
 * 1. **Instrumentation never throws on the hot path.** Every emission is
 *    guarded, and every label is clamped to a closed vocabulary — an unknown
 *    value becomes `unspecified` rather than widening the label space or
 *    raising. The normalizers deliberately mirror `normalizeSyncAdmissionSource`
 *    (`sync/policy.ts`) rather than inventing a new abstraction.
 * 2. **No Context Graph id and no peer id, ever.** Nothing here accepts one.
 *
 * ## Why the admission source is ambient
 *
 * `source` is trigger attribution: it is decided once, at the single admission
 * choke point (`runContextGraphSyncWithBackpressure`), and is then a property of
 * the whole operation rather than of any individual send. The physical send sits
 * ~8 call frames below that boundary, behind several injected `fetchSyncPages`
 * dependency signatures, and one of those paths — the changelog lane's
 * `runResync` fallback — re-enters the legacy lane, where the source is not in
 * scope at all. Passing it down as a parameter would leave that fallback's bytes
 * attributed to `unspecified`, i.e. exactly the silently partial denominator the
 * two-lane requirement exists to prevent.
 *
 * Carrying it in an `AsyncLocalStorage` follows the established idiom in
 * `packages/chain/src/rpc-usage.ts` (`withRpcUsageConsumer` /
 * `activeRpcUsageConsumer`, same "clamp to a closed set, never throw" contract),
 * and it makes one hard constraint STRUCTURAL rather than merely tested: the
 * source is never a value any coalescing/single-flight key builder can see, so
 * it cannot leak into a key. `plane` and `phase` stay explicit parameters —
 * those vary per attempt and are always locally available.
 *
 * Coalesced work is attributed to the fetch's OWNER, because the shared promise
 * is created inside the owner's context. That ambiguity is deliberate and is
 * owned by I6: a cross-family join invalidates the observation window.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getMetrics } from '@origintrail-official/dkg-core';
import { normalizeSyncAdmissionSource, type SyncAdmissionSource } from './policy.js';
import { getSyncBackpressureBusyError } from './backpressure.js';

/** The clamp target for every vocabulary here, including `source`. */
const UNSPECIFIED = 'unspecified';

/**
 * Each closed vocabulary is declared ONCE, as an `as const` array, with both the
 * union type and the runtime clamp set derived from it.
 *
 * Declaring the two separately let them drift silently in the one direction
 * that matters: adding a member to the union but not to the `Set` type-checks
 * at every call site and then records `unspecified`, so the label space stays
 * correct while the data quietly stops meaning what the type says it means.
 * Deriving both from one array makes that state unrepresentable.
 */
export const SYNC_ATTEMPT_TRANSPORTS = ['legacy', 'changelog'] as const;
export type SyncAttemptTransport = (typeof SYNC_ATTEMPT_TRANSPORTS)[number];

export const SYNC_ATTEMPT_PLANES = ['durable', 'shared-memory'] as const;
export type SyncAttemptPlane = (typeof SYNC_ATTEMPT_PLANES)[number];

/** `delta` is the changelog lane's only phase; the rest mirror `SyncPhase`. */
export const SYNC_ATTEMPT_PHASES = ['data', 'meta', 'snapshot', 'catalog', 'delta'] as const;
export type SyncAttemptPhase = (typeof SYNC_ATTEMPT_PHASES)[number];
/**
 * Terminal state of one physically invoked send.
 *
 * There is deliberately no `timeout`: the router and pool emit at least seven
 * mutually incompatible deadline-ish shapes, a deadline `TimeoutError` and a
 * caller cancel land on the same `AbortError` differing only in message text,
 * and the only classifiers available are `.message.includes(...)`. Any
 * pre-response rejection that is not caller cancellation is `transport_error`.
 */
export const SYNC_ATTEMPT_OUTCOMES = [
  'response',
  'validation_rejected',
  'cancelled',
  'transport_error',
] as const;
export type SyncAttemptOutcome = (typeof SYNC_ATTEMPT_OUTCOMES)[number];

/**
 * Requester lanes accepted at the I4/I5 seam. Narrower than `SyncSchedulerLane`
 * on purpose: that union also carries responder and pre-authorization lanes,
 * which are not logical sync operations and must not enter the denominator.
 */
export const SYNC_OPERATION_LANES = ['durable', 'changelog', 'shared_memory', 'swm_recovery'] as const;
export type SyncOperationLane = (typeof SYNC_OPERATION_LANES)[number];
/**
 * `resolved`, not `success`: some orchestration paths deliberately catch a
 * per-Context-Graph failure and resolve with fallback diagnostics, so `success`
 * would overclaim domain success.
 */
export const SYNC_OPERATION_OUTCOMES = ['resolved', 'error', 'cancelled'] as const;
export type SyncOperationOutcome = (typeof SYNC_OPERATION_OUTCOMES)[number];

export const SYNC_OPERATION_REJECTION_REASONS = [
  'queue_full',
  'displaced',
  'aborted_before_start',
] as const;
export type SyncOperationRejectionReason = (typeof SYNC_OPERATION_REJECTION_REASONS)[number];

/** One-to-one with the instrumented coalescing maps. */
export const SYNC_SINGLE_FLIGHT_SCOPES = ['context-graph', 'durable', 'shared-memory', 'page'] as const;
export type SyncSingleFlightScope = (typeof SYNC_SINGLE_FLIGHT_SCOPES)[number];

// Every clamp set is BUILT from its vocabulary array above — never re-listed.
// A re-listed member is the drift this file previously allowed.
const TRANSPORTS: ReadonlySet<string> = new Set<string>(SYNC_ATTEMPT_TRANSPORTS);
const PLANES: ReadonlySet<string> = new Set<string>(SYNC_ATTEMPT_PLANES);
const PHASES: ReadonlySet<string> = new Set<string>(SYNC_ATTEMPT_PHASES);
const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set<string>(SYNC_ATTEMPT_OUTCOMES);
const OPERATION_LANES: ReadonlySet<string> = new Set<string>(SYNC_OPERATION_LANES);
const OPERATION_OUTCOMES: ReadonlySet<string> = new Set<string>(SYNC_OPERATION_OUTCOMES);
const REJECTION_REASONS: ReadonlySet<string> = new Set<string>(SYNC_OPERATION_REJECTION_REASONS);
const SINGLE_FLIGHT_SCOPES: ReadonlySet<string> = new Set<string>(SYNC_SINGLE_FLIGHT_SCOPES);

/**
 * Clamp a value to its closed vocabulary. "Closed vocabulary" means CLAMP: a
 * value that crossed a worker/RPC boundary, arrived through a cast, or came
 * from a future member nobody updated here must degrade to `unspecified`, never
 * throw and never widen the label space.
 */
function clampLabel(allowed: ReadonlySet<string>, value: string | undefined): string {
  return typeof value === 'string' && allowed.has(value) ? value : UNSPECIFIED;
}

export function normalizeSyncAttemptTransport(value: string | undefined): string {
  return clampLabel(TRANSPORTS, value);
}

export function normalizeSyncAttemptPlane(value: string | undefined): string {
  return clampLabel(PLANES, value);
}

export function normalizeSyncAttemptPhase(value: string | undefined): string {
  return clampLabel(PHASES, value);
}

export function normalizeSyncAttemptOutcome(value: string | undefined): string {
  return clampLabel(ATTEMPT_OUTCOMES, value);
}

export function normalizeSyncOperationLane(value: string | undefined): string {
  return clampLabel(OPERATION_LANES, value);
}

export function normalizeSyncOperationOutcome(value: string | undefined): string {
  return clampLabel(OPERATION_OUTCOMES, value);
}

export function normalizeSyncOperationRejectionReason(value: string | undefined): string {
  return clampLabel(REJECTION_REASONS, value);
}

export function normalizeSyncSingleFlightScope(value: string | undefined): string {
  return clampLabel(SINGLE_FLIGHT_SCOPES, value);
}

/** `plane` from the boolean every requester seam already carries. */
export function syncPlaneFor(includeSharedMemory: boolean): SyncAttemptPlane {
  return includeSharedMemory ? 'shared-memory' : 'durable';
}

const syncAdmissionSourceContext = new AsyncLocalStorage<SyncAdmissionSource>();

/**
 * Establish the admission source for one logical sync operation. Called ONLY
 * from `runContextGraphSyncWithBackpressure`, which is the single choke point
 * every admission passes through and which already normalizes the value.
 */
export function withSyncAdmissionSource<T>(source: SyncAdmissionSource, fn: () => T): T {
  return syncAdmissionSourceContext.run(normalizeSyncAdmissionSource(source), fn);
}

/**
 * The admission source of the operation this send belongs to. Work that runs
 * outside any admitted operation reports `unspecified` — honestly unattributed
 * rather than guessed. §7.3 treats an `unspecified` sample as a signal that the
 * window is not classifiable, so it must never silently vanish.
 */
export function activeSyncAdmissionSource(): SyncAdmissionSource {
  return syncAdmissionSourceContext.getStore() ?? UNSPECIFIED;
}

/**
 * Is a scope established at all? Tests STORE PRESENCE, deliberately.
 *
 * **The sentinel is not a proxy for absence.** {@link activeSyncAdmissionSource}
 * returns `'unspecified'` for two different states: no scope established, and a
 * scope legitimately HOLDING `'unspecified'`. The second is reachable —
 * `runContextGraphSyncWithBackpressure` normalizes an ABSENT `admission.source`
 * to `'unspecified'` and then establishes the context with that value, so an
 * admitted operation whose caller omitted `source` runs inside a real scope
 * holding the sentinel. (Reachable via `syncFromPeer` → `syncFromPeerDetailed`'s
 * optional `source`; not confirmed observed in production — which is reason
 * enough to be exact rather than lucky, since being exact costs one accessor.)
 *
 * A caller asking "is this work unattributed?" must therefore ask THIS, never
 * `activeSyncAdmissionSource() === 'unspecified'`. Comparing the value would
 * relabel a genuinely unattributed admitted operation as though its trigger
 * were known — laundering "we do not know" into a confident answer, which is
 * exactly what §7.3's gate exists to catch. **Do not simplify this back into a
 * value comparison.**
 */
export function hasSyncAdmissionSource(): boolean {
  return syncAdmissionSourceContext.getStore() !== undefined;
}

/**
 * The `{transport, plane, phase, source}` labels shared by I1–I3 for one
 * attempt. Resolved once so all three points of a single attempt agree, and so
 * the ambient read happens exactly once per attempt rather than three times.
 */
export interface SyncAttemptAttributes {
  readonly transport: string;
  readonly plane: string;
  readonly phase: string;
  readonly source: string;
}

export function syncAttemptAttributes(input: {
  transport: SyncAttemptTransport;
  plane: SyncAttemptPlane;
  phase: SyncAttemptPhase | string;
  /** Omitted ⇒ taken from the ambient admission context. */
  source?: SyncAdmissionSource;
}): SyncAttemptAttributes {
  return {
    transport: normalizeSyncAttemptTransport(input.transport),
    plane: normalizeSyncAttemptPlane(input.plane),
    phase: normalizeSyncAttemptPhase(input.phase),
    source: normalizeSyncAdmissionSource(input.source ?? activeSyncAdmissionSource()),
  };
}

/**
 * Elapsed-time source for I4. `performance.now()` is monotonic; `Date.now()`
 * follows wall-clock corrections, and an NTP step during a long sync would
 * otherwise produce a negative or wildly inflated occupancy sample.
 */
export const monotonicNowMs: () => number = typeof performance?.now === 'function'
  ? () => performance.now()
  : Date.now;

/**
 * Did the caller cancel, rather than the operation fail? Both an abort while
 * queued and an abort mid-work surface as an `AbortError`; libp2p's transport
 * layer additionally raises `DOMException`s carrying `code: 'ABORT_ERR'`
 * (existing precedent: `dkg-agent-registry.ts`'s dial classifier).
 */
export function isSyncOperationCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

/**
 * Why an operation never started. Derived from the admission error's own TYPE
 * (`SyncBackpressureBusyError.reason`, reached through the standard
 * `Error.cause` chain), never from its message. Anything else that prevented
 * the work closure from running is cancellation before start.
 */
export function syncOperationRejectionReason(error: unknown): SyncOperationRejectionReason {
  return getSyncBackpressureBusyError(error)?.reason ?? 'aborted_before_start';
}

/** Bytes must be a finite, non-negative number before they reach a counter. */
function usableByteLength(byteLength: number): number | undefined {
  return Number.isFinite(byteLength) && byteLength >= 0 ? byteLength : undefined;
}

/**
 * I2 — encoded request payload bytes at the router boundary. Recorded ONCE,
 * immediately before the send is invoked, so an attempt that never receives a
 * response still contributes its request bytes.
 */
export function recordSyncAttemptRequestBytes(
  attributes: SyncAttemptAttributes,
  byteLength: number,
): void {
  const bytes = usableByteLength(byteLength);
  if (bytes === undefined) return;
  try {
    getMetrics().syncAttemptRequestBytes.add(bytes, { ...attributes });
  } catch {
    /* instrumentation must never break a sync send */
  }
}

/** I1 — exactly one terminal point per physically invoked send. */
export function recordSyncAttempt(
  attributes: SyncAttemptAttributes,
  outcome: SyncAttemptOutcome,
): void {
  try {
    getMetrics().syncAttemptTotal.add(1, {
      ...attributes,
      outcome: normalizeSyncAttemptOutcome(outcome),
    });
  } catch {
    /* instrumentation must never break a sync send */
  }
}

/**
 * I3 — encoded response payload bytes. Emitted only when the send RESOLVED,
 * including a response the in-transport validator then rejected.
 */
export function recordSyncAttemptResponseBytes(
  attributes: SyncAttemptAttributes,
  byteLength: number,
  outcome: SyncAttemptOutcome,
): void {
  const bytes = usableByteLength(byteLength);
  if (bytes === undefined) return;
  try {
    getMetrics().syncAttemptResponseBytes.add(bytes, {
      ...attributes,
      outcome: normalizeSyncAttemptOutcome(outcome),
    });
  } catch {
    /* instrumentation must never break a sync send */
  }
}

/**
 * I4 — active occupancy of ONE completed logical sync operation, excluding
 * admission queue wait. Its `count` is the operation denominator, so a call
 * that never started must not appear here at all — see
 * {@link recordSyncOperationRejected}.
 */
export function recordSyncOperationDuration(input: {
  lane: SyncOperationLane;
  source: SyncAdmissionSource;
  outcome: SyncOperationOutcome;
  durationMs: number;
}): void {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  try {
    getMetrics().syncOperationDurationMs.record(input.durationMs, {
      lane: normalizeSyncOperationLane(input.lane),
      source: normalizeSyncAdmissionSource(input.source),
      outcome: normalizeSyncOperationOutcome(input.outcome),
    });
  } catch {
    /* instrumentation must never break a sync operation */
  }
}

/**
 * I5 — an operation rejected BEFORE starting. Kept separate from I4 so
 * never-started work can never enter the duration histogram as a 0 ms sample,
 * which would deflate the mean and inflate the denominator at once.
 */
export function recordSyncOperationRejected(input: {
  lane: SyncOperationLane;
  source: SyncAdmissionSource;
  reason: SyncOperationRejectionReason;
}): void {
  try {
    getMetrics().syncOperationRejectedTotal.add(1, {
      lane: normalizeSyncOperationLane(input.lane),
      source: normalizeSyncAdmissionSource(input.source),
      reason: normalizeSyncOperationRejectionReason(input.reason),
    });
  } catch {
    /* instrumentation must never break a sync operation */
  }
}

/**
 * I6 — a coalescing/single-flight join, recorded at MAP-HIT time (before any
 * bytes move, and before the joined work can finish). `owner_source` is stored
 * as metadata beside the shared promise; it is never part of the key.
 */
export function recordSyncSingleFlightJoin(input: {
  scope: SyncSingleFlightScope;
  ownerSource: SyncAdmissionSource;
  joinerSource: SyncAdmissionSource;
}): void {
  try {
    getMetrics().syncSingleflightJoinsTotal.add(1, {
      scope: normalizeSyncSingleFlightScope(input.scope),
      owner_source: normalizeSyncAdmissionSource(input.ownerSource),
      joiner_source: normalizeSyncAdmissionSource(input.joinerSource),
    });
  } catch {
    /* instrumentation must never break a sync operation */
  }
}
