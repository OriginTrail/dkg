// SPDX-License-Identifier: Apache-2.0
import type { TickOutcome, ChallengePeriod } from './prover-outcome.js';

/** Outcome kinds that mean a tick made no proof progress. */
export type TickFailureKind = Extract<
  TickOutcome['kind'],
  'cg-not-found' | 'kc-not-synced' | 'data-corrupted' | 'submit-stale' | 'error'
>;

/** What one tick outcome contributes to the prover's health counters. */
export interface TickOutcomeHealth {
  /** Challenge (proof period) the tick worked on, or null when it held none. */
  readonly challenge: ChallengePeriod | null;
  /** Whether the tick submitted a proof for `challenge`. */
  readonly proofSubmitted: boolean;
  /** Failure classification, or null for a healthy outcome. */
  readonly failure: TickFailureKind | null;
}

const NO_TICK_HEALTH_SIGNAL: TickOutcomeHealth = Object.freeze({
  challenge: null,
  proofSubmitted: false,
  failure: null,
});

/**
 * Classify one outcome for health reporting. The switch is exhaustive over
 * `TickOutcome`, so a new kind fails compilation here until its health
 * semantics are decided.
 */
export function classifyTickOutcome(outcome: TickOutcome): TickOutcomeHealth {
  switch (outcome.kind) {
    case 'period-closed':
    case 'no-challenge':
      return NO_TICK_HEALTH_SIGNAL;
    case 'already-solved':
      return { challenge: outcome.period ?? null, proofSubmitted: false, failure: null };
    case 'submitted':
      return { challenge: outcome.period ?? null, proofSubmitted: true, failure: null };
    case 'cg-not-found':
    case 'kc-not-synced':
    case 'data-corrupted':
    case 'submit-stale':
      return { challenge: outcome.period ?? null, proofSubmitted: false, failure: outcome.kind };
    case 'error':
      return { challenge: outcome.period ?? null, proofSubmitted: false, failure: 'error' };
    default: {
      // Compile-time guard only: bookkeeping inside the prover loop must never
      // throw, so an impossible runtime value contributes nothing.
      const exhaustive: never = outcome;
      void exhaustive;
      return NO_TICK_HEALTH_SIGNAL;
    }
  }
}

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ObservedChallenge {
  readonly firstSeenAt: number;
  proofSubmitted: boolean;
}

/** Process-local distinct-period health, expired by first observation time. */
export class ProverHealth {
  private readonly challenges = new Map<string, ObservedChallenge>();
  // Keep the current period's original identity even after its window expires.
  // A long proof period or halted chain can keep returning it indefinitely.
  private currentChallengeKey: string | null = null;
  private lastFailureClassification: TickFailureKind | null = null;
  private lastFailureAt: string | null = null;

  private prune(at: number): void {
    for (const [key, observed] of this.challenges) {
      if (key !== this.currentChallengeKey && observed.firstSeenAt <= at - HEALTH_WINDOW_MS) this.challenges.delete(key);
    }
  }

  observe(outcome: TickOutcome, at: number): void {
    this.prune(at);
    const health = classifyTickOutcome(outcome);
    if (health.challenge !== null) {
      const key = `${health.challenge.epoch}:${health.challenge.periodStartBlock}`;
      this.currentChallengeKey = key;
      let observed = this.challenges.get(key);
      if (observed === undefined) {
        observed = { firstSeenAt: at, proofSubmitted: false };
        this.challenges.set(key, observed);
      }
      if (health.proofSubmitted) observed.proofSubmitted = true;
    }
    if (health.failure !== null) {
      this.lastFailureClassification = health.failure;
      this.lastFailureAt = new Date(at).toISOString();
    }
  }

  snapshot(at: number) {
    this.prune(at);
    let challengesReceived24h = 0;
    let proofsSubmitted24h = 0;
    for (const observed of this.challenges.values()) {
      if (observed.firstSeenAt <= at - HEALTH_WINDOW_MS) continue;
      challengesReceived24h += 1;
      if (observed.proofSubmitted) proofsSubmitted24h += 1;
    }
    return {
      challengesReceived24h,
      proofsSubmitted24h,
      lastFailureClassification: this.lastFailureClassification,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
