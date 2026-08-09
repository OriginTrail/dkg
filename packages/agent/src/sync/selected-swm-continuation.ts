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
import {
  classifySelectedSwmRoundFreshness,
  type SelectedSwmFreshnessResolution,
} from './shared-memory-freshness.js';
import type { SyncContextGraphPriorityConfig } from './policy.js';
import {
  runOrderedContextGraphSyncs,
  type ContextGraphSyncWork,
} from './requester/ordered-sync.js';

export interface SelectedSwmContinuationUnit {
  readonly work: ContextGraphSyncWork<SharedMemorySyncResult>;
  readonly initialResult: SharedMemorySyncResult;
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

export interface SelectedSwmContinuationExecution {
  readonly summary: SharedMemorySyncResult;
  readonly freshnessResolution: SelectedSwmFreshnessResolution;
}

export interface RunSelectedSwmContinuationsOptions {
  readonly providerPeerId: string;
  /** Paired public selected-provider work and its own initial round. */
  readonly units: readonly SelectedSwmContinuationUnit[];
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

interface SelectedSwmContinuationState {
  unit: SelectedSwmContinuationUnit;
  tracker: SwmCatchupPassTracker<SwmSnapshotCoverage>;
  planeProven: boolean;
  recoverableIncomplete: number;
  completed: boolean;
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
): Promise<SelectedSwmContinuationExecution> {
  const stateByContextGraph = new Map<string, SelectedSwmContinuationState>();
  for (const unit of options.units) {
    const { contextGraphId } = unit.work;
    if (stateByContextGraph.has(contextGraphId)) {
      throw new Error(
        `Selected SWM continuation received duplicate Context Graph: ${contextGraphId}`,
      );
    }
    const progress = classifyDurableProgress(unit.initialResult);
    const tracker = new SwmCatchupPassTracker<SwmSnapshotCoverage>();
    tracker.recordPeerRound(
      options.providerPeerId,
      unit.initialResult.swmCoverage,
      progress.completedWithoutFailure,
    );
    const freshness = classifySelectedSwmRoundFreshness(
      contextGraphId,
      unit.initialResult,
    );
    stateByContextGraph.set(contextGraphId, {
      unit,
      tracker,
      planeProven:
        unit.initialResult.insertedDataTriples > 0 && progress.completedWithoutFailure,
      recoverableIncomplete: freshness.recoverableSnapshotYieldFailures,
      completed: freshness.snapshotPlaneComplete,
    });
  }

  let summary = options.emptyResult();
  const execution = await runSwmCatchupContinuations({
    units: [...stateByContextGraph.values()].map((state) => ({
      key: state,
      tracker: state.tracker,
      planeProven: () => state.planeProven,
    })),
    config: options.passConfig,
    nowMs: options.nowMs,
    runPass: async (candidates) => {
      let deadlineExpired = false;
      const continuationWork = candidates.map((candidate) => {
        const state = candidate.key;
        const { work: item } = state.unit;
        return {
          ...item,
          run: async (remainingContextGraphs: number): Promise<SharedMemorySyncResult> => {
            // `run` is invoked only after the global scheduler grants a slot;
            // the executor-owned wrapper atomically rechecks the absolute
            // deadline and starts/counts the pass before permitting I/O.
            const started = await candidate.runStarted(async (pass) => {
              const result = await item.run(remainingContextGraphs);
              const progress = classifyDurableProgress(result);
              state.tracker.recordPeerRound(
                options.providerPeerId,
                result.swmCoverage,
                progress.completedWithoutFailure,
              );
              const freshness = classifySelectedSwmRoundFreshness(
                item.contextGraphId,
                result,
              );
              state.recoverableIncomplete += freshness.recoverableSnapshotYieldFailures;
              state.completed = freshness.snapshotPlaneComplete;
              state.planeProven = state.planeProven || (
                result.insertedDataTriples > 0 && progress.completedWithoutFailure
              );
              options.onContinuation?.({
                contextGraphId: item.contextGraphId,
                coverageBefore: pass.progressBefore,
                coverageAfter: pass.progress(),
              });
              return withoutContinuationPasses(result);
            });
            if (!started.started) {
              deadlineExpired = true;
              options.onExpiredAfterAdmission?.(item.contextGraphId);
              return options.emptyResult();
            }
            return started.result;
          },
        };
      });

      const part = withoutContinuationPasses(await runOrderedContextGraphSyncs({
        work: continuationWork,
        priorities: options.priorities,
        emptyResult: options.emptyResult,
        runWithAdmission: options.runWithAdmission,
        merge: options.merge,
        markDeferred: options.markDeferred,
        // Once one queued admission crosses the common absolute deadline, do
        // not queue the remaining candidates. The executor publishes the
        // terminal budget reason for every still-active unit on the zero-start
        // boundary.
        shouldContinue: () => !deadlineExpired,
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
      contextGraphId: stop.key.unit.work.contextGraphId,
      continuationPasses: stop.continuationPasses,
      reason: stop.reason,
    }),
  });

  if (execution.stoppedAfterPass) options.onBackpressure?.();
  const recoverableSnapshotYieldFailures = [...stateByContextGraph.values()].reduce(
    (total, state) => total + (state.completed ? state.recoverableIncomplete : 0),
    0,
  );
  return {
    summary: {
      ...summary,
      continuationPasses: execution.continuationPasses,
    },
    freshnessResolution: { recoverableSnapshotYieldFailures },
  };
}
