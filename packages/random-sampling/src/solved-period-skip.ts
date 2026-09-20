// SPDX-License-Identifier: Apache-2.0

import {
  bindRandomSamplingReadContextReader,
  type ChainAdapter,
  type NodeChallenge,
  type RandomSamplingReadContext,
  type RandomSamplingReadContextReader,
} from '@origintrail-official/dkg-chain';

/** Re-read even inside a long stable proof period. */
export const SOLVED_PERIOD_MAX_SKIP_MS = 60_000;

export type SolvedPeriodReadContext = RandomSamplingReadContext;

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

export interface SolvedPeriodLiveRead<T> {
  readonly value: T;
  /** The current challenge, if the caller's status/challenge pair agreed. */
  readonly currentChallenge?: Readonly<{
    challenge: NodeChallenge;
    durationInBlocks?: bigint;
  }>;
}

export type SolvedPeriodReadResult<T> =
  | Readonly<{ kind: 'reused'; record: SolvedPeriodRecord }>
  | Readonly<{
      kind: 'live';
      value: T;
      challengeStaleness?: CachedChallengeStaleness;
    }>;

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
 *
 * The collaborator owns the full read sequence. Callers provide only the live
 * status/challenge read: this class checks reuse, captures the binding and
 * epoch before that callback, reads the head afterwards, and records the
 * observation. A caller cannot accidentally omit or reorder one guard.
 */
export class SolvedPeriodSkip {
  readonly #chain: ChainAdapter;
  readonly #contextReader?: RandomSamplingReadContextReader;
  readonly #now: () => number;
  #record?: SolvedPeriodRecord;

  constructor(chain: ChainAdapter, now: () => number = () => performance.now()) {
    this.#chain = chain;
    this.#contextReader = bindRandomSamplingReadContextReader(chain);
    this.#now = now;
  }

  /**
   * Reuse a proven solved period or perform one correctly ordered live read.
   * Staleness remains fail-open: a missing head cannot force a rotation, but it
   * also cannot create a reusable solved-period record.
   */
  async read<T>(readLive: () => Promise<SolvedPeriodLiveRead<T>>): Promise<SolvedPeriodReadResult<T>> {
    const reusable = await this.#reusable();
    if (reusable !== undefined) return Object.freeze({ kind: 'reused', record: reusable });

    // Capture BEFORE the status/challenge callback so an in-flight rotation
    // cannot attribute the old read to the new pair or Chronos epoch.
    const context = await this.#captureReadContext();
    const live = await readLive();
    const current = live.currentChallenge;
    if (current === undefined) {
      this.#record = undefined;
      return Object.freeze({ kind: 'live', value: live.value });
    }

    const staleness = await this.#readCachedChallengeStaleness(
      current.challenge,
      current.durationInBlocks,
    );
    if (current.challenge.solved && !staleness.stale) {
      this.#observe({
        context,
        challenge: current.challenge,
        staleness,
        durationInBlocks: current.durationInBlocks,
      });
    } else {
      this.#record = undefined;
    }
    return Object.freeze({
      kind: 'live',
      value: live.value,
      challengeStaleness: staleness,
    });
  }

  /** Cheap guards checked both before and after the live head/epoch reads. */
  #stillBound(record: SolvedPeriodRecord, now: number): boolean {
    return this.#contextReader?.isRandomSamplingReadContextCurrent({
      bindingId: record.bindingId,
      chronosEpoch: record.chronosEpoch,
    }) === true
      && now < record.rereadAtMs;
  }

  async #captureReadContext(): Promise<SolvedPeriodReadContext | undefined> {
    if (!this.#contextReader) return undefined;
    try {
      return await this.#contextReader.readRandomSamplingContext();
    } catch {
      return undefined;
    }
  }

  async #readCachedChallengeStaleness(
    existing: NodeChallenge,
    liveDurationInBlocks?: bigint,
  ): Promise<CachedChallengeStaleness> {
    if (!this.#chain.getBlockNumber) return { stale: false };
    const duration = liveDurationInBlocks ?? existing.proofingPeriodDurationInBlocks;
    if (duration <= 0n) return { stale: false };
    let head: bigint;
    try {
      head = BigInt(await this.#chain.getBlockNumber());
    } catch {
      return { stale: false };
    }
    return {
      stale: head >= existing.activeProofPeriodStartBlock + duration,
      head,
    };
  }

  /** Record only when every live evidence source needed by the guards exists. */
  #observe(input: Readonly<{
    context?: SolvedPeriodReadContext;
    challenge: NodeChallenge;
    staleness: CachedChallengeStaleness;
    durationInBlocks?: bigint;
  }>): boolean {
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
      periodEndBlock,
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
  async #reusable(): Promise<SolvedPeriodRecord | undefined> {
    const record = this.#record;
    if (!record || !this.#chain.getBlockNumber || !this.#contextReader) {
      this.#record = undefined;
      return undefined;
    }
    if (!this.#stillBound(record, this.#now())) {
      this.#record = undefined;
      return undefined;
    }
    let head: bigint;
    let context: RandomSamplingReadContext | undefined;
    try {
      head = BigInt(await this.#chain.getBlockNumber());
      context = await this.#contextReader.readRandomSamplingContext();
    } catch {
      this.#record = undefined;
      return undefined;
    }
    const stillReusable = (
      context !== undefined
      && this.#stillBound(record, this.#now())
      && context.bindingId === record.bindingId
      && context.chronosEpoch === record.chronosEpoch
      && head >= record.periodStartBlock
      && head < record.periodEndBlock
      && head < record.rereadAtBlock
    );
    if (!stillReusable) {
      this.#record = undefined;
      return undefined;
    }
    return record;
  }
}
