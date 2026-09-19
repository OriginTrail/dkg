// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter, NodeChallenge } from '@origintrail-official/dkg-chain';

/** Re-read even inside a long stable proof period. */
export const SOLVED_PERIOD_MAX_SKIP_MS = 5 * 60_000;

export interface SolvedPeriodReadContext {
  /** Derived identity of the currently bound RandomSampling contract pair. */
  readonly bindingId: string;
  /** Chronos epoch whose duration schedule produced the status read. */
  readonly chronosEpoch: bigint;
}

export interface SolvedPeriodRecordInput extends SolvedPeriodReadContext {
  readonly challengePeriodEpoch: bigint;
  readonly periodStartBlock: bigint;
  readonly durationInBlocks: bigint;
  readonly observedHead: bigint;
}

export interface SolvedPeriodRecord {
  readonly challengePeriodEpoch: bigint;
  readonly periodStartBlock: bigint;
  readonly periodEndBlock: bigint;
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
 * `RandomSamplingStorage.clearOutstandingChallenges` is documented for
 * outstanding UNSOLVED migration challenges and does not erase the separate
 * score already earned by a solved slot. A mistaken clear of a solved slot,
 * or a reorg that removes the solved observation, is nevertheless bounded by
 * the half-period / five-minute safety re-read below.
 */
export class SolvedPeriodSkip {
  readonly #chain: ChainAdapter;
  readonly #now: () => number;
  #record?: SolvedPeriodRecord;

  constructor(chain: ChainAdapter, now: () => number = () => performance.now()) {
    this.#chain = chain;
    this.#now = now;
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

  remember(input: SolvedPeriodRecordInput): void {
    if (input.durationInBlocks <= 0n) {
      this.#record = undefined;
      return;
    }
    this.#record = Object.freeze({
      challengePeriodEpoch: input.challengePeriodEpoch,
      periodStartBlock: input.periodStartBlock,
      periodEndBlock: input.periodStartBlock + input.durationInBlocks,
      bindingId: input.bindingId,
      chronosEpoch: input.chronosEpoch,
      rereadAtBlock: input.observedHead + input.durationInBlocks / 2n,
      rereadAtMs: this.#now() + SOLVED_PERIOD_MAX_SKIP_MS,
    });
  }

  /** Return the reusable record, or forget it on the first failed guard. */
  async reusable(): Promise<SolvedPeriodRecord | undefined> {
    const record = this.#record;
    if (!record || !this.#chain.getBlockNumber || !this.#chain.getCurrentEpoch) {
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
      this.#chain.isRandomSamplingReady?.() === true
      && this.#chain.getRandomSamplingBindingId?.() === record.bindingId
      && epoch === record.chronosEpoch
      && head >= record.periodStartBlock
      && head < record.periodEndBlock
      && head < record.rereadAtBlock
      && this.#now() < record.rereadAtMs
    );
    if (!stillReusable) {
      this.#record = undefined;
      return undefined;
    }
    return record;
  }
}
