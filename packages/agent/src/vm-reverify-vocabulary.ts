// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE bounded vocabulary of re-verification outcomes (#2435, review r3).
 *
 * The planner's discriminated transition model is only as strong as its
 * narrowest consumer: a store or summary boundary that widens these unions to
 * `string` makes vocabulary drift and identifier-bearing reporting keys
 * compiler-invisible. Every reason union and the derived outcome-key type live
 * HERE, and the store contract, the worker's summaries and the transition
 * table all import them — `recordAttempt(ual, gen, `peer:${peerId}`, …)` is a
 * compile error, not a cardinality leak.
 */

export type VmReverifyResolveReason = 'already-present' | 'materialized' | 'fetched';

export type VmReverifyRetryReason =
  /** The chain view we got was read BEFORE the event. Never resolve on it. */
  | 'snapshot-behind-event'
  /** Not every configured endpoint answered the pinned view. */
  | 'snapshot-unavailable'
  /** The chain answered, but with a root/block/address this code cannot use. */
  | 'invalid-evidence'
  /** The CG is not (currently) subscribed or hosted here. Non-terminal. */
  | 'context-graph-not-held'
  /** Evidence was fine; nobody reachable had the version. */
  | 'unresolved'
  /**
   * Unresolvable BY CONFIGURATION: the durable plane that carries SWM is
   * switched off (ADR-W2R-10). Deferred forever rather than parked.
   */
  | 'durable-sync-disabled'
  /**
   * The SWM recovery this repair depends on FAILED as infrastructure (review
   * r3): the traversal did not complete, so peer exhaustion was never
   * established. Retried on the evidence ladder; never consumes the park
   * budget.
   */
  | 'swm-recovery-failed'
  /** An error this table does not recognise. Treated as transient, loudly. */
  | 'unexpected-error';

export type VmReverifyLeaveReason = 'lifecycle-closed' | 'no-result';

/**
 * Why a row stopped being retried. Every one of these is loud (warn + counter)
 * and every one is revivable by a redefining event or by the CG being
 * (re-)subscribed / (re-)hosted — nothing here is a permanent verdict about
 * the asset, only about the evidence available so far.
 */
export type VmReverifyAbandonReason =
  /** `root-removed`: the chain moved BACKWARDS; this design cannot repair that. */
  | 'version-regression-unsupported'
  /** Not registered / no committed version / CG binding mismatch on chain. */
  | 'chain-identity-conflict'
  /** The repair primitive rejected our own arguments — a bug, not a condition. */
  | 'programmer-error'
  /** The 24 h budget expired with no reachable peer holding the version. */
  | 'no-peer-has-version';

/**
 * Every key the run summary's roll-up may carry — the shape PR-C turns into
 * metric attributes. Derived from the closed unions, so a key bearing a UAL,
 * a KA id or a peer id cannot exist at compile time.
 */
export type VmReverifyOutcomeKey =
  | `resolve:${VmReverifyResolveReason}`
  | `retry:${VmReverifyRetryReason}`
  | `abandon:${VmReverifyAbandonReason}`
  | `leave:${VmReverifyLeaveReason}`
  /** A generation CAS refused the planned transition (review r2). */
  | 'superseded:stale-generation';

// Zero-emit type proofs: an identifier-bearing key is unrepresentable.
type Expect<T extends true> = T;
type NotAssignable<A, B> = A extends B ? false : true;
type _identifierBearingKeyRejected = Expect<NotAssignable<
  'retry:peer:12D3KooW',
  VmReverifyOutcomeKey
>>;
type _rawStringRejected = Expect<NotAssignable<string, VmReverifyOutcomeKey>>;
