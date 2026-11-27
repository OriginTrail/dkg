// SPDX-License-Identifier: Apache-2.0

import {
  type ChainAdapter,
  type NodeChallenge,
  type RandomSamplingReadContext,
  type RandomSamplingReadContextReader,
} from '@origintrail-official/dkg-chain';

/** Re-read even inside a long stable proof period. */
export const SOLVED_PERIOD_MAX_SKIP_MS = 60_000;

export interface SolvedPeriodRecord {
  readonly challengePeriodEpoch: bigint;
  readonly periodStartBlock: bigint;
  readonly bindingId: string;
  readonly epochBindingId: string;
  readonly chronosEpoch: bigint;
  readonly rereadAtBlock: bigint;
  readonly rereadAtMs: number;
}

interface CachedChallengeStaleness {
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
      /** RS/RSS binding captured before the caller's live reads. */
      observationBindingId?: string;
      currentChallenge?: Readonly<{
        challenge: NodeChallenge;
        stale: boolean;
      }>;
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
 * bound applies independently, so the premise is always revalidated.
 *
 * The collaborator owns the full read sequence. Callers provide only the live
 * status/challenge read: this class checks reuse, captures the cheap binding
 * identity before that callback, reads the head afterwards, and pays for the
 * Chronos epoch only when the challenge is solved and non-stale. A caller
 * cannot accidentally omit or reorder one guard.
 */
export class SolvedPeriodSkip {
  readonly #chain: ChainAdapter;
  readonly #contextReader?: RandomSamplingReadContextReader;
  readonly #now: () => number;
  #record?: SolvedPeriodRecord;

  constructor(chain: ChainAdapter, now: () => number = () => performance.now()) {
    this.#chain = chain;
    this.#contextReader = chain.getRandomSamplingReadContextReader?.();
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

    // Capture the free binding identity BEFORE the status/challenge callback.
    // The paid Chronos epoch is deferred until there is a reusable observation.
    const bindingId = this.#captureBindingId();
    const live = await readLive();
    const current = live.currentChallenge;
    if (current === undefined) {
      this.#record = undefined;
      return Object.freeze({
        kind: 'live',
        value: live.value,
        ...(bindingId === undefined ? {} : { observationBindingId: bindingId }),
      });
    }

    const blockContext = await this.#captureBlockContext(bindingId);
    const staleness = await this.#readCachedChallengeStaleness(
      current.challenge,
      current.durationInBlocks,
      blockContext?.headBlockNumber,
    );
    if (current.challenge.solved && !staleness.stale) {
      const context = blockContext ?? (
        this.#hasBlockContextCapability() ? undefined : await this.#captureReadContext(bindingId)
      );
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
      ...(bindingId === undefined ? {} : { observationBindingId: bindingId }),
      currentChallenge: Object.freeze({
        challenge: current.challenge,
        stale: staleness.stale,
      }),
    });
  }

  /**
   * Install the same bounded record after this node's proof transaction has
   * succeeded. The submission is stronger evidence than a follow-up
   * `getNodeChallenge` read, but it is reusable only when the pre-read RS/RSS
   * binding is still current and the live tip remains in the challenge period.
   */
  async observeSubmittedProof(input: Readonly<{
    observationBindingId?: string;
    challenge: NodeChallenge;
    durationInBlocks?: bigint;
  }>): Promise<boolean> {
    const { observationBindingId, challenge, durationInBlocks } = input;
    if (observationBindingId === undefined) {
      this.#record = undefined;
      return false;
    }
    const blockContext = await this.#captureBlockContext(observationBindingId);
    const staleness = await this.#readCachedChallengeStaleness(
      challenge,
      durationInBlocks,
      blockContext?.headBlockNumber,
    );
    if (staleness.stale) {
      this.#record = undefined;
      return false;
    }
    const context = blockContext ?? (
      this.#hasBlockContextCapability()
        ? undefined
        : await this.#captureReadContext(observationBindingId)
    );
    return this.#observe({
      context,
      challenge: Object.freeze({ ...challenge, solved: true }),
      staleness,
      durationInBlocks,
    });
  }

  /** Cheap guards checked both before and after the live head/epoch reads. */
  #stillBound(record: SolvedPeriodRecord, now: number): boolean {
    return this.#contextReader?.isRandomSamplingBindingCurrent(record.bindingId) === true
      && now < record.rereadAtMs;
  }

  #captureBindingId(): string | undefined {
    try {
      return this.#contextReader?.getRandomSamplingBindingId();
    } catch {
      return undefined;
    }
  }

  async #captureReadContext(bindingId: string | undefined): Promise<RandomSamplingReadContext | undefined> {
    if (!this.#contextReader || bindingId === undefined) return undefined;
    try {
      const context = await this.#contextReader.readRandomSamplingContext();
      return context?.bindingId === bindingId ? context : undefined;
    } catch {
      return undefined;
    }
  }

  async #captureBlockContext(bindingId: string | undefined) {
    if (!this.#contextReader?.readRandomSamplingBlockContext || bindingId === undefined) {
      return undefined;
    }
    try {
      const context = await this.#contextReader.readRandomSamplingBlockContext();
      return context?.bindingId === bindingId ? context : undefined;
    } catch {
      return undefined;
    }
  }

  #hasBlockContextCapability(): boolean {
    return typeof this.#contextReader?.readRandomSamplingBlockContext === 'function';
  }

  async #readCachedChallengeStaleness(
    existing: NodeChallenge,
    liveDurationInBlocks?: bigint,
    contextHead?: bigint,
  ): Promise<CachedChallengeStaleness> {
    const duration = liveDurationInBlocks ?? existing.proofingPeriodDurationInBlocks;
    if (duration <= 0n) return { stale: false };
    let head = contextHead;
    if (head === undefined) {
      if (!this.#chain.getBlockNumber) return { stale: false };
      try {
        head = BigInt(await this.#chain.getBlockNumber());
      } catch {
        return { stale: false };
      }
    }
    return {
      stale: head >= existing.activeProofPeriodStartBlock + duration,
      head,
    };
  }

  /** Record only when every live evidence source needed by the guards exists. */
  #observe(input: Readonly<{
    context?: RandomSamplingReadContext;
    challenge: NodeChallenge;
    staleness: CachedChallengeStaleness;
    durationInBlocks?: bigint;
  }>): boolean {
    const { context, challenge, staleness, durationInBlocks } = input;
    if (
      context === undefined
      || challenge.epoch !== context.chronosEpoch
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
      epochBindingId: context.epochBindingId ?? context.bindingId,
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
    if (!record || !this.#contextReader) {
      this.#record = undefined;
      return undefined;
    }
    if (!this.#stillBound(record, this.#now())) {
      this.#record = undefined;
      return undefined;
    }
    let head: bigint | undefined;
    let context: RandomSamplingReadContext | undefined;
    try {
      const blockContext = await this.#captureBlockContext(record.bindingId);
      if (blockContext !== undefined) {
        head = blockContext.headBlockNumber;
        context = blockContext;
      } else {
        if (this.#hasBlockContextCapability()) {
          this.#record = undefined;
          return undefined;
        }
        if (!this.#chain.getBlockNumber) {
          this.#record = undefined;
          return undefined;
        }
        head = BigInt(await this.#chain.getBlockNumber());
        context = await this.#contextReader.readRandomSamplingContext();
      }
    } catch {
      this.#record = undefined;
      return undefined;
    }
    const stillReusable = (
      context !== undefined
      && this.#stillBound(record, this.#now())
      && context.bindingId === record.bindingId
      && (context.epochBindingId ?? context.bindingId) === record.epochBindingId
      && context.chronosEpoch === record.chronosEpoch
      && head !== undefined
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
