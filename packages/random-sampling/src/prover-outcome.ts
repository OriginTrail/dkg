// SPDX-License-Identifier: Apache-2.0

/**
 * On-chain identity of the proof period a challenge-scoped outcome belongs to.
 * A node holds at most one challenge per proof period, so this pair is also the
 * node's challenge identity: the WAL's `PeriodKey` without the constant node id.
 */
export interface ChallengePeriod {
  readonly epoch: bigint;
  readonly periodStartBlock: bigint;
}

/**
 * Outcome reported by `tick()`. The orchestrator's caller (the
 * agent's epoch loop) uses these to drive observability + retry
 * cadence — never to decide "should I tick again", because the next
 * tick is governed by chain state, not the previous outcome.
 *
 * The built-in prover supplies `period` for challenge-scoped outcomes. It stays
 * optional so existing external TickableProver implementations remain compatible.
 */
export type TickOutcome =
  /** Reserved. Currently unreachable — see `tickImpl` for why we no
   *  longer trust view-side `isValid: false`. Kept in the union so
   *  downstream consumers (`prover-loop`, `random-sampling-bind`)
   *  can pattern-match on it without breakage if a stricter
   *  period-closed gate is reintroduced (e.g. duration == 0). */
  | { kind: 'period-closed' }
  | { kind: 'no-challenge'; reason: 'no-eligible-cg' | 'no-eligible-kc' }
  | { kind: 'already-solved'; period?: ChallengePeriod }
  | { kind: 'cg-not-found'; kaId: bigint; period?: ChallengePeriod }
  | { kind: 'kc-not-synced'; kaId: bigint; cgId: bigint; period?: ChallengePeriod }
  | {
      kind: 'data-corrupted';
      kaId: bigint;
      cgId: bigint;
      reason: 'root-mismatch' | 'leaf-count-mismatch' | 'meta-graph-bug';
      period?: ChallengePeriod;
    }
  | { kind: 'submit-stale'; period?: ChallengePeriod }
  | {
      kind: 'submitted';
      txHash: string;
      kaId: bigint;
      cgId: bigint;
      chunkId: bigint;
      period?: ChallengePeriod;
    }
  | { kind: 'error'; error: Error; period?: ChallengePeriod };
