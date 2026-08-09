import { type SyncOperationLane } from '../attempt-telemetry.js';
import { getSyncBackpressureBusyError } from '../backpressure.js';
import {
  contextGraphPriority,
  type SyncContextGraphPriorityConfig,
} from '../policy.js';

/**
 * Peer-dead cutoff for one fanout batch. One Context Graph's failed round must
 * never cost the remaining CGs their turn — a single poisoned transfer (an
 * oversized system CG dying mid-stream every cycle) otherwise starves every
 * small CG behind it indefinitely. But the inverse is also real: when the peer
 * itself is dead or unreachable, every remaining item re-dials it and burns a
 * full transport timeout, so a long CG list turns one dead peer into an
 * hours-long stall. Three consecutive rounds in which the peer never responded
 * is treated as peer-dead evidence and stops the batch; any round the peer
 * answered — cleanly, denied, or failed after responding — resets the streak,
 * so per-CG failures alone can never trip this guard.
 */
export const MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES = 3;

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
  /** Observe a completed item and its own result before the batch continues. */
  onResult?: (item: ContextGraphSyncWork<Result>, result: Result) => void;
  markDeferred: (summary: Result) => Result;
  markSkipped?: (
    summary: Result,
    skipped: readonly ContextGraphSyncWork<Result>[],
  ) => Result;
  shouldContinue?: () => boolean;
  /**
   * True when one merged item result shows the PEER never responded for that
   * Context Graph's round (transport-class: dial/stream death before any
   * answer). Failures the peer did respond to must return false — they are
   * already recorded in the merged summary, and the fanout continues to the
   * next CG. Consecutive true verdicts feed the peer-dead cutoff
   * ({@link MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES}).
   */
  isPeerTransportFailure?: (part: Result) => boolean;
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
  let consecutivePeerTransportFailures = 0;
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
      options.onResult?.(item, part);
      summary = options.merge(summary, part);
      if (options.isPeerTransportFailure?.(part)) {
        consecutivePeerTransportFailures += 1;
        if (consecutivePeerTransportFailures >= MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES) break;
      } else {
        consecutivePeerTransportFailures = 0;
      }
    } catch (error) {
      // The GLOBAL admission queue rejected this item, so every later item
      // would be rejected identically — stopping here is correct and cheap,
      // unlike a per-CG failure, which stays isolated above.
      const backpressureError = getSyncBackpressureBusyError(error);
      if (!backpressureError) throw error;
      summary = options.markDeferred(summary);
      options.onDeferred?.(item, backpressureError);
      break;
    }
  }
  return summary;
}
