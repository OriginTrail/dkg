import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../dkg-agent-types.js';
import {
  SwmCatchupPassTracker,
  runSwmCatchupContinuations,
  type CatchupPassConfig,
  type CatchupPassDecisionReason,
} from './catchup-pass-policy.js';
import { classifyDurableProgress } from './durable-progress.js';
import type { SyncContextGraphPriorityConfig } from './policy.js';
import {
  runOrderedContextGraphSyncs,
  type ContextGraphSyncWork,
} from './requester/ordered-sync.js';

export interface SelectedSwmInitialRound {
  readonly contextGraphId: string;
  readonly result: SharedMemorySyncResult;
}

export interface SelectedSwmContinuationStop {
  readonly contextGraphId: string;
  readonly continuationPasses: number;
  readonly reason: CatchupPassDecisionReason;
}

export interface SelectedSwmContinuationProgress {
  readonly contextGraphId: string;
  readonly coverageBefore: number;
  readonly coverageAfter: number;
}

export interface RunSelectedSwmContinuationsOptions {
  readonly providerPeerId: string;
  /** Public selected-provider work only; initial mixed-CG ordering stays outside. */
  readonly work: readonly ContextGraphSyncWork<SharedMemorySyncResult>[];
  /** Results captured explicitly by the caller during the initial ordered walk. */
  readonly initialRounds: readonly SelectedSwmInitialRound[];
  readonly priorities?: Readonly<SyncContextGraphPriorityConfig>;
  readonly passConfig: CatchupPassConfig;
  readonly nowMs: () => number;
  readonly emptyResult: () => SharedMemorySyncResult;
  readonly runWithAdmission: (
    item: ContextGraphSyncWork<SharedMemorySyncResult>,
    run: () => Promise<SharedMemorySyncResult>,
  ) => Promise<SharedMemorySyncResult>;
  readonly merge: (
    summary: SharedMemorySyncResult,
    part: SharedMemorySyncResult,
  ) => SharedMemorySyncResult;
  readonly markDeferred: (summary: SharedMemorySyncResult) => SharedMemorySyncResult;
  readonly isPeerTransportFailure?: (part: SharedMemorySyncResult) => boolean;
  readonly onDeferred?: (
    item: ContextGraphSyncWork<SharedMemorySyncResult>,
    error: Error,
  ) => void;
  readonly onStop?: (stop: SelectedSwmContinuationStop) => void;
  readonly onBackpressure?: () => void;
  readonly onContinuation?: (progress: SelectedSwmContinuationProgress) => void;
  readonly onExpiredAfterAdmission?: (contextGraphId: string) => void;
}

function withoutContinuationPasses(
  result: SharedMemorySyncResult,
): SharedMemorySyncResult {
  return { ...result, continuationPasses: 0 };
}

/**
 * Run only the continuation portion of selected RFC-64 public-SWM sync.
 *
 * The lifecycle owns the initial public/private ordered walk and passes its
 * selected public results here explicitly. This adapter seeds one shared-policy
 * tracker per Context Graph, then maps the canonical continuation executor onto
 * fresh global-scheduler admissions. The budget is checked both before queueing
 * and inside the admitted callback, so queue wait cannot start late I/O or
 * inflate `continuationPasses`.
 */
export async function runSelectedSwmContinuations(
  options: RunSelectedSwmContinuationsOptions,
): Promise<SharedMemorySyncResult> {
  const initialByContextGraph = new Map(
    options.initialRounds.map((round) => [round.contextGraphId, round.result] as const),
  );
  const workByContextGraph = new Map<string, ContextGraphSyncWork<SharedMemorySyncResult>>();
  for (const item of options.work) {
    if (!workByContextGraph.has(item.contextGraphId)) {
      workByContextGraph.set(item.contextGraphId, item);
    }
  }

  const planeProven = new Map<string, boolean>();
  const trackers = new Map<string, SwmCatchupPassTracker<SwmSnapshotCoverage>>();
  for (const contextGraphId of workByContextGraph.keys()) {
    const initial = initialByContextGraph.get(contextGraphId);
    if (!initial) {
      throw new Error(
        `Selected SWM continuation is missing the initial round for Context Graph: ${contextGraphId}`,
      );
    }
    const progress = classifyDurableProgress(initial);
    const tracker = new SwmCatchupPassTracker<SwmSnapshotCoverage>();
    tracker.recordPeerRound(
      options.providerPeerId,
      initial.swmCoverage,
      progress.completedWithoutFailure,
    );
    trackers.set(contextGraphId, tracker);
    planeProven.set(
      contextGraphId,
      initial.insertedDataTriples > 0 && progress.completedWithoutFailure,
    );
  }

  let summary = options.emptyResult();
  const execution = await runSwmCatchupContinuations({
    units: [...trackers].map(([contextGraphId, tracker]) => ({
      key: contextGraphId,
      tracker,
      planeProven: () => planeProven.get(contextGraphId) === true,
    })),
    config: options.passConfig,
    nowMs: options.nowMs,
    runPass: async (candidates, deadlineMs) => {
      const candidateByContextGraph = new Map(
        candidates.map((candidate) => [candidate.key, candidate] as const),
      );
      const continuationWork = candidates.map((candidate) => {
        const item = workByContextGraph.get(candidate.key);
        if (!item) {
          throw new Error(
            `Selected SWM continuation received unknown Context Graph: ${candidate.key}`,
          );
        }
        return {
          ...item,
          run: async (remainingContextGraphs: number): Promise<SharedMemorySyncResult> => {
            // `run` is invoked only after the global scheduler grants a slot.
            // Rechecking here closes the decision-to-admission queue race.
            if (options.nowMs() >= deadlineMs) {
              options.onExpiredAfterAdmission?.(item.contextGraphId);
              return options.emptyResult();
            }
            const coverageBefore = candidate.start();
            const result = await item.run(remainingContextGraphs);
            const progress = classifyDurableProgress(result);
            const tracker = trackers.get(item.contextGraphId)!;
            tracker.recordPeerRound(
              options.providerPeerId,
              result.swmCoverage,
              progress.completedWithoutFailure,
            );
            planeProven.set(
              item.contextGraphId,
              planeProven.get(item.contextGraphId) === true || (
                result.insertedDataTriples > 0 && progress.completedWithoutFailure
              ),
            );
            options.onContinuation?.({
              contextGraphId: item.contextGraphId,
              coverageBefore,
              coverageAfter: candidate.progress(),
            });
            return withoutContinuationPasses(result);
          },
        };
      });

      const part = withoutContinuationPasses(await runOrderedContextGraphSyncs({
        work: continuationWork,
        priorities: options.priorities,
        emptyResult: options.emptyResult,
        runWithAdmission: (item, run) => {
          // Assert that ordered work still belongs to the selected candidate
          // set before admitting it; this also catches future adapter drift.
          if (!candidateByContextGraph.has(item.contextGraphId)) {
            throw new Error(
              `Selected SWM continuation scheduled an unselected Context Graph: ${item.contextGraphId}`,
            );
          }
          return options.runWithAdmission(item, run);
        },
        merge: options.merge,
        markDeferred: options.markDeferred,
        shouldContinue: () => options.nowMs() < deadlineMs,
        ...(options.isPeerTransportFailure
          ? { isPeerTransportFailure: options.isPeerTransportFailure }
          : {}),
        ...(options.onDeferred ? { onDeferred: options.onDeferred } : {}),
      }));
      summary = withoutContinuationPasses(options.merge(summary, part));
      return part;
    },
    shouldStopAfterPass: (part) => (part.deferredBackpressure ?? 0) > 0,
    onStop: (stop) => options.onStop?.({
      contextGraphId: stop.key,
      continuationPasses: stop.continuationPasses,
      reason: stop.reason,
    }),
  });

  if (execution.stoppedAfterPass) options.onBackpressure?.();
  return { ...summary, continuationPasses: execution.continuationPasses };
}
