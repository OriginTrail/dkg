// SPDX-License-Identifier: Apache-2.0

import { Logger, createOperationContext } from '@origintrail-official/dkg-core';

/**
 * GH#3081 — where an async publish job spends the time between the node observing its chain
 * finality and the durable write of its terminal record. Observation only: nothing reads a mark
 * back, every entry point swallows its own failure, and one log line per finalized job is the only
 * output.
 *
 * Marks are monotonic clock readings (`performance.now()` by default); wall-clock time stays the
 * job record's business. A line is anchored on observed finality, or on the first receipt or
 * inclusion evidence when this process never observed finality (an inline publish), and splits
 * the total into contiguous segments between the marks that exist, in this order:
 *
 *   anchor -tail-> executor settled -recoveryAdmission-> first recovery turn -recoveryRetry->
 *   last recovery turn -proof-> last handler start -recovery-> handler end -terminalWrite-> written
 *
 * A segment whose closing mark is missing, or precedes the segment's start, prints `-`, and the
 * next segment starts where the last printed one ended, so the printed segments sum to `totalMs`
 * (up to rounding). An inline publish has no settle, turn or handler mark, so its whole total is
 * `tailMs`: the executor's own post-receipt work and the result writes.
 *
 * `tailMs` is split again, by the same rule, at the steps the executor reports as it ends them
 * ({@link LIFT_JOB_TAIL_STEPS}): one `tail<Step>Ms` field per step and `tailRestMs` for what
 * follows the last report. A step prints `-` when the executor did not run it, did not report
 * it, or ended it before the anchor; the printed parts sum to `tailMs` (up to rounding).
 */

/** A total at or above this logs at info; shorter totals log at debug. */
export const LIFT_JOB_POST_FINALITY_INFO_THRESHOLD_MS = 10_000;
const MAX_TRACKED_JOBS = 512;

/**
 * What a queued executor does between the confirmation of its transaction and its return, in the
 * order it does it. The executor reports the end of each step it runs:
 *
 * - `publish`: the publish or update call returned, its own post-receipt work included;
 * - `receiptWrite`: the publish receipt was written;
 * - `publishedGraphClear`: the published asset's shared-memory graph was cleared;
 * - `legacySwmRetire`: the legacy shared-memory copy of the asset was retired;
 * - `remainingSwmClear`: the rest of shared memory was cleared, when the request asked for it;
 * - `lifecycleStamp`: the lifecycle record was stamped (for an update, its provenance too);
 * - `graphIdRead`: the on-chain id of the context graph was read for the announcement;
 * - `finalizationGossip`: the finalization was announced to the graph's topic;
 * - `shareMarkerClear`: the share-complete marker was cleared;
 * - `catalogObserver`: the post-confirmation catalog observer returned.
 */
export const LIFT_JOB_TAIL_STEPS = [
  'publish',
  'receiptWrite',
  'publishedGraphClear',
  'legacySwmRetire',
  'remainingSwmClear',
  'lifecycleStamp',
  'graphIdRead',
  'finalizationGossip',
  'shareMarkerClear',
  'catalogObserver',
] as const;
export type LiftJobTailStep = typeof LIFT_JOB_TAIL_STEPS[number];

/**
 * - `inline`: the executor finished in-band and its result wrote the terminal record.
 * - `detached`: the executor was detached at RPC acceptance; recovery wrote the terminal record.
 * - `held-failed`: the record was finalized from a held failed job, under the claim lock.
 * - `interrupted`: recovery finalized a live record no executor in this process owned (a restart,
 *   or an ambiguous post-broadcast failure).
 */
export type LiftJobCompletionPath = 'inline' | 'detached' | 'held-failed' | 'interrupted';

export interface LiftJobCompletionTimingSources {
  /** Monotonic milliseconds. */
  readonly clock: () => number;
  readonly log: Pick<Logger, 'info' | 'debug'>;
}

const DEFAULT_SOURCES: LiftJobCompletionTimingSources = {
  clock: () => performance.now(),
  log: new Logger('AsyncLiftPublisher'),
};

/** What the timeline reads from a recovery handler's input. */
export interface LiftJobCompletionRecoveryInput {
  readonly job: { readonly jobId: string; readonly status: string };
}

interface LiftJobTimeline {
  txHash?: string;
  receiptAt?: number;
  finalityAt?: number;
  settledAt?: number;
  firstTurnAt?: number;
  lastTurnAt?: number;
  turns: number;
  handlerStartAt?: number;
  handlerEndAt?: number;
  handlerRuns: number;
  heldFailed: boolean;
  /** When the executor reported the end of each tail step; at most one mark per step. */
  tailStepAt?: Partial<Record<LiftJobTailStep, number>>;
}

/** One bounded timeline per job, dropped when the job's terminal record is written. */
export class LiftJobCompletionTiming {
  readonly #timelines = new Map<string, LiftJobTimeline>();

  constructor(private readonly sources: LiftJobCompletionTimingSources = DEFAULT_SOURCES) {}

  /** The first receipt or inclusion evidence of `txHash`; another transaction starts over. */
  receipt(jobId: string, txHash: string): void {
    this.#observe(() => {
      const previous = this.#timelines.get(jobId)?.txHash;
      if (previous !== undefined && previous !== txHash) this.#timelines.delete(jobId);
      const timeline = this.#timeline(jobId);
      timeline.txHash ??= txHash;
      timeline.receiptAt ??= this.sources.clock();
    });
  }

  /** Canonical evidence at the configured confirmation depth; the first observation wins. */
  finality(jobId: string): void {
    this.#observe(() => {
      this.#timeline(jobId).finalityAt ??= this.sources.clock();
    });
  }

  /** A detached executor's promise settled; from here only chain proof can move the record. */
  executorSettled(jobId: string): void {
    this.#observe(() => {
      this.#timeline(jobId).settledAt = this.sources.clock();
    });
  }

  /**
   * The executor of `jobId` reports that `step` of its work after the confirmation just ended.
   * A step reported again, by a retried execution, keeps its last report; a name outside
   * {@link LIFT_JOB_TAIL_STEPS} is dropped, so a job never holds more marks than there are steps.
   */
  tailStep(jobId: string, step: LiftJobTailStep): void {
    this.#observe(() => {
      if (!LIFT_JOB_TAIL_STEPS.includes(step)) return;
      (this.#timeline(jobId).tailStepAt ??= {})[step] = this.sources.clock();
    });
  }

  /** A reconciliation turn reached the job while no executor in this process owned it. */
  recoveryTurn(jobId: string): void {
    this.#observe(() => {
      const timeline = this.#timeline(jobId);
      const at = this.sources.clock();
      timeline.firstTurnAt ??= at;
      timeline.lastTurnAt = at;
      timeline.turns += 1;
    });
  }

  /**
   * Time every run of a recovery handler. The wrapper returns the handler's own promise, so what
   * the caller awaits, its value and its rejection are unchanged; the end mark rides a separate
   * reaction that cannot reject.
   */
  timeRecovery<Input extends LiftJobCompletionRecoveryInput, Result>(
    handler: (input: Input) => Promise<Result>,
  ): (input: Input) => Promise<Result> {
    return (input) => {
      let timeline: LiftJobTimeline | undefined;
      this.#observe(() => {
        timeline = this.#timeline(input.job.jobId);
        timeline.handlerStartAt = this.sources.clock();
        timeline.handlerEndAt = undefined;
        timeline.handlerRuns += 1;
        timeline.heldFailed = input.job.status === 'failed';
      });
      const pending = handler(input);
      const end = (): void => this.#observe(() => {
        if (timeline !== undefined) timeline.handlerEndAt = this.sources.clock();
      });
      this.#observe(() => {
        void Promise.resolve(pending).then(end, end);
      });
      return pending;
    };
  }

  /** The job's terminal record was written: report its timeline once and forget it. */
  terminal(jobId: string): void {
    this.#observe(() => {
      const timeline = this.#timelines.get(jobId);
      this.#timelines.delete(jobId);
      if (timeline === undefined) return;
      const report = describeLiftJobPostFinality(jobId, timeline, this.sources.clock());
      if (report === null) return;
      const ctx = createOperationContext('publish', jobId);
      if (report.totalMs >= LIFT_JOB_POST_FINALITY_INFO_THRESHOLD_MS) {
        this.sources.log.info(ctx, report.line);
      } else {
        this.sources.log.debug(ctx, report.line);
      }
    });
  }

  #timeline(jobId: string): LiftJobTimeline {
    let timeline = this.#timelines.get(jobId);
    if (timeline === undefined) {
      if (this.#timelines.size >= MAX_TRACKED_JOBS) {
        const oldest = this.#timelines.keys().next().value;
        if (oldest !== undefined) this.#timelines.delete(oldest);
      }
      timeline = { turns: 0, handlerRuns: 0, heldFailed: false };
      this.#timelines.set(jobId, timeline);
    }
    return timeline;
  }

  #observe(callback: () => void): void {
    try {
      callback();
    } catch { /* observation only */ }
  }
}

function pathOf(timeline: LiftJobTimeline): LiftJobCompletionPath {
  if (timeline.heldFailed) return 'held-failed';
  if (timeline.settledAt !== undefined) return 'detached';
  if (timeline.turns > 0 || timeline.handlerRuns > 0) return 'interrupted';
  return 'inline';
}

function formatMs(ms: number): string {
  return String(Math.max(0, Math.round(ms)));
}

/** The `async_publish_post_finality` logfmt line, or null when nothing anchored the timeline. */
function describeLiftJobPostFinality(
  jobId: string,
  timeline: Readonly<LiftJobTimeline>,
  writtenAt: number,
): { readonly line: string; readonly totalMs: number } | null {
  const anchorAt = timeline.finalityAt ?? timeline.receiptAt;
  if (anchorAt === undefined || !Number.isFinite(writtenAt)) return null;
  const path = pathOf(timeline);
  const segments: ReadonlyArray<readonly [string, number | undefined]> = path === 'inline'
    ? [['tailMs', writtenAt], ['recoveryAdmissionMs', undefined], ['recoveryRetryMs', undefined],
      ['proofMs', undefined], ['recoveryMs', undefined], ['terminalWriteMs', undefined]]
    : [['tailMs', timeline.settledAt], ['recoveryAdmissionMs', timeline.firstTurnAt],
      ['recoveryRetryMs', timeline.lastTurnAt], ['proofMs', timeline.handlerStartAt],
      ['recoveryMs', timeline.handlerEndAt], ['terminalWriteMs', writtenAt]];
  const totalMs = Math.max(0, writtenAt - anchorAt);
  const fields = [
    `job=${jobId}`,
    `path=${path}`,
    `anchor=${timeline.finalityAt !== undefined ? 'finality' : 'receipt'}`,
    `totalMs=${formatMs(totalMs)}`,
  ];
  let cursor = anchorAt;
  let tail: { readonly from: number; readonly to: number } | undefined;
  for (const [name, closedAt] of segments) {
    if (closedAt === undefined || closedAt < cursor) {
      fields.push(`${name}=-`);
      continue;
    }
    if (name === 'tailMs') tail = { from: cursor, to: closedAt };
    fields.push(`${name}=${formatMs(closedAt - cursor)}`);
    cursor = closedAt;
  }
  const { receiptAt, finalityAt } = timeline;
  fields.push(
    `recoveryTurns=${timeline.turns}`,
    `recoveryAttempts=${timeline.handlerRuns}`,
    `receiptToFinalityMs=${receiptAt !== undefined && finalityAt !== undefined && finalityAt >= receiptAt
      ? formatMs(finalityAt - receiptAt) : '-'}`,
    ...describeTailSteps(timeline.tailStepAt, tail),
  );
  return { line: `async_publish_post_finality ${fields.join(' ')}`, totalMs };
}

/**
 * The split of the printed tail segment at the steps the executor reported, in step order, and
 * `tailRestMs` for what follows the last one. Every field prints `-` when no tail was printed.
 */
function describeTailSteps(
  marks: LiftJobTimeline['tailStepAt'],
  tail: { readonly from: number; readonly to: number } | undefined,
): string[] {
  const fields: string[] = [];
  let cursor = tail?.from;
  for (const step of LIFT_JOB_TAIL_STEPS) {
    const name = `tail${step[0]!.toUpperCase()}${step.slice(1)}Ms`;
    const at = marks?.[step];
    if (tail === undefined || cursor === undefined || at === undefined || at < cursor || at > tail.to) {
      fields.push(`${name}=-`);
      continue;
    }
    fields.push(`${name}=${formatMs(at - cursor)}`);
    cursor = at;
  }
  fields.push(`tailRestMs=${tail === undefined || cursor === undefined ? '-' : formatMs(tail.to - cursor)}`);
  return fields;
}
