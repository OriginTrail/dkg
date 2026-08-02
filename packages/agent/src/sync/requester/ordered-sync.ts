import { getSyncBackpressureBusyError } from '../backpressure.js';
import {
  contextGraphPriority,
  type SyncContextGraphPriorityConfig,
  type SyncSchedulerLane,
} from '../policy.js';

export interface ContextGraphSyncWork<Result> {
  contextGraphId: string;
  lane: SyncSchedulerLane;
  operationId: string;
  run: (remainingContextGraphs: number) => Promise<Result>;
}

export interface OrderedContextGraphSyncOptions<Result> {
  work: readonly ContextGraphSyncWork<Result>[];
  priorities?: Readonly<SyncContextGraphPriorityConfig>;
  emptyResult: () => Result;
  runWithAdmission: (
    item: ContextGraphSyncWork<Result>,
    work: () => Promise<Result>,
  ) => Promise<Result>;
  merge: (summary: Result, part: Result) => Result;
  markDeferred: (summary: Result) => Result;
  markSkipped?: (
    summary: Result,
    skipped: readonly ContextGraphSyncWork<Result>[],
  ) => Result;
  shouldContinue?: () => boolean;
  shouldStop?: (part: Result) => boolean;
  onDeferred?: (item: ContextGraphSyncWork<Result>, error: Error) => void;
}

export type OrderedContextGraphSyncOutcome<Result> =
  | {
    readonly contextGraphId: string;
    readonly lane: SyncSchedulerLane;
    readonly disposition: 'settled';
    readonly result: Result;
  }
  | {
    readonly contextGraphId: string;
    readonly lane: SyncSchedulerLane;
    readonly disposition: 'deferred';
  }
  | {
    readonly contextGraphId: string;
    readonly lane: SyncSchedulerLane;
    readonly disposition: 'skipped';
    readonly reason: 'continuation-stopped' | 'stop-policy' | 'prior-deferral';
  };

export interface OrderedContextGraphSyncExecution<Result> {
  summary: Result;
  outcomes: readonly OrderedContextGraphSyncOutcome<Result>[];
}

type OrderedContextGraphSyncOutcomeCollector<Result> = (
  outcome: OrderedContextGraphSyncOutcome<Result>,
) => void;

function orderWork<Result>(
  work: readonly ContextGraphSyncWork<Result>[],
  priorities: Readonly<SyncContextGraphPriorityConfig> | undefined,
): ContextGraphSyncWork<Result>[] {
  const seen = new Set<string>();
  return work
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (seen.has(item.contextGraphId)) return false;
      seen.add(item.contextGraphId);
      return true;
    })
    .sort((a, b) => (
      contextGraphPriority(priorities, b.item.contextGraphId)
      - contextGraphPriority(priorities, a.item.contextGraphId)
      || a.index - b.index
    ))
    .map(({ item }) => item);
}

/**
 * Schedule an already-ordered list one Context Graph at a time. Admission is
 * deliberately outside the single-CG runner so completed work is merged before
 * a later queue rejection can stop the batch.
 */
export async function runOrderedContextGraphSyncs<Result>(
  options: OrderedContextGraphSyncOptions<Result>,
): Promise<Result> {
  return runOrderedContextGraphSyncsInternal(options);
}

/** Same scheduler contract with an exact outcome for every planned work item. */
export async function runOrderedContextGraphSyncsWithOutcomes<Result>(
  options: OrderedContextGraphSyncOptions<Result>,
): Promise<OrderedContextGraphSyncExecution<Result>> {
  const outcomes: OrderedContextGraphSyncOutcome<Result>[] = [];
  const summary = await runOrderedContextGraphSyncsInternal(
    options,
    (outcome) => outcomes.push(outcome),
  );
  return { summary, outcomes: Object.freeze(outcomes.map((outcome) => Object.freeze(outcome))) };
}

async function runOrderedContextGraphSyncsInternal<Result>(
  options: OrderedContextGraphSyncOptions<Result>,
  collectOutcome?: OrderedContextGraphSyncOutcomeCollector<Result>,
): Promise<Result> {
  let summary = options.emptyResult();
  const orderedWork = orderWork(options.work, options.priorities);
  for (const [index, item] of orderedWork.entries()) {
    if (options.shouldContinue && !options.shouldContinue()) {
      const skipped = orderedWork.slice(index);
      summary = options.markSkipped?.(summary, skipped) ?? summary;
      for (const candidate of skipped) {
        collectOutcome?.({
          contextGraphId: candidate.contextGraphId,
          lane: candidate.lane,
          disposition: 'skipped',
          reason: 'continuation-stopped',
        });
      }
      break;
    }
    const remaining = orderedWork.length - index;
    try {
      const part = await options.runWithAdmission(
        item,
        () => item.run(remaining),
      );
      collectOutcome?.({
        contextGraphId: item.contextGraphId,
        lane: item.lane,
        disposition: 'settled',
        result: part,
      });
      summary = options.merge(summary, part);
      if (options.shouldStop?.(part)) {
        for (const candidate of orderedWork.slice(index + 1)) {
          collectOutcome?.({
            contextGraphId: candidate.contextGraphId,
            lane: candidate.lane,
            disposition: 'skipped',
            reason: 'stop-policy',
          });
        }
        break;
      }
    } catch (error) {
      const backpressureError = getSyncBackpressureBusyError(error);
      if (!backpressureError) throw error;
      collectOutcome?.({
        contextGraphId: item.contextGraphId,
        lane: item.lane,
        disposition: 'deferred',
      });
      for (const candidate of orderedWork.slice(index + 1)) {
        collectOutcome?.({
          contextGraphId: candidate.contextGraphId,
          lane: candidate.lane,
          disposition: 'skipped',
          reason: 'prior-deferral',
        });
      }
      summary = options.markDeferred(summary);
      options.onDeferred?.(item, backpressureError);
      break;
    }
  }
  return summary;
}
