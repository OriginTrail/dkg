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

export interface RunSelectedSwmContinuationsOptions {
  readonly plan: SelectedSwmContinuationPlan;
  readonly initialResult: SharedMemorySyncResult;
  readonly nowMs: () => number;
  /** Each call re-enters the caller's existing ordered scheduler admission. */
  readonly runPass: (contextGraphIds: readonly string[]) => Promise<SharedMemorySyncResult>;
  readonly merge: (
    summary: SharedMemorySyncResult,
    part: SharedMemorySyncResult,
  ) => SharedMemorySyncResult;
  readonly onStop?: (stop: SelectedSwmContinuationStop) => void;
  readonly onBackpressure?: () => void;
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

/**
 * Run only the continuation passes selected by {@link SelectedSwmContinuationPlan}.
 *
 * The initial pass is supplied by the caller because it also contains ordinary
 * SWM/private work. Every continuation calls `runPass` anew, so the global
 * scheduler slot is released between rounds. Any admission deferral terminates
 * this same-call continuation immediately; the normal reconciler remains the
 * later recovery path.
 */
export async function runSelectedSwmContinuations(
  options: RunSelectedSwmContinuationsOptions,
): Promise<SharedMemorySyncResult> {
  let summary = options.initialResult;
  if ((summary.deferredBackpressure ?? 0) > 0) {
    options.onBackpressure?.();
  } else {
    for (;;) {
      const selection = options.plan.selectNextPass(options.nowMs());
      for (const stop of selection.stops) options.onStop?.(stop);
      if (selection.contextGraphIds.length === 0) break;

      const part = await options.runPass(selection.contextGraphIds);
      summary = options.merge(summary, part);
      if ((part.deferredBackpressure ?? 0) > 0) {
        options.onBackpressure?.();
        break;
      }
    }
  }

  return {
    ...summary,
    continuationPasses: (summary.continuationPasses ?? 0)
      + options.plan.continuationPasses(),
  };
}
