// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter, NodeChallenge } from '@origintrail-official/dkg-chain';

/** Re-read even inside a long stable proof period. */
export const SOLVED_PERIOD_MAX_SKIP_MS = 60_000;

export interface SolvedPeriodReadContext {
  /** Derived identity of the currently bound RandomSampling contract pair. */
  readonly bindingId: string;
  /** Chronos epoch whose duration schedule produced the status read. */
  readonly chronosEpoch: bigint;
}

export interface SolvedPeriodObservation {
  readonly context?: SolvedPeriodReadContext;
  readonly challenge: NodeChallenge;
  readonly staleness: CachedChallengeStaleness;
  readonly durationInBlocks?: bigint;
}

export interface SolvedPeriodRecord {
  readonly challengePeriodEpoch: bigint;
  readonly periodStartBlock: bigint;
  readonly bindingId: string;
  readonly chronosEpoch: bigint;
  readonly rereadAtBlock: bigint;
  readonly rereadAtMs: number;
}

export interface CachedChallengeStaleness {
  readonly stale: boolean;
  /** Present only when the adapter successfully supplied a head. */
  readonly head?: bigint;
}

/**
 * Read the head once and return both the decision and the evidence used to
 * make it. A missing capability, invalid duration, or failed head read keeps
 * the historical fail-open behaviour: do not force a rotation and do not
 * build a solved-period record from guessed evidence.
 */
export async function readCachedChallengeStaleness(
  chain: ChainAdapter,
  existing: NodeChallenge,
  liveDurationInBlocks?: bigint,
): Promise<CachedChallengeStaleness> {
  if (!chain.getBlockNumber) return { stale: false };
  const duration = liveDurationInBlocks ?? existing.proofingPeriodDurationInBlocks;
  if (duration <= 0n) return { stale: false };
  let head: bigint;
  try {
    head = BigInt(await chain.getBlockNumber());
  } catch {
    return { stale: false };
  }
  return {
    stale: head >= existing.activeProofPeriodStartBlock + duration,
    head,
  };
}

/**
 * In-memory policy for reusing one on-chain `solved: true` observation.
 *
 * A record is reusable only while the head, the derived RS/RSS binding, and
 * the Chronos epoch still match. The epoch guard is load-bearing: governance
 * duration changes can take effect only on an epoch boundary, so a duration
 * sampled in one epoch is never reused in the next. This keeps the RPC saving
 * without trusting a duration that may shrink after the boundary.
 *
 * `RandomSamplingStorage.clearOutstandingChallenges` deletes the challenge
 * struct even though the separately earned score survives. That operation or
 * a reorg can therefore invalidate the observed solved flag in-period. The
 * block safety bound is capped inside the open period, and the one-minute
 * bound applies independently. At the default 30-second prover cadence this
 * skips at most one full status/challenge read before revalidating a possible
 * admin clear or reorg.
 */
export class SolvedPeriodSkip {
  readonly #chain: ChainAdapter;
  readonly #now: () => number;
  #record?: SolvedPeriodRecord;

  constructor(chain: ChainAdapter, now: () => number = () => performance.now()) {
    this.#chain = chain;
    this.#now = now;
  }

  /** Cheap guards checked both before and after the live head/epoch reads. */
  #stillBound(record: SolvedPeriodRecord, now: number): boolean {
    return this.#chain.isRandomSamplingReady?.() === true
      && this.#chain.getRandomSamplingBindingId?.() === record.bindingId
      && now < record.rereadAtMs;
  }
  /**
   * Sample the pair/epoch BEFORE the status and challenge reads. If either can
   * not be vouched for, callers still perform the normal read but do not retain
   * its answer across ticks.
   */
  async captureReadContext(): Promise<SolvedPeriodReadContext | undefined> {
    if (
      this.#chain.isRandomSamplingReady?.() !== true
      || !this.#chain.getCurrentEpoch
    ) return undefined;
    let epoch: bigint;
    try {
      epoch = await this.#chain.getCurrentEpoch();
    } catch {
      return undefined;
    }
    const bindingId = this.#chain.getRandomSamplingBindingId?.();
    if (bindingId === undefined) return undefined;
    return Object.freeze({ bindingId, chronosEpoch: epoch });
  }

  /** Record only when every live evidence source needed by the guards exists. */
  observe(input: SolvedPeriodObservation): boolean {
    const { context, challenge, staleness, durationInBlocks } = input;
    if (
      context === undefined
      || staleness.head === undefined
      || durationInBlocks === undefined
      || durationInBlocks <= 0n
    ) {
      this.#record = undefined;
      return false;
    }
    const periodEndBlock = challenge.activeProofPeriodStartBlock + durationInBlocks;
    const halfPeriodRereadBlock = staleness.head + durationInBlocks / 2n;
    // A late solved observation must still be revalidated while the period is
    // open. Otherwise observedHead + duration / 2 can land beyond the rollover
    // and an in-period solved -> unsolved transition remains hidden throughout
    // the only period in which the node can recover it.
    const latestOpenPeriodBlock = periodEndBlock - 1n;
    this.#record = Object.freeze({
      challengePeriodEpoch: challenge.epoch,
      periodStartBlock: challenge.activeProofPeriodStartBlock,
      bindingId: context.bindingId,
      chronosEpoch: context.chronosEpoch,
      rereadAtBlock: halfPeriodRereadBlock < latestOpenPeriodBlock
        ? halfPeriodRereadBlock
        : latestOpenPeriodBlock,
      rereadAtMs: this.#now() + SOLVED_PERIOD_MAX_SKIP_MS,
    });
    return true;
  }

  /** Return the reusable record, or forget it on the first failed guard. */
  async reusable(): Promise<SolvedPeriodRecord | undefined> {
    const record = this.#record;
    if (!record || !this.#chain.getBlockNumber || !this.#chain.getCurrentEpoch) {
      this.#record = undefined;
      return undefined;
    }
    if (!this.#stillBound(record, this.#now())) {
      this.#record = undefined;
      return undefined;
    }
    let head: bigint;
    let epoch: bigint;
    try {
      head = BigInt(await this.#chain.getBlockNumber());
      epoch = await this.#chain.getCurrentEpoch();
    } catch {
      this.#record = undefined;
      return undefined;
    }
    const stillReusable = (
      this.#stillBound(record, this.#now())
      && epoch === record.chronosEpoch
      && head >= record.periodStartBlock
      && head < record.rereadAtBlock
    );
    if (!stillReusable) {
      this.#record = undefined;
      return undefined;
    }
    return record;
  }
}
