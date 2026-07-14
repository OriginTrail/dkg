import { getSyncBackpressureBusyError } from '../backpressure.js';

export interface OrderedContextGraphSyncOptions<Result> {
  contextGraphIds: readonly string[];
  emptyResult: () => Result;
  runWithAdmission: <T>(contextGraphId: string, work: () => Promise<T>) => Promise<T>;
  runOne: (contextGraphId: string, remainingContextGraphs: number) => Promise<Result>;
  merge: (summary: Result, part: Result) => Result;
  markDeferred: (summary: Result) => Result;
  shouldStop?: (part: Result) => boolean;
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
  for (const [index, contextGraphId] of options.contextGraphIds.entries()) {
    const remaining = options.contextGraphIds.length - index;
    try {
      const part = await options.runWithAdmission(
        contextGraphId,
        () => options.runOne(contextGraphId, remaining),
      );
      summary = options.merge(summary, part);
      if (options.shouldStop?.(part)) break;
    } catch (error) {
      if (!getSyncBackpressureBusyError(error)) throw error;
      summary = options.markDeferred(summary);
      break;
    }
  }
  return summary;
}
