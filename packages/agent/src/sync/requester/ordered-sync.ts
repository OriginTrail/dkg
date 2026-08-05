import { type SyncOperationLane } from '../attempt-telemetry.js';
import { getSyncBackpressureBusyError } from '../backpressure.js';
import {
  contextGraphPriority,
  type SyncContextGraphPriorityConfig,
} from '../policy.js';

export interface ContextGraphSyncWork<Result> {
  contextGraphId: string;
  /**
   * `SyncOperationLane`, not the wider `SyncSchedulerLane`. This is the
   * REQUESTER's ordered-sync work item; its lane reaches I4/I5 unchanged
   * through `runContextGraphSyncWithBackpressure`. The two scheduler lanes it
   * can never carry (`pre_authorization`, `responder`) belong to the responder
   * limiter and are absent from `OPERATION_LANES`, so accepting one here would
   * clamp to `unspecified` and silently drop the operation from its per-lane
   * denominator. The shared admission types (`PriorityAdmissionScheduling`,
   * `acquire`) keep the wide lane on purpose — the responder really does use
   * them.
   */
  lane: SyncOperationLane;
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
  let summary = options.emptyResult();
  const orderedWork = orderWork(options.work, options.priorities);
  for (const [index, item] of orderedWork.entries()) {
    if (options.shouldContinue && !options.shouldContinue()) {
      summary = options.markSkipped?.(summary, orderedWork.slice(index)) ?? summary;
      break;
    }
    const remaining = orderedWork.length - index;
    try {
      const part = await options.runWithAdmission(
        item,
        () => item.run(remaining),
      );
      summary = options.merge(summary, part);
      if (options.shouldStop?.(part)) break;
    } catch (error) {
      const backpressureError = getSyncBackpressureBusyError(error);
      if (!backpressureError) throw error;
      summary = options.markDeferred(summary);
      options.onDeferred?.(item, backpressureError);
      break;
    }
  }
  return summary;
}
