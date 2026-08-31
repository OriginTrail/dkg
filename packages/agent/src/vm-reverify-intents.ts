// SPDX-License-Identifier: Apache-2.0
/**
 * The re-verification drain's decision table (#2435), as pure functions.
 *
 * Everything the drain decides about ONE intent after ONE repair attempt lives
 * here: whether the asset is proven current, whether to try again and when,
 * whether to stop, or whether to leave the row alone because the node is
 * shutting down. Keeping it pure is what makes the table exhaustively testable
 * — the worker around it does I/O and nothing else.
 *
 * The rule this file exists to enforce, and the one that is easiest to get
 * subtly wrong: **a repair may only RESOLVE an intent when the evidence it
 * acted on was read at or after the block the event was observed at.** The
 * repair primitive reads the committed root from chain through its own failover
 * sequence, which can legitimately land on an endpoint that has not yet seen
 * the update. Such a read says "you are current" about a state of the world
 * that predates the event. Resolving on it deletes the intent and the node
 * serves the old root forever — the original defect, reproduced one layer down
 * and now invisible, because the drain would report success.
 */
import type { KnowledgeAssetRootMutationKindV1 } from '@origintrail-official/dkg-core';

import { ContextGraphNotFoundError } from './dkg-agent-types.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileUnavailableError,
} from './vm-reconcile-service.js';
import {
  ContextGraphAssetFetchConflictError,
  ContextGraphAssetFetchValidationError,
  ExactAssetFetchLifecycleClosedError,
  type ContextGraphAssetFetchItemResult,
} from './sync/exact-asset-fetch.js';
import type { VmReverifyAbandonReason } from './vm-reverify-intent-store.js';

/**
 * Why the last attempt did not settle the intent.
 *
 * `evidence-unavailable` — we could not obtain a trustworthy view of the chain
 * (an endpoint disagreed, or the view it gave predates the event). Usually
 * momentary and usually not our fault, so the first retries are fast.
 *
 * `unresolved` — the chain view was fine and no reachable peer had the version.
 * That is a network-population problem; retrying quickly cannot fix it and
 * costs peer traffic, so it backs off and eventually parks.
 */
export type VmReverifyOutcomeClass = 'evidence-unavailable' | 'unresolved';

/** First retries of an `evidence-unavailable` outcome. */
export const VM_REVERIFY_FLAT_BACKOFF_MS = 30_000;
/** How many of them stay flat before the outage is treated as sustained. */
export const VM_REVERIFY_FLAT_ATTEMPTS = 5;
/** Ceiling of the exponential ladder. */
export const VM_REVERIFY_MAX_BACKOFF_MS = 3_600_000;
/** How long an `unresolved` intent keeps asking peers before it is parked. */
export const VM_REVERIFY_PARK_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * Delay before the next attempt, given the attempt that just completed.
 *
 * `attemptNumber` is 1-based and counts the attempt that produced this outcome,
 * so the first failure of a run yields the first delay.
 *
 * An `evidence-unavailable` outcome retries flat for the first
 * `VM_REVERIFY_FLAT_ATTEMPTS` because RPC non-unanimity is usually a blip. It
 * does NOT stay flat forever: past that point a degraded endpoint pool would
 * otherwise cost 2,880 pinned five-call views per intent per day, so the ladder
 * continues exponentially from its start — fast when it is a blip, quiet when
 * it is an outage.
 *
 * NOTE on the signature: the plan sketched `backoffMs(kind, outcomeClass,
 * attempts)`. `kind` is deliberately absent — no ladder here varies by mutation
 * kind (the only kind-specific rule, `root-removed`, abandons rather than
 * retries), and an argument that never changes the result is an argument nobody
 * checks when it is later passed wrongly.
 */
export function backoffMs(outcomeClass: VmReverifyOutcomeClass, attemptNumber: number): number {
  const attempt = Math.max(1, Math.trunc(attemptNumber));
  // One ladder with a shifted origin, not two. Shifting an `evidence-unavailable`
  // attempt back by the flat window drives its first `VM_REVERIFY_FLAT_ATTEMPTS`
  // steps to or below the ladder's floor, which the clamp below holds at
  // `VM_REVERIFY_FLAT_BACKOFF_MS` — and everything past the window continues up
  // the same curve. (An explicit early return for the flat case was tried and
  // deleted: it was exactly equivalent to the clamp, so no mutation could tell
  // it from its own absence — a branch nothing can falsify.)
  const step = outcomeClass === 'evidence-unavailable'
    ? attempt - VM_REVERIFY_FLAT_ATTEMPTS
    : attempt;
  const exponential = VM_REVERIFY_FLAT_BACKOFF_MS * 2 ** Math.max(0, step - 1);
  return Math.min(VM_REVERIFY_MAX_BACKOFF_MS, exponential);
}

export type VmReverifyResolveReason = 'already-present' | 'materialized' | 'fetched';

export type VmReverifyRetryReason =
  /** The chain view we got was read BEFORE the event. Never resolve on it. */
  | 'snapshot-behind-event'
  /** The item carried no `versionBlock`, so the rule above cannot be applied. */
  | 'version-block-unknown'
  /** Not every configured endpoint answered the pinned view. */
  | 'snapshot-unavailable'
  /** The chain answered, but with a root/block/address this code cannot use. */
  | 'invalid-evidence'
  /** The CG is not (currently) subscribed or hosted here. Non-terminal. */
  | 'context-graph-not-held'
  /** Evidence was fine; nobody reachable had the version. */
  | 'unresolved'
  /**
   * Unresolvable BY CONFIGURATION: the asset needs its version-scoped shared
   * working memory recovered before it can be promoted, and the durable plane
   * that carries SWM is switched off (ADR-W2R-10). Deferred forever rather than
   * parked — an operator who turns the durable plane back on must find the work
   * waiting, and `no-peer-has-version` would be a lie about a node that never
   * got to ask a peer.
   */
  | 'durable-sync-disabled'
  /** An error this table does not recognise. Treated as transient, loudly. */
  | 'unexpected-error';

export type VmReverifyLeaveReason = 'lifecycle-closed' | 'no-result';

/**
 * A discriminated union rather than `{action, reason, delayMs?}` so the worker
 * cannot record a retry without a delay, nor an abandon without one of the
 * store's four reasons.
 */
export type VmReverifyTransition =
  | { action: 'resolve'; reason: VmReverifyResolveReason }
  | {
    action: 'retry';
    reason: VmReverifyRetryReason;
    delayMs: number;
    outcomeClass: VmReverifyOutcomeClass;
  }
  | { action: 'abandon'; reason: VmReverifyAbandonReason }
  | { action: 'leave'; reason: VmReverifyLeaveReason };

export interface VmReverifyTransitionInput {
  kind: KnowledgeAssetRootMutationKindV1;
  /** The per-UAL result, when the call returned. Carries `versionBlock`. */
  item?: Pick<ContextGraphAssetFetchItemResult, 'status' | 'versionBlock'>;
  /** The rejection, when the call threw for this UAL. */
  error?: unknown;
  /** Block of the chain event this intent is about. */
  observedBlock: number;
  /** 1-based index of the attempt that just completed. */
  attemptNumber: number;
  /**
   * Whether the SWM recovery this repair depends on is available at all
   * (ADR-W2R-10 gates it on `durableSyncEnabled`). False turns an `unresolved`
   * item into an indefinite deferral instead of a countdown to a park.
   */
  swmRecoveryAvailable?: boolean;
  /** When this generation first attempted anything; absent before attempt 1. */
  firstAttemptAt?: number;
  now: number;
  /** Park budget; the worker passes its resolved (env-overridable) value. */
  parkAfterMs?: number;
}

function retry(
  reason: VmReverifyRetryReason,
  outcomeClass: VmReverifyOutcomeClass,
  attemptNumber: number,
): VmReverifyTransition {
  return {
    action: 'retry',
    reason,
    outcomeClass,
    delayMs: backoffMs(outcomeClass, attemptNumber),
  };
}

function conflictTransition(
  error: ContextGraphAssetFetchConflictError,
  attemptNumber: number,
): VmReverifyTransition {
  switch (error.code) {
    // Momentary: the endpoint pool did not agree, or answered with something
    // structurally unusable. Both are about OUR view, not about the asset.
    case 'snapshot-unavailable':
      return retry('snapshot-unavailable', 'evidence-unavailable', attemptNumber);
    case 'invalid-evidence':
      return retry('invalid-evidence', 'evidence-unavailable', attemptNumber);
    // Terminal-until-revived: the chain says this UAL is not the asset we think
    // it is. Retrying cannot change that, and doing so quietly would hide a
    // genuine identity problem behind a growing pending count.
    case 'wrong-network':
    case 'not-registered':
    case 'no-committed-version':
    case 'binding-mismatch':
      return { action: 'abandon', reason: 'chain-identity-conflict' };
    default:
      return retry('unexpected-error', 'evidence-unavailable', attemptNumber);
  }
}

/** Shutdown and lifecycle rotation. The row is untouched and retried later. */
function isLifecycleClosure(error: unknown): boolean {
  return error instanceof VmReconcileQueueClosedError
    || error instanceof VmReconcileUnavailableError
    || error instanceof ExactAssetFetchLifecycleClosedError
    || (error instanceof Error && error.name === 'AbortError');
}

export function planTransition(input: VmReverifyTransitionInput): VmReverifyTransition {
  const { kind, item, error, observedBlock, attemptNumber, firstAttemptAt, now } = input;
  const parkAfterMs = input.parkAfterMs ?? VM_REVERIFY_PARK_AFTER_MS;

  if (error !== undefined) {
    if (isLifecycleClosure(error)) return { action: 'leave', reason: 'lifecycle-closed' };
    // The repair primitive rejected our OWN arguments. That is a bug in the
    // caller, not a condition of the network, so it must be loud and must not
    // be retried into a permanent background failure.
    if (error instanceof ContextGraphAssetFetchValidationError) {
      return { action: 'abandon', reason: 'programmer-error' };
    }
    // Not held here right now — an unsubscribe, or a CG whose binding has not
    // been re-established yet. Explicitly NOT terminal: re-hosting is exactly
    // the case this feature is for.
    if (error instanceof ContextGraphNotFoundError) {
      return retry('context-graph-not-held', 'evidence-unavailable', attemptNumber);
    }
    if (error instanceof ContextGraphAssetFetchConflictError) {
      return conflictTransition(error, attemptNumber);
    }
    return retry('unexpected-error', 'evidence-unavailable', attemptNumber);
  }

  if (!item) return { action: 'leave', reason: 'no-result' };

  if (item.status === 'unresolved') {
    // The chain moved BACKWARDS. Every repair route here fetches a version
    // FORWARD from a peer; there is nothing to fetch. Say so once, loudly, and
    // stop — a silent endless retry would be indistinguishable from an
    // unreachable peer and would hide a genuine protocol gap.
    if (kind === 'root-removed') {
      return { action: 'abandon', reason: 'version-regression-unsupported' };
    }
    // BEFORE the park, deliberately. With the durable plane off there is no
    // route by which this could ever resolve, so counting down to
    // `no-peer-has-version` would blame the network for a local switch and
    // would bury the work under a terminal state an operator has no reason to
    // go looking for.
    if (input.swmRecoveryAvailable === false) {
      return retry('durable-sync-disabled', 'evidence-unavailable', attemptNumber);
    }
    if (firstAttemptAt !== undefined && now - firstAttemptAt >= parkAfterMs) {
      return { action: 'abandon', reason: 'no-peer-has-version' };
    }
    return retry('unresolved', 'unresolved', attemptNumber);
  }

  // ── the resolve rule ──
  // An item without a `versionBlock` cannot be checked against the event, so it
  // cannot be resolved. Fail closed: a missing block is not evidence of
  // currency, and treating it as one is the exact shape of the bug above.
  if (item.versionBlock === undefined) {
    return retry('version-block-unknown', 'evidence-unavailable', attemptNumber);
  }
  if (item.versionBlock < observedBlock) {
    return retry('snapshot-behind-event', 'evidence-unavailable', attemptNumber);
  }
  return { action: 'resolve', reason: item.status };
}
