import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDurableProgress,
  normalizeDurableSyncResult,
  type DKGAgent,
  type DurableProgressSummary,
  type DurableSyncDiagnostics,
  type DurableSyncResult,
} from '@origintrail-official/dkg-agent';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';

const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
const DURABLE_CATCHUP_PHASE_HEADROOM_MS = 1_000;
const MIN_DURABLE_CATCHUP_PHASE_BUDGET_MS = 1_000;
const DURABLE_CATCHUP_SETTLEMENT_GRACE_MS = 30_000;

export interface CatchupJobResult {
  connectedPeers: number;
  totalPeers?: number;
  selectedPeers?: number;
  syncCapablePeers: number;
  peersTried: number;
  /**
   * Subset of `peersTried` whose per-peer sync round reached a responder
   * and did not collapse into a transport failure. A responder can still
   * time out part-way through, deny access, or serve metadata-only rows; this
   * counter exists so daemon status mapping can distinguish "curator offline"
   * from "reachable peer answered but did not complete cleanly".
   */
  peersResponded: number;
  /**
   * Subset of `peersTried` whose per-peer sync round finished without a
   * transport failure, timeout, or explicit ACL denial, and with either real
   * progress or a clean non-metadata-only empty completion.
   */
  peersSucceeded: number;
  /**
   * Sync-capable peers this run deliberately never contacted because an earlier
   * wave already proved every requested plane. These are neither failures nor
   * successes; they exist so status mapping and operators can tell an
   * early-stopped run from a run where peers were unreachable.
   */
  peersNotAttempted?: number;
  /** Context Graph phases deferred by this node's local sync scheduler. */
  deferredBackpressure: number;
  dataSynced: number;
  sharedMemorySynced: number;
  denied: boolean;
  deniedPeers: number;
  /**
   * Per-plane evidence produced before peer results are aggregated. Aggregate
   * diagnostics intentionally retain every timeout/denial for observability,
   * but readiness must not let one bad peer mask another peer that completed
   * the same plane cleanly and stored verified data.
   */
  cleanPlaneCompletions?: {
    durable: {
      verifiedDataPeers: number;
      /** Peers that cleanly verified one or more V2 KAs with no public triples. */
      verifiedPrivateOnlyPeers: number;
      emptyPeers: number;
    };
    sharedMemory: {
      verifiedDataPeers: number;
      emptyPeers: number;
    };
  };
  diagnostics?: {
    noProtocolPeers: number;
    durable: {
      fetchedMetaTriples: number;
      fetchedDataTriples: number;
      insertedMetaTriples: number;
      insertedDataTriples: number;
      bytesReceived: number;
      resumedPhases: number;
      timedOutPhases: number;
      completedPhases: number;
      checkpointAdvances: number;
      emptyResponses: number;
      metaOnlyResponses: number;
      /** Cryptographically verified V2 responses whose public graph is intentionally empty. */
      verifiedPrivateOnlyResponses: number;
      dataRejectedMissingMeta: number;
      rejectedKcs: number;
      failedPeers: number;
      failedPhases: number;
      deferredBackpressure: number;
      deniedPhases?: number;
    };
    sharedMemory: {
      fetchedMetaTriples: number;
      fetchedDataTriples: number;
      insertedMetaTriples: number;
      insertedDataTriples: number;
      bytesReceived: number;
      resumedPhases: number;
      timedOutPhases: number;
      completedPhases: number;
      checkpointAdvances: number;
      emptyResponses: number;
      droppedDataTriples: number;
      failedPeers: number;
      failedPhases: number;
      deferredBackpressure: number;
      deniedPhases?: number;
    };
  };
}

export interface CatchupRunRequest {
  contextGraphId: string;
  includeSharedMemory: boolean;
}

export interface CatchupPhaseProgress extends DurableProgressSummary {
  bytesReceived?: number;
  emptyResponses?: number;
}

export type DurableLegDiagnostics = DurableSyncDiagnostics
  & Pick<DurableSyncResult, 'deniedPhases'>;

export interface DurableLegSummary {
  insertedTriples: number;
  diagnostics: DurableLegDiagnostics;
  complete: boolean;
  state: DurableCatchupLegState;
  failureReasons: DurableCatchupFailureReason[];
}

export type DurableCatchupLegState =
  | 'complete'
  | 'incomplete-progress'
  | 'failed'
  | 'indeterminate'
  | 'legacy';

export type DurableCatchupFailureCode =
  | 'failedPeers'
  | 'failedPhases'
  | 'deniedPhases'
  | 'rejectedKcs'
  | 'dataRejectedMissingMeta'
  | 'incompleteWithoutProgress'
  | 'indeterminateSettlement';

export type DurableCatchupFailureReason =
  | { code: DurableCatchupFailureCode; count: number }
  | { code: 'exception'; message: string };

/** The only agent capabilities required by the route-level durable leg. */
export interface DurableCatchupAgent {
  syncFromPeerDetailed?: OmitThisParameter<DKGAgent['syncFromPeerDetailed']>;
  syncFromPeer?: OmitThisParameter<DKGAgent['syncFromPeer']>;
}

export interface DurableCatchupLegResult {
  insertedTriples: number;
  state: DurableCatchupLegState;
  complete?: boolean;
  diagnostics?: DurableLegDiagnostics;
  failureReasons?: DurableCatchupFailureReason[];
}

export interface DurableCatchupAttempt {
  durableState?: DurableCatchupLegState;
  durableComplete?: boolean;
  durableError?: string;
  error?: string;
}

export interface DurableCatchupRequestOutcome {
  attempts: DurableCatchupAttempt[];
  perContextGraphCompletion: Array<boolean | undefined>;
  complete?: boolean;
  allPeersFailed: boolean;
  noEligibleAttempts: boolean;
  incomplete: boolean;
  responseStatus: 200 | 503;
  errorBody: {
    errorCode:
      | 'DURABLE_CATCHUP_ALL_PEERS_FAILED'
      | 'DURABLE_CATCHUP_NO_ELIGIBLE_PEERS'
      | 'DURABLE_CATCHUP_INCOMPLETE';
    error: string;
    retryable: true;
  } | undefined;
}

async function awaitLegacyDurableWithinBoundary<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

class DurableSettlementIndeterminateError extends Error {
  constructor(peerId: string, contextGraphId: string) {
    super(
      `Durable catchup from ${peerId} for ${contextGraphId} did not settle within `
      + `${DURABLE_CATCHUP_SETTLEMENT_GRACE_MS}ms after cancellation; `
      + 'the atomic commit outcome is indeterminate',
    );
    this.name = 'DurableSettlementIndeterminateError';
  }
}

async function awaitDetailedDurableSettlement<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  peerId: string,
  contextGraphId: string,
  atomicCommitStarted: () => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (graceTimer !== undefined || settled) return;
      if (!atomicCommitStarted()) {
        settleReject(signal.reason);
        return;
      }
      graceTimer = setTimeout(() => {
        settleReject(new DurableSettlementIndeterminateError(peerId, contextGraphId));
      }, DURABLE_CATCHUP_SETTLEMENT_GRACE_MS);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      settleResolve,
      settleReject,
    );
  });
}

/**
 * Adapt the agent's typed durable result for operator-facing catch-up APIs.
 * Whole-leg completion comes only from the explicit agent contract; phase
 * counters remain diagnostics and can describe safely committed prefixes.
 */
export function summarizeDurableLeg(result: DurableSyncResult): DurableLegSummary {
  const normalized = normalizeDurableSyncResult(result);
  const { insertedTriples, complete, ...diagnostics } = normalized;
  const failureReasons = [
    ['failedPeers', diagnostics.failedPeers],
    ['failedPhases', diagnostics.failedPhases],
    ['deniedPhases', diagnostics.deniedPhases],
    ['rejectedKcs', diagnostics.rejectedKcs],
    ['dataRejectedMissingMeta', diagnostics.dataRejectedMissingMeta],
  ].flatMap(([code, count]) => Number(count) > 0 ? [{
      code: code as DurableCatchupFailureCode,
      count: Number(count),
    }] : []);
  const committedProgress = insertedTriples > 0
    || diagnostics.insertedDataTriples > 0
    || diagnostics.insertedMetaTriples > 0
    || diagnostics.checkpointAdvances > 0;
  if (!complete && !committedProgress && failureReasons.length === 0) {
    // A timeout/backpressure stop before the first durable boundary is not a
    // successful no-op. Give the HTTP adapter a typed failure reason so
    // durable-only automation keeps retrying instead of treating 200/ok as an
    // already-synchronized graph. Safely committed prefixes remain observable
    // as retryable progress and intentionally do not enter this branch.
    failureReasons.push({ code: 'incompleteWithoutProgress', count: 1 });
  }
  const state: DurableCatchupLegState = complete && failureReasons.length === 0
    ? 'complete'
    : failureReasons.length > 0
      ? 'failed'
      : 'incomplete-progress';
  return {
    insertedTriples,
    diagnostics,
    complete: state === 'complete',
    state,
    failureReasons,
  };
}

/** Convert typed leg failures to the legacy operator-facing message at the HTTP boundary. */
export function formatDurableCatchupFailure(
  reasons: readonly DurableCatchupFailureReason[] | undefined,
): string | undefined {
  if (!reasons || reasons.length === 0) return undefined;
  const exception = reasons.find(
    (reason): reason is Extract<DurableCatchupFailureReason, { code: 'exception' }> => (
      reason.code === 'exception'
    ),
  );
  if (exception) return exception.message;
  return `Durable sync did not complete (${reasons
    .map((reason) => reason.code === 'exception'
      ? reason.message
      : `${reason.code}=${reason.count}`)
    .join(', ')})`;
}

/**
 * Execute one durable route leg behind a typed capability boundary. Detailed
 * agents expose completion/diagnostics; older agents retain the legacy count.
 */
export async function runDurableCatchupLeg(
  agent: DurableCatchupAgent,
  peerId: string,
  contextGraphId: string,
  overallTimeoutMs: number,
): Promise<DurableCatchupLegResult> {
  const timeoutError = new Error(
    `Durable catchup from ${peerId} for ${contextGraphId} timed out after ${overallTimeoutMs}ms`,
  );
  timeoutError.name = 'AbortError';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError), overallTimeoutMs);
  const phaseTimeoutMs = Math.max(
    MIN_DURABLE_CATCHUP_PHASE_BUDGET_MS,
    overallTimeoutMs - DURABLE_CATCHUP_PHASE_HEADROOM_MS,
  );
  try {
    if (typeof agent.syncFromPeerDetailed === 'function') {
      let atomicCommitStarted = false;
      // Cancellable work stops at the route deadline. A dispatched atomic
      // commit retains a bounded grace window to report its truthful outcome;
      // if the detailed adapter still does not settle, return an explicit
      // indeterminate state instead of hanging forever or claiming zero work.
      const detailed = await awaitDetailedDurableSettlement(
        agent.syncFromPeerDetailed(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          undefined,
          {
            totalTimeoutMs: phaseTimeoutMs,
            signal: controller.signal,
            onAtomicCommitStarted: () => {
              atomicCommitStarted = true;
            },
          },
        ),
        controller.signal,
        peerId,
        contextGraphId,
        () => atomicCommitStarted,
      );
      const summary = summarizeDurableLeg(detailed);
      return {
        insertedTriples: summary.insertedTriples,
        state: summary.state,
        complete: summary.complete,
        diagnostics: summary.diagnostics,
        ...(summary.failureReasons.length > 0 ? { failureReasons: summary.failureReasons } : {}),
      };
    }

    const insertedTriples = typeof agent.syncFromPeer === 'function'
      // Legacy implementations do not expose the detailed lane's atomic
      // settlement contract and may ignore AbortSignal entirely. Keep the
      // route hard-bounded instead of allowing a stale adapter to pin the
      // whole catch-up request forever.
      ? await awaitLegacyDurableWithinBoundary(
        agent.syncFromPeer(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          {
            totalTimeoutMs: phaseTimeoutMs,
            signal: controller.signal,
          },
        ),
        controller.signal,
      )
      : 0;
    return {
      insertedTriples,
      state: 'legacy',
    };
  } catch (error) {
    if (error instanceof DurableSettlementIndeterminateError) {
      return {
        insertedTriples: 0,
        state: 'indeterminate',
        complete: false,
        failureReasons: [{
          code: 'indeterminateSettlement',
          count: 1,
        }],
      };
    }
    return {
      insertedTriples: 0,
      state: 'failed',
      complete: false,
      failureReasons: [{
        code: 'exception',
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  } finally {
    clearTimeout(timer);
  }
}

export function durableCatchupCompletionFor(
  attempts: readonly DurableCatchupAttempt[],
): boolean | undefined {
  if (attempts.some((attempt) => attempt.durableComplete === true)) return true;
  return attempts.length > 0 && attempts.every((attempt) => attempt.durableComplete !== undefined)
    ? false
    : undefined;
}

/**
 * Aggregate completion across every requested CG. A complete subset must not
 * manufacture a complete whole-request verdict when another CG had no result.
 */
export function classifyDurableCatchupRequest(
  perContextGraphAttempts: ReadonlyArray<readonly DurableCatchupAttempt[]>,
  includeDurable: boolean,
  includeSharedMemory: boolean,
): DurableCatchupRequestOutcome {
  const attempts = includeDurable ? perContextGraphAttempts.flatMap((parts) => [...parts]) : [];
  const perContextGraphCompletion = perContextGraphAttempts.map(durableCatchupCompletionFor);
  const missingContextGraphAttempt = includeDurable
    && !includeSharedMemory
    && perContextGraphAttempts.length > 0
    && perContextGraphAttempts.some((parts) => parts.length === 0);
  const everyContextGraphCompletionKnown = perContextGraphCompletion.length > 0
    && perContextGraphCompletion.every((value) => value !== undefined);
  const complete = missingContextGraphAttempt
    ? false
    : includeDurable && everyContextGraphCompletionKnown
      ? perContextGraphCompletion.every((value) => value === true)
      : undefined;
  const allPeersFailed = includeDurable
    && !includeSharedMemory
    && attempts.length > 0
    && attempts.every((attempt) => (
      attempt.durableState === 'failed'
      || (attempt.durableState === undefined && Boolean(attempt.error))
    ));
  const noEligibleAttempts = missingContextGraphAttempt && attempts.length === 0;
  const incomplete = includeDurable
    && !includeSharedMemory
    && complete === false
    && !allPeersFailed;

  return {
    attempts,
    perContextGraphCompletion,
    complete,
    allPeersFailed,
    noEligibleAttempts,
    incomplete,
    responseStatus: allPeersFailed || noEligibleAttempts ? 503 : 200,
    errorBody: allPeersFailed
      ? {
        errorCode: 'DURABLE_CATCHUP_ALL_PEERS_FAILED',
        error: 'Durable catchup failed for every selected peer',
        retryable: true,
      }
      : noEligibleAttempts
        ? {
          errorCode: 'DURABLE_CATCHUP_NO_ELIGIBLE_PEERS',
          error: 'Durable catchup had no eligible peer for any requested context graph',
          retryable: true,
        }
      : incomplete
        ? {
          errorCode: 'DURABLE_CATCHUP_INCOMPLETE',
          error: 'Durable catchup committed partial progress but did not reach the terminal boundary',
          retryable: true,
        }
        : undefined,
  };
}

export function catchupPlaneCompletedWithoutFailure(
  progress: CatchupPhaseProgress | null | undefined,
  complete?: boolean,
): boolean {
  return classifyDurableProgress(progress, { complete }).completedWithoutFailure;
}

/** Per-plane clean-completion evidence accumulated across the peers this run contacted. */
export interface CatchupPlaneCompletionEvidence {
  verifiedDataPeers: number;
  /** Peers that cleanly verified one or more V2 KAs with no public triples. */
  verifiedPrivateOnlyPeers?: number;
  emptyPeers: number;
}

/** The aggregate per-plane counters a whole-round verdict is allowed to consult. */
export interface CatchupPlaneRoundDiagnostics {
  fetchedMetaTriples?: number;
  fetchedDataTriples?: number;
  emptyResponses?: number;
  failedPeers?: number;
  failedPhases?: number;
  timedOutPhases?: number;
  deniedPhases?: number;
  deferredBackpressure?: number;
}

/**
 * Positive proof: some peer cleanly completed this plane while carrying
 * cryptographically verified content. This is the only evidence strong enough
 * to stop contacting further peers mid-run, because it is the only evidence a
 * single peer can produce on its own.
 */
export function catchupPlaneProvenByData(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.verifiedDataPeers ?? 0) > 0
    || (completion?.verifiedPrivateOnlyPeers ?? 0) > 0;
}

/**
 * Whole-round proof that a public plane really is empty.
 *
 * A peer that has never heard of a Context Graph and a peer that hosts an empty
 * one are byte-identical on the wire: an unknown CG has no access policy, so the
 * responder authorizes the request and its CG-scoped queries simply return zero
 * rows. The requester only reports `emptyResponses` when BOTH phase payloads are
 * empty (`sync-verify-worker-impl.ts`), so an empty response can never carry
 * hosting evidence — there is no per-peer signal that could distinguish the two.
 *
 * Emptiness is therefore only provable as a verdict over the whole round:
 * at least one peer completed cleanly empty, nobody delivered any content, and
 * nothing failed, timed out, was denied, or was deferred. One data-bearing peer
 * that fails is enough to void it — that exact shape (122,705 triples fetched,
 * five failed phases, five unrelated peers answering empty) is what settled
 * issue #2006's run as `done` with 1 KA out of 40.
 */
export function catchupPlaneProvenByUnanimousEmpty(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  // Empty or metadata-only responses have never been able to prove that a
  // private graph is fully synchronized; that stays unchanged.
  if (options.isPrivate) return false;
  if (catchupPlaneProvenByData(completion)) return false;
  const cleanEmptyObserved = (completion?.emptyPeers ?? 0) > 0
    || (diagnostics?.emptyResponses ?? 0) > 0;
  if (!cleanEmptyObserved) return false;
  if ((diagnostics?.fetchedDataTriples ?? 0) > 0) return false;
  if ((diagnostics?.fetchedMetaTriples ?? 0) > 0) return false;
  return (diagnostics?.failedPeers ?? 0) === 0
    && (diagnostics?.failedPhases ?? 0) === 0
    && (diagnostics?.timedOutPhases ?? 0) === 0
    && (diagnostics?.deniedPhases ?? 0) === 0
    && (diagnostics?.deferredBackpressure ?? 0) === 0;
}

/**
 * Canonical readiness proof for one catch-up plane. The peer walk stops early
 * only on {@link catchupPlaneProvenByData}, so whenever this function falls
 * through to the unanimous-empty branch the full peer set really was walked and
 * the "nobody saw anything" denominator is meaningful.
 */
export function catchupPlaneReady(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  return catchupPlaneProvenByData(completion)
    || catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
}

export function catchupPeerSucceeded(
  durable: CatchupPhaseProgress | null | undefined,
  shared: CatchupPhaseProgress | null | undefined,
  peerDenied: boolean,
  durableComplete?: boolean,
): boolean {
  const durableProgress = classifyDurableProgress(durable, { complete: durableComplete });
  const sharedProgress = shared ? classifyDurableProgress(shared) : null;
  if (
    !catchupPeerResponded(durable, shared)
    || peerDenied
    || durableProgress.denied
    || Boolean(sharedProgress?.denied)
  ) return false;
  if (durableProgress.deferredByBackpressure || sharedProgress?.deferredByBackpressure) return false;
  const peerTransportFailed = durableProgress.transportFailed || Boolean(sharedProgress?.transportFailed);
  if (peerTransportFailed) return false;
  const peerPhaseFailed = durableProgress.phaseFailed || Boolean(sharedProgress?.phaseFailed);
  if (peerPhaseFailed) return false;
  if (durableProgress.integrityRejected || sharedProgress?.integrityRejected) return false;
  const peerMadeProgress = durableProgress.madeReadinessProgress
    || Boolean(sharedProgress?.madeReadinessProgress);
  const peerMetadataOnly = !peerMadeProgress
    && (durableProgress.hasMetadataEvidence || Boolean(sharedProgress?.hasMetadataEvidence));
  const peerTimedOut = durableProgress.timedOut || Boolean(sharedProgress?.timedOut);
  return !peerTimedOut && (peerMadeProgress || !peerMetadataOnly);
}

export function catchupPeerResponded(
  durable: CatchupPhaseProgress | null | undefined,
  shared: CatchupPhaseProgress | null | undefined,
): boolean {
  // A plane the walk deliberately skipped (already proven by an earlier peer)
  // is absent, not silent: it must not be read as this peer having answered.
  const phaseResponded = (phase: CatchupPhaseProgress | null | undefined): boolean => {
    if (!phase) return false;
    const progress = classifyDurableProgress(phase);
    if (progress.transportFailed) return false;
    if (!progress.deferredByBackpressure) return true;
    return (phase.bytesReceived ?? 0) > 0
      || (phase.completedPhases ?? 0) > 0
      || (phase.emptyResponses ?? 0) > 0
      || (phase.insertedMetaTriples ?? 0) > 0
      || (phase.insertedDataTriples ?? phase.insertedTriples ?? 0) > 0;
  };
  return phaseResponded(durable) || phaseResponded(shared);
}

export interface CatchupRunner {
  run(request: CatchupRunRequest): Promise<CatchupJobResult>;
  close(): Promise<void>;
}

type PendingRun = {
  resolve: (value: CatchupJobResult) => void;
  reject: (error: Error) => void;
};

type PendingInvoke = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerMessage =
  | { type: 'run-result'; runId: number; result?: CatchupJobResult; error?: string }
  | { type: 'invoke'; invokeId: number; method: string; args: unknown[] };

export function createCatchupRunner(agent: DKGAgent): CatchupRunner {
  return new WorkerCatchupRunner(agent);
}

export function createInlineCatchupRunner(agent: DKGAgent): CatchupRunner {
  return new InlineCatchupRunner(agent);
}

async function waitForSyncProtocolFromPeerProtocols(
  getPeerProtocols: (peerId: string) => Promise<string[]>,
  peerId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < SYNC_PROTOCOL_CHECK_ATTEMPTS; attempt += 1) {
    const protocols: string[] = await getPeerProtocols(peerId).catch((): string[] => []);
    if (protocols.includes(PROTOCOL_SYNC)) {
      return true;
    }
    if (attempt < SYNC_PROTOCOL_CHECK_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_PROTOCOL_CHECK_DELAY_MS));
    }
  }
  return false;
}

class WorkerCatchupRunner implements CatchupRunner {
  private readonly worker: Worker;
  private nextRunId = 0;
  private readonly pendingRuns = new Map<number, PendingRun>();

  constructor(private readonly agent: DKGAgent) {
    const jsWorkerUrl = new URL('./catchup-runner-worker-impl.js', import.meta.url);
    const tsWorkerUrl = new URL('./catchup-runner-worker-impl.ts', import.meta.url);
    const workerUrl = existsSync(fileURLToPath(jsWorkerUrl)) ? jsWorkerUrl : tsWorkerUrl;
    this.worker = new Worker(fileURLToPath(workerUrl));
    this.worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'run-result') {
        const pending = this.pendingRuns.get(message.runId);
        if (!pending) return;
        this.pendingRuns.delete(message.runId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result as CatchupJobResult);
        return;
      }
      if (message.type === 'invoke') {
        void this.handleInvoke(message);
      }
    });
    this.worker.on('error', (error) => {
      this.rejectPendingRuns(error);
    });
    // `close()` terminates the worker, which emits 'exit' — never 'error'.
    // Without this handler every in-flight `run()` promise stays pending
    // forever, so the daemon's fire-and-forget subscribe job is pinned at
    // `running` with no `finishedAt` for the rest of the process's life.
    this.worker.on('exit', (code) => {
      this.rejectPendingRuns(
        new Error(`Catch-up worker exited (code ${code}) before the run completed`),
      );
    });
  }

  private rejectPendingRuns(error: Error): void {
    const pending = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    for (const run of pending) run.reject(error);
  }

  run(request: CatchupRunRequest): Promise<CatchupJobResult> {
    const runId = this.nextRunId++;
    return new Promise<CatchupJobResult>((resolve, reject) => {
      this.pendingRuns.set(runId, { resolve, reject });
      this.worker.postMessage({ type: 'run', runId, request });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }

  private async handleInvoke(message: Extract<WorkerMessage, { type: 'invoke' }>): Promise<void> {
    try {
      const result = await this.invokeAgent(message.method, message.args);
      this.worker.postMessage({ type: 'invoke-result', invokeId: message.invokeId, result });
    } catch (error) {
      this.worker.postMessage({
        type: 'invoke-result',
        invokeId: message.invokeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async invokeAgent(method: string, args: unknown[]): Promise<unknown> {
    const agent = this.agent as any;
    switch (method) {
      case 'prepareCatchup': {
        const [contextGraphId] = args as [string];
        const isPrivateContextGraph = await agent.isPrivateContextGraph(contextGraphId);
        const preferredPeerId = await agent.resolvePreferredSyncPeerId(contextGraphId);
        if (preferredPeerId) {
          await agent.ensurePeerConnected(preferredPeerId);
        }
        await agent.primeCatchupConnections();

        const peerIds = agent.selectCatchupPeers(
          [...new Map(
            agent.node.libp2p.getConnections().map((connection: any) => [connection.remotePeer.toString(), connection.remotePeer]),
          ).values()],
          preferredPeerId,
          isPrivateContextGraph,
        ).map((peer: { toString(): string }) => peer.toString());

        return {
          preferredPeerId,
          isPrivateContextGraph,
          peerIds,
          connectedPeers: peerIds.length,
        };
      }
      case 'waitForSyncProtocol': {
        const [peerId] = args as [string];
        if (typeof agent.getPeerProtocols === 'function') {
          return waitForSyncProtocolFromPeerProtocols(agent.getPeerProtocols.bind(agent), peerId);
        }
        return agent.waitForSyncProtocol({ toString: () => peerId });
      }
      case 'syncDurable': {
        const [peerId, contextGraphId, priority, source] = args as [
          string, string, number | undefined, string | undefined,
        ];
        return agent.syncFromPeerDetailed(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          undefined,
          { ...(priority === undefined ? {} : { priority }), source },
        );
      }
      case 'syncSharedMemory': {
        const [peerId, contextGraphId, priority, source] = args as [
          string, string, number | undefined, string | undefined,
        ];
        return agent.syncSharedMemoryFromPeerDetailed(
          peerId,
          [contextGraphId],
          { ...(priority === undefined ? {} : { priority }), source },
        );
      }
      case 'finalizeCatchup': {
        const [contextGraphId] = args as [string, number, number];
        await agent.refreshMetaSyncedFlags([contextGraphId]);
        // Readiness is classified by the daemon route after the worker returns
        // its complete per-plane diagnostics. Insert counts alone can describe
        // an early page followed by a timeout; marking here would persist a
        // false-ready window before the route can reject that partial result.
        return null;
      }
      default:
        throw new Error(`Unknown catch-up worker invoke method: ${method}`);
    }
  }
}

class InlineCatchupRunner implements CatchupRunner {
  constructor(private readonly agent: DKGAgent) {}

  run(request: CatchupRunRequest): Promise<CatchupJobResult> {
    return this.agent.syncContextGraphFromConnectedPeers(request.contextGraphId, {
      includeSharedMemory: request.includeSharedMemory,
      mode: 'foreground',
    }) as Promise<CatchupJobResult>;
  }

  async close(): Promise<void> {
    // No resources to close.
  }
}
