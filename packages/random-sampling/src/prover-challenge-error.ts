// SPDX-License-Identifier: Apache-2.0
import type { ChallengePeriod, TickOutcome } from './prover-outcome.js';

/** Preserve the failed challenge even when the next tick observes a new period. */
export class ChallengeTickError extends Error {
  constructor(cause: unknown, readonly period: ChallengePeriod) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChallengeTickError';
  }
}

type ChallengeOutcome = Exclude<TickOutcome, { kind: 'period-closed' | 'no-challenge' }>;

/** One boundary owns both successful and rejected work for a known challenge. */
export async function withChallengePeriod(
  challenge: { epoch: bigint; activeProofPeriodStartBlock: bigint },
  work: (period: ChallengePeriod) => Promise<ChallengeOutcome>,
): Promise<TickOutcome> {
  const period = { epoch: challenge.epoch, periodStartBlock: challenge.activeProofPeriodStartBlock };
  try {
    return { ...await work(period), period };
  } catch (cause) {
    throw new ChallengeTickError(cause, period);
  }
}
