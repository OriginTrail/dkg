import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../dkg-agent-types.js';
import {
  SwmCatchupPassTracker,
  type CatchupPassConfig,
  type CatchupPassDecisionReason,
} from './catchup-pass-policy.js';
import { classifyDurableProgress } from './durable-progress.js';
import type { SyncContextGraphPriorityConfig } from './policy.js';
import {
  runOrderedContextGraphSyncs,
  type ContextGraphSyncWork,
} from './requester/ordered-sync.js';

interface SelectedSwmContextGraphState {
  readonly tracker: SwmCatchupPassTracker<SwmSnapshotCoverage>;
  planeProven: boolean;
  stopped: boolean;
}

export interface SelectedSwmContinuationStop {
  readonly contextGraphId: string;
  readonly continuationPasses: number;
  readonly reason: CatchupPassDecisionReason;
}

export interface SelectedSwmContinuationSelection {
  readonly contextGraphIds: readonly string[];
  readonly stops: readonly SelectedSwmContinuationStop[];
}

export interface SelectedSwmAdmission {
  readonly priorityOverride: number | undefined;
  readonly selectedSwmPriority: boolean;
}

export interface SelectedSwmContinuationProgress {
  readonly contextGraphId: string;
  readonly coverageBefore: number;
  readonly coverageAfter: number;
}

export interface RunSelectedSwmSyncWorkOptions {
  readonly providerPeerId: string;
  readonly publicContextGraphIds: readonly string[];
  readonly work: readonly ContextGraphSyncWork<SharedMemorySyncResult>[];
  readonly selectedEnabled: boolean;
  readonly selectedPriority: number | undefined;
  readonly priorities?: Readonly<SyncContextGraphPriorityConfig>;
  /** Resolved lazily only when selected continuation is actually active. */
  readonly resolvePassConfig: () => CatchupPassConfig;
  readonly nowMs: () => number;
  readonly emptyResult: () => SharedMemorySyncResult;
  /**
   * The only host-specific boundary. The focused driver decides selected
   * membership and priority; the host admits the supplied callback through its
   * existing global scheduler.
   */
  readonly runWithAdmission: (
    item: ContextGraphSyncWork<SharedMemorySyncResult>,
    run: () => Promise<SharedMemorySyncResult>,
    admission: SelectedSwmAdmission,
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

/**
 * Per-provider, per-CG state for RFC-64's selected public-SWM continuation.
 *
 * This deliberately owns no I/O and no retry loop. The caller keeps every
 * round behind the existing global scheduler, while this class reuses the
 * foreground catch-up policy to decide whether another admitted round is
 * warranted. Keeping one tracker per CG prevents coverage from independent
 * manifests being combined into a synthetic progress signal.
 */
export class SelectedSwmContinuationPlan {
  readonly deadlineMs: number;

  private readonly contextGraphs = new Map<string, SelectedSwmContextGraphState>();

  constructor(
    private readonly providerPeerId: string,
    contextGraphIds: readonly string[],
    private readonly config: CatchupPassConfig,
    startedAtMs: number,
  ) {
    this.deadlineMs = startedAtMs + config.budgetMs;
    for (const contextGraphId of new Set(contextGraphIds)) {
      this.contextGraphs.set(contextGraphId, {
        tracker: new SwmCatchupPassTracker<SwmSnapshotCoverage>(),
        planeProven: false,
        stopped: false,
      });
    }
  }

  recordRound(contextGraphId: string, result: SharedMemorySyncResult): void {
    const state = this.requireState(contextGraphId);
    const progress = classifyDurableProgress(result);
    state.tracker.recordPeerRound(
      this.providerPeerId,
      result.swmCoverage,
      progress.completedWithoutFailure,
    );
    state.planeProven = state.planeProven || (
      result.insertedDataTriples > 0 && progress.completedWithoutFailure
    );
  }

  selectNextPass(nowMs: number): SelectedSwmContinuationSelection {
    const contextGraphIds: string[] = [];
    const stops: SelectedSwmContinuationStop[] = [];
    for (const [contextGraphId, state] of this.contextGraphs) {
      if (state.stopped) continue;
      const decision = state.tracker.decide({
        nowMs,
        deadlineMs: this.deadlineMs,
        maxPasses: this.config.maxPasses,
        planeProven: state.planeProven,
      });
      if (decision.continue) {
        contextGraphIds.push(contextGraphId);
        continue;
      }
      state.stopped = true;
      stops.push({
        contextGraphId,
        continuationPasses: state.tracker.continuationPasses(),
        reason: decision.reason,
      });
    }
    return { contextGraphIds, stops };
  }

  /** Called from inside scheduler admission, immediately before network I/O. */
  startContinuationPass(contextGraphId: string): number {
    return this.requireState(contextGraphId).tracker.startContinuationPass();
  }

  continuationPasses(): number {
    let total = 0;
    for (const state of this.contextGraphs.values()) {
      total += state.tracker.continuationPasses();
    }
    return total;
  }

  progress(contextGraphId: string): number {
    return this.requireState(contextGraphId).tracker.progress();
  }

  private requireState(contextGraphId: string): SelectedSwmContextGraphState {
    const state = this.contextGraphs.get(contextGraphId);
    if (!state) {
      throw new Error(`Selected SWM continuation received unknown Context Graph: ${contextGraphId}`);
    }
    return state;
  }
}

function withoutContinuationPasses(
  result: SharedMemorySyncResult,
): SharedMemorySyncResult {
  return { ...result, continuationPasses: 0 };
}

/**
 * Own the complete selected public-SWM protocol around the ordinary ordered
 * work list: initial result capture, selected membership and admission flags,
 * continuation deadline, progress ledger, continuation scheduling, and final
 * diagnostics.
 *
 * The host owns only the actual per-CG I/O callback and global scheduler
 * admission. Every continuation is a fresh ordered batch, so its scheduler slot
 * is released between passes. The absolute deadline is checked once before
 * queueing and again from inside the admitted callback; an item that expires in
 * the queue therefore starts neither a pass nor network/store I/O.
 *
 * `continuationPasses` deliberately has exactly one writer: this driver. Work
 * results may originate in nested or reused runners, so their pass counters are
 * stripped before every merge and the plan's exact total replaces the final
 * field. This prevents merged part diagnostics from being counted twice.
 */
export async function runSelectedSwmSyncWork(
  options: RunSelectedSwmSyncWorkOptions,
): Promise<SharedMemorySyncResult> {
  const publicContextGraphSet = new Set(options.publicContextGraphIds);
  const isSelectedPublicWork = (
    item: ContextGraphSyncWork<SharedMemorySyncResult>,
  ): boolean => (
    options.selectedEnabled
    && item.lane === 'shared_memory'
    && publicContextGraphSet.has(item.contextGraphId)
  );
  const selectedPublicContextGraphIds = options.work
    .filter(isSelectedPublicWork)
    .map((item) => item.contextGraphId);
  const initialPublicResults = new Map<string, SharedMemorySyncResult>();

  const runOrdered = (
    selectedWork: readonly ContextGraphSyncWork<SharedMemorySyncResult>[],
    phase: 'initial' | 'continuation',
    plan?: SelectedSwmContinuationPlan,
  ): Promise<SharedMemorySyncResult> => {
    const wrappedWork = selectedWork.map((item) => {
      if (!isSelectedPublicWork(item)) return item;
      return {
        ...item,
        run: async (remainingContextGraphs: number) => {
          if (phase === 'initial') {
            const result = await item.run(remainingContextGraphs);
            initialPublicResults.set(item.contextGraphId, result);
            return result;
          }

          if (!plan) throw new Error('Selected SWM continuation is missing its plan');
          // This wrapper is invoked only by `runWithAdmission`, after the global
          // scheduler grants a slot. Rechecking here closes the queue-wait race.
          if (options.nowMs() >= plan.deadlineMs) {
            options.onExpiredAfterAdmission?.(item.contextGraphId);
            return options.emptyResult();
          }
          const coverageBefore = plan.startContinuationPass(item.contextGraphId);
          const result = await item.run(remainingContextGraphs);
          plan.recordRound(item.contextGraphId, result);
          options.onContinuation?.({
            contextGraphId: item.contextGraphId,
            coverageBefore,
            coverageAfter: plan.progress(item.contextGraphId),
          });
          return result;
        },
      };
    });

    return runOrderedContextGraphSyncs({
      work: wrappedWork,
      priorities: options.priorities,
      emptyResult: options.emptyResult,
      runWithAdmission: (item, run) => {
        const selectedSwmPriority = isSelectedPublicWork(item);
        return options.runWithAdmission(item, run, {
          priorityOverride: options.selectedEnabled
            ? (selectedSwmPriority ? options.selectedPriority : undefined)
            : options.selectedPriority,
          selectedSwmPriority,
        });
      },
      merge: options.merge,
      markDeferred: options.markDeferred,
      ...(phase === 'continuation' && plan
        ? { shouldContinue: () => options.nowMs() < plan.deadlineMs }
        : {}),
      ...(options.isPeerTransportFailure
        ? { isPeerTransportFailure: options.isPeerTransportFailure }
        : {}),
      ...(options.onDeferred ? { onDeferred: options.onDeferred } : {}),
    });
  };

  const initialSummary = await runOrdered(options.work, 'initial');
  if (!options.selectedEnabled || selectedPublicContextGraphIds.length === 0) {
    return initialSummary;
  }

  // The continuation budget starts only after the full initial public/private
  // walk. A large initial walk therefore cannot consume the retry allowance.
  const plan = new SelectedSwmContinuationPlan(
    options.providerPeerId,
    selectedPublicContextGraphIds,
    options.resolvePassConfig(),
    options.nowMs(),
  );
  for (const [contextGraphId, result] of initialPublicResults) {
    plan.recordRound(contextGraphId, result);
  }

  // Driver-owned diagnostic: discard any nested/part counter before merging.
  let summary = withoutContinuationPasses(initialSummary);
  if ((summary.deferredBackpressure ?? 0) > 0) {
    options.onBackpressure?.();
  } else {
    const publicWorkByContextGraph = new Map(
      options.work
        .filter(isSelectedPublicWork)
        .map((item) => [item.contextGraphId, item] as const),
    );
    for (;;) {
      const selection = plan.selectNextPass(options.nowMs());
      for (const stop of selection.stops) options.onStop?.(stop);
      if (selection.contextGraphIds.length === 0) break;

      const continuationWork = selection.contextGraphIds
        .map((contextGraphId) => publicWorkByContextGraph.get(contextGraphId))
        .filter((item): item is ContextGraphSyncWork<SharedMemorySyncResult> => (
          item !== undefined
        ));
      const part = withoutContinuationPasses(
        await runOrdered(continuationWork, 'continuation', plan),
      );
      summary = withoutContinuationPasses(options.merge(summary, part));
      if ((part.deferredBackpressure ?? 0) > 0) {
        options.onBackpressure?.();
        break;
      }
    }
  }

  return { ...summary, continuationPasses: plan.continuationPasses() };
}
