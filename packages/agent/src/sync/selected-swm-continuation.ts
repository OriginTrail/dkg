import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../dkg-agent-types.js';
import {
  SwmCatchupPassTracker,
  runSwmCatchupContinuations,
  shouldRunAnotherCatchupPass,
  type CatchupPassConfig,
  type CatchupPassDecision,
  type CatchupPassDecisionReason,
  type SwmCatchupProgressLedger,
} from './catchup-pass-policy.js';
import { classifyDurableProgress } from './durable-progress.js';
import {
  classifySelectedSwmRoundFreshness,
  type SelectedSwmFreshnessResolution,
} from './shared-memory-freshness.js';
import type { SyncContextGraphPriorityConfig } from './policy.js';
import {
  MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES,
  runOrderedContextGraphSyncs,
  type ContextGraphSyncWork,
} from './requester/ordered-sync.js';

export interface SelectedSwmContinuationUnit {
  readonly work: ContextGraphSyncWork<SharedMemorySyncResult>;
  readonly initialResult: SharedMemorySyncResult;
  /**
   * Exact pre-snapshot progress retained by the selected-provider invocation.
   * Presence means another bounded pass can resume useful work; absence clears
   * that capability without erasing its monotone high-water mark.
   */
  readonly metadataContinuationProgress?: () => number | undefined;
  /** Generation of that prefix; changes when the responder restarts at zero. */
  readonly metadataContinuationGeneration?: () => number | undefined;
  /** Metadata-phase completion, independent of later data/snapshot/store work. */
  readonly metadataContinuationCompleted?: () => boolean;
}

export interface SelectedSwmContinuationStop {
  readonly contextGraphId: string;
  readonly continuationPasses: number;
  readonly reason: CatchupPassDecisionReason;
}

export interface SelectedSwmContinuationProgress {
  readonly contextGraphId: string;
  readonly progressBefore: number;
  readonly progressAfter: number;
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
  ledger: SelectedSwmContinuationLedger;
  planeProven: boolean;
  recoverableIncomplete: number;
  recoverableMetadataYields: number;
  metadataCompleted: boolean;
  completed: boolean;
}

type SelectedProgressDomain =
  | `metadata:${number}`
  | `post-metadata:${number}`
  | 'snapshot'
  | 'none';

/**
 * Selected-provider progress ledger.
 *
 * Metadata offsets and resolved snapshot counts are deliberately different
 * domains. A domain transition clears only the stall baseline, granting the
 * newly capable domain its first bounded pass while preserving the one global
 * continuation count, time budget and pass cap owned by the shared executor.
 */
class SelectedSwmContinuationLedger implements SwmCatchupProgressLedger {
  private readonly snapshotTracker = new SwmCatchupPassTracker<SwmSnapshotCoverage>();

  private metadataGeneration = 0;

  private metadataProgress = 0;

  private domain: SelectedProgressDomain = 'none';

  private progressBaseline = 0;

  private progressBaselineEstablished = false;

  private completedPasses = 0;

  constructor(private readonly providerPeerId: string) {}

  recordRound(input: {
    coverage: SwmSnapshotCoverage | undefined;
    completedWithoutFailure: boolean;
    metadataProgress: number | undefined;
    metadataGeneration: number;
    metadataCompleted: boolean;
  }): void {
    this.snapshotTracker.recordPeerRound(
      this.providerPeerId,
      input.coverage,
      input.completedWithoutFailure,
    );

    if (!Number.isSafeInteger(input.metadataGeneration) || input.metadataGeneration < 0) {
      throw new Error(
        `Invalid selected SWM metadata continuation generation for ${this.providerPeerId}: `
        + `${input.metadataGeneration}`,
      );
    }
    if (
      input.metadataProgress !== undefined
      && (!Number.isSafeInteger(input.metadataProgress) || input.metadataProgress < 0)
    ) {
      throw new Error(
        `Invalid selected SWM metadata continuation progress for ${this.providerPeerId}: `
        + `${input.metadataProgress}`,
      );
    }
    if (input.metadataGeneration !== this.metadataGeneration) {
      this.metadataGeneration = input.metadataGeneration;
      this.metadataProgress = 0;
    }
    if (
      input.metadataProgress !== undefined
      && input.metadataProgress > this.metadataProgress
    ) {
      this.metadataProgress = input.metadataProgress;
    }

    const snapshotCapable = this.snapshotTracker.capablePeers().length > 0;
    let nextDomain: SelectedProgressDomain = 'none';
    if (snapshotCapable) {
      nextDomain = 'snapshot';
    } else if (!input.metadataCompleted && this.metadataProgress > 0) {
      nextDomain = `metadata:${this.metadataGeneration}`;
    } else if (
      input.metadataCompleted
      && input.metadataProgress !== undefined
      && !input.completedWithoutFailure
    ) {
      // A complete retained manifest can still make another bounded attempt at
      // aggregate data, verification, materialization or store work before any
      // incomplete snapshot coverage exists. This is capability, not offset
      // progress, so it gets its own constant-unit domain.
      nextDomain = `post-metadata:${this.metadataGeneration}`;
    } else if (input.coverage?.manifestComplete) {
      // Preserve a terminal snapshot reading for diagnostics. Capability still
      // comes from the snapshot tracker, so complete coverage earns no retry.
      nextDomain = 'snapshot';
    }
    if (nextDomain !== this.domain) {
      this.domain = nextDomain;
      this.progressBaseline = 0;
      this.progressBaselineEstablished = false;
    }
  }

  private capablePeers(): string[] {
    if (this.domain === 'snapshot') return this.snapshotTracker.capablePeers();
    if (this.domain === 'none') return [];
    return [this.providerPeerId];
  }

  progress(): number {
    if (this.domain === 'snapshot') return this.snapshotTracker.progress();
    if (this.domain.startsWith('metadata:')) return this.metadataProgress;
    if (this.domain.startsWith('post-metadata:')) return 1;
    return 0;
  }

  continuationPasses(): number {
    return this.completedPasses;
  }

  decide(input: {
    nowMs: number;
    deadlineMs: number;
    maxPasses: number;
    planeProven: boolean;
  }): CatchupPassDecision {
    return shouldRunAnotherCatchupPass({
      ...input,
      passesRun: 1 + this.completedPasses,
      progressHighWaterMark: this.progressBaseline,
      lastPassProgress: this.progress(),
      progressBaselineEstablished: this.progressBaselineEstablished,
      capablePeers: this.capablePeers(),
    });
  }

  startContinuationPass(): number {
    const before = this.progress();
    this.progressBaseline = before;
    this.progressBaselineEstablished = true;
    this.completedPasses += 1;
    return before;
  }
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
    const freshness = classifySelectedSwmRoundFreshness(
      contextGraphId,
      unit.initialResult,
    );
    const metadataCompleted = unit.metadataContinuationCompleted?.() ?? (
      unit.metadataContinuationProgress?.() === undefined
      && progress.completedWithoutFailure
    );
    const ledger = new SelectedSwmContinuationLedger(options.providerPeerId);
    ledger.recordRound({
      coverage: unit.initialResult.swmCoverage,
      completedWithoutFailure: progress.completedWithoutFailure,
      metadataProgress: unit.metadataContinuationProgress?.(),
      metadataGeneration: unit.metadataContinuationGeneration?.() ?? 0,
      metadataCompleted,
    });
    stateByContextGraph.set(contextGraphId, {
      unit,
      ledger,
      planeProven:
        unit.initialResult.insertedDataTriples > 0 && progress.completedWithoutFailure,
      recoverableIncomplete: freshness.recoverableSnapshotYieldFailures,
      recoverableMetadataYields: freshness.recoverableMetadataContinuationYields,
      metadataCompleted,
      completed: freshness.snapshotPlaneComplete,
    });
  }

  let summary = options.emptyResult();
  // `runOrderedContextGraphSyncs` owns the peer-dead cutoff for one batch, but
  // this adapter can re-enter it with the candidates that the prior batch did
  // not start. Preserve the same streak across those outer passes or eight
  // selected CGs against one dead provider become eight full transport waits.
  let consecutivePeerTransportFailures = 0;
  let peerTransportCutoffReached = false;
  const execution = await runSwmCatchupContinuations({
    units: [...stateByContextGraph.values()].map((state) => ({
      key: state,
      ledger: state.ledger,
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
              const freshness = classifySelectedSwmRoundFreshness(
                item.contextGraphId,
                result,
              );
              state.recoverableIncomplete += freshness.recoverableSnapshotYieldFailures;
              state.recoverableMetadataYields += freshness.recoverableMetadataContinuationYields;
              state.metadataCompleted = state.metadataCompleted || (
                state.unit.metadataContinuationCompleted?.() ?? (
                  state.unit.metadataContinuationProgress?.() === undefined
                  && progress.completedWithoutFailure
                )
              );
              state.ledger.recordRound({
                coverage: result.swmCoverage,
                completedWithoutFailure: progress.completedWithoutFailure,
                metadataProgress: state.unit.metadataContinuationProgress?.(),
                metadataGeneration:
                  state.unit.metadataContinuationGeneration?.() ?? 0,
                metadataCompleted: state.metadataCompleted,
              });
              state.completed = freshness.snapshotPlaneComplete;
              state.planeProven = state.planeProven || (
                result.insertedDataTriples > 0 && progress.completedWithoutFailure
              );
              options.onContinuation?.({
                contextGraphId: item.contextGraphId,
                progressBefore: pass.progressBefore,
                progressAfter: pass.progress(),
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
          ? {
            isPeerTransportFailure: (part: SharedMemorySyncResult) => {
              const failed = options.isPeerTransportFailure!(part);
              consecutivePeerTransportFailures = failed
                ? consecutivePeerTransportFailures + 1
                : 0;
              if (
                consecutivePeerTransportFailures
                >= MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES
              ) {
                peerTransportCutoffReached = true;
              }
              return failed;
            },
          }
          : {}),
        ...(options.onDeferred ? { onDeferred: options.onDeferred } : {}),
      }));
      summary = withoutContinuationPasses(options.merge(summary, part));
      return part;
    },
    shouldStopAfterPass: (part) => (
      peerTransportCutoffReached || (part.deferredBackpressure ?? 0) > 0
    ),
    onStop: (stop) => options.onStop?.({
      contextGraphId: stop.key.unit.work.contextGraphId,
      continuationPasses: stop.continuationPasses,
      reason: stop.reason,
    }),
  });

  if (execution.stoppedAfterPass && !peerTransportCutoffReached) {
    options.onBackpressure?.();
  }
  const recoverableSnapshotYieldFailures = [...stateByContextGraph.values()].reduce(
    (total, state) => total + (state.completed ? state.recoverableIncomplete : 0),
    0,
  );
  const recoverableMetadataContinuationYields = [...stateByContextGraph.values()].reduce(
    (total, state) => total + (state.metadataCompleted ? state.recoverableMetadataYields : 0),
    0,
  );
  return {
    summary: {
      ...summary,
      continuationPasses: execution.continuationPasses,
    },
    freshnessResolution: {
      recoverableSnapshotYieldFailures,
      recoverableMetadataContinuationYields,
    },
  };
}
