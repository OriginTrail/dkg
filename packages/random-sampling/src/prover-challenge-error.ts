// SPDX-License-Identifier: Apache-2.0
import type { ChallengePeriod } from './prover-outcome.js';

/** Preserve the failed challenge even when the next tick observes a new period. */
export class ChallengeTickError extends Error {
  constructor(cause: unknown, readonly period: ChallengePeriod) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChallengeTickError';
  }
}
