import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authoritativeSyncPeerId,
  classifyDurableProgress,
  normalizeDurableSyncResult,
  normalizeSyncAdmissionSource,
  type DKGAgent,
  type CatchupPassDecisionReason,
  type DurableProgressSummary,
  type DurableProgressClassification,
  type DurableSyncDiagnostics,
  type DurableSyncResult,
  type SwmSnapshotCoverage,
  type SyncPeerResolution,
} from '@origintrail-official/dkg-agent';
import { PROTOCOL_SYNC, createOperationContext } from '@origintrail-official/dkg-core';

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
    /** Always carries `verifiedPrivateOnlyPeers`; only the durable plane can produce it. */
    durable: CatchupPlaneCompletionEvidence & { verifiedPrivateOnlyPeers: number };
    sharedMemory: CatchupPlaneCompletionEvidence;
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
      /** A resolvable curator never cleanly answered this plane; see
       * `catchupPlaneProvenByUnanimousEmpty`. */
      authorityUnanswered?: boolean;
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
      /** A resolvable curator never cleanly answered this plane; see
       * `catchupPlaneProvenByUnanimousEmpty`. */
      authorityUnanswered?: boolean;
      /**
       * Public-SWM snapshot coverage for this graph, selected WHOLE from one
       * peer round by `selectSwmSnapshotCoverage`. The counts, the peer they
       * are attributed to and the missing sample are never mixed across peers.
       */
      swmCoverage?: SwmSnapshotCoverage;
      /** Snapshot phases that yielded on the local clock — see the agent-side field. */
      snapshotPlaneIncomplete: number;
      /** Extra passes over the peer set beyond the first. */
      continuationPasses: number;
      /**
       * Why the bounded repeat stopped, as the policy's own closed union — so a
       * new reason cannot reach the terminal message unnoticed.
       */
      continuationStopReason?: CatchupPassDecisionReason;
      /**
       * `bytesReceived` split into its replay half (metadata + aggregate data,
       * which every pass re-fetches in full) and its useful half (snapshot
       * content), so the cost of repeating the walk stays measurable instead of
       * being merged into one scalar. The two sum to `bytesReceived`.
       */
      replayPhaseBytesReceived: number;
      snapshotPhaseBytesReceived: number;
    };
  };
}

export interface CatchupRunRequest {
  contextGraphId: string;
  includeSharedMemory: boolean;
  /** Host agent owns one durable transfer across every peer-shaped Worker round. */
  graphOwnedDurableRecovery?: boolean;
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
  /**
   * RFC-64 providers whose selected public-SWM scope reached its explicit
   * terminal boundary. Unlike an ordinary peer's empty response, this is a
   * graph-complete proof tied to the accepted provider policy.
   */
  selectedScopeCompletePeers?: number;
  emptyPeers: number;
  /**
   * The metadata-resolved curator cleanly completed this plane while hosting
   * the graph and carrying no data at all. See
   * {@link catchupPlaneProvenByUnanimousEmpty}.
   */
  authorityEmptyPeers?: number;
  /**
   * Peers that ANSWERED this plane but whose round did not complete cleanly.
   *
   * Every other field here records what a peer proved. This one records what a
   * peer left unresolved, and it exists because the absence of a peer from the
   * positive counters is ambiguous: `catchupPeerPlaneEvidence` returns an
   * all-zero record for an incomplete round, so a peer that answered EMPTY but
   * did not finish paging is indistinguishable from a peer that was never
   * contacted. That ambiguity is invisible to the round diagnostics too — an
   * explicit `complete: false` is not a transport failure, so it never reaches
   * `failedPeers`.
   *
   * Without it, a round of one clean-empty peer plus one incomplete-empty peer
   * reads as unanimously empty. Pure transport failures are deliberately NOT
   * counted here: an unreachable stranger is already `failedPeers`, and folding
   * it in would pin legitimately empty graphs in a retry loop on a lossy
   * network.
   */
  incompleteResponders?: number;
}

/** The aggregate per-plane counters a whole-round verdict is allowed to consult. */
export interface CatchupPlaneRoundDiagnostics {
  fetchedMetaTriples?: number;
  fetchedDataTriples?: number;
  emptyResponses?: number;
  /** Peers that returned `_meta` and no data; durable-only. */
  metaOnlyResponses?: number;
  failedPeers?: number;
  failedPhases?: number;
  timedOutPhases?: number;
  deniedPhases?: number;
  deferredBackpressure?: number;
  /** Durable-only integrity rejections; the shared-memory plane never sets them. */
  dataRejectedMissingMeta?: number;
  rejectedKcs?: number;
  /**
   * A metadata-resolved curator WAS selected for this walk and did not cleanly
   * answer this plane — it transport-failed, timed out, was denied, or never got
   * contacted. Distinct from `failedPeers`, which counts any unreachable peer.
   */
  authorityUnanswered?: boolean;
}

/**
 * Reduce ONE peer's plane result to the evidence a round accumulates from it.
 *
 * This is the single definition of what a peer's round contributes, so the
 * walk's stop condition and the readiness classifier cannot drift: the walk
 * feeds one peer's evidence to {@link catchupPlaneProvenByData}, and readiness
 * feeds the summed evidence to the same predicate. Adding a new verified-content
 * signal therefore has exactly one place to change.
 *
 * A plane that did not complete cleanly contributes nothing at all.
 */
export function catchupPeerPlaneEvidence(
  plane:
    | (CatchupPhaseProgress & { emptyResponses?: number; fetchedDataTriples?: number })
    | null
    | undefined,
  options: {
    /**
     * Which plane this result came from. REQUIRED, and deliberately not
     * defaulted: the strongest thing this function can say — hosted-empty
     * evidence — is true on the durable plane and false on shared memory, so a
     * defaulted `plane` would let a shared-memory call site silently take the
     * durable branch. Only a test would notice, and the whole point is that a
     * mistake here settles a plane nobody proved.
     */
    plane: 'durable' | 'shared-memory';
    /** Durable lifecycle state; selected SWM supplies its own typed equivalent. */
    complete?: boolean;
    /**
     * Lane-specific clean-completion verdict when raw diagnostics deliberately
     * retain superseded failures. Selected SWM is the current producer: its
     * freshness classifier resolves bounded historical yields while preserving
     * those counters for telemetry.
     */
    completedWithoutFailure?: boolean;
    fromAuthority?: boolean;
  },
): CatchupPlaneCompletionEvidence {
  const none = {
    verifiedDataPeers: 0,
    verifiedPrivateOnlyPeers: 0,
    emptyPeers: 0,
    authorityEmptyPeers: 0,
  };
  if (!plane) return none;
  if (!(options.completedWithoutFailure
    ?? catchupPlaneCompletedWithoutFailure(plane, options.complete))) {
    // The peer answered and its round was not clean. A pure transport failure is
    // NOT that: we never heard from it, it is already counted in `failedPeers`,
    // and treating unreachable strangers as unresolved evidence would stop a
    // genuinely empty graph from ever settling on a lossy network.
    const answeredButUnresolved = (plane.failedPeers ?? 0) === 0;
    return answeredButUnresolved ? { ...none, incompleteResponders: 1 } : none;
  }
  // "The host says there is nothing here." Only the curator can say it: a
  // response is content-free either by being wire-empty or by carrying nothing
  // but `_meta`, and only the metadata-resolved curator's silence about data
  // means the graph has none. Any other peer's identical answer just means that
  // peer does not have it.
  const carriedNoData = (plane.insertedDataTriples ?? 0) === 0
    && (plane.fetchedDataTriples ?? 0) === 0;
  // Whose emptiness counts, and on which plane.
  //
  // DURABLE: the Context Graph is the curator's. `<cg>/_meta` carries its own
  // definition triples, so a curator serving them proves it hosts the graph, and
  // a curator with no data means the graph has none. Both wire-empty and
  // metadata-only rounds are hosted-empty evidence there.
  //
  // SHARED MEMORY: nobody's emptiness counts, not even the curator's. SWM is a
  // per-agent-address layered union (`<swm>/<addr>/<number>`) contributed by many
  // members, so a curator holding no SWM rows says nothing about the members'
  // layers — it does not own them. Letting it settle the plane skipped peers that
  // held valid rows and could report `sharedMemoryVerified` with
  // `sharedMemorySynced: 0`. An empty SWM plane is still provable, but only as a
  // WHOLE-ROUND verdict once every peer has answered, which is what
  // `catchupPlaneProvenByUnanimousEmpty` is for.
  //
  // Verified DATA from the curator still settles either plane. That is the
  // tradeoff this PR states openly — a peer's `complete` flag proves only its own
  // manifest, and the background reconciler remains the convergence mechanism —
  // and it is what keeps the amplification fixed for an SWM-heavy graph, which
  // issue #2006 measured at 122,705 fetched triples on the shared plane alone.
  const answered = options.plane !== 'shared-memory'
    && ((plane.emptyResponses ?? 0) > 0
      || (plane.metaOnlyResponses ?? 0) > 0
      || (plane.insertedMetaTriples ?? 0) > 0);
  return {
    verifiedDataPeers: (plane.insertedDataTriples ?? 0) > 0 ? 1 : 0,
    verifiedPrivateOnlyPeers: (plane.verifiedPrivateOnlyResponses ?? 0) > 0 ? 1 : 0,
    emptyPeers: (plane.emptyResponses ?? 0) > 0 ? 1 : 0,
    authorityEmptyPeers: options.fromAuthority && carriedNoData && answered ? 1 : 0,
  };
}

/** Fold one peer's evidence into the running per-plane totals. */
export function addCatchupPlaneEvidence(
  total: CatchupPlaneCompletionEvidence,
  peer: CatchupPlaneCompletionEvidence,
): void {
  total.verifiedDataPeers += peer.verifiedDataPeers;
  if (peer.verifiedPrivateOnlyPeers) {
    total.verifiedPrivateOnlyPeers = (total.verifiedPrivateOnlyPeers ?? 0)
      + peer.verifiedPrivateOnlyPeers;
  }
  if (peer.selectedScopeCompletePeers) {
    total.selectedScopeCompletePeers = (total.selectedScopeCompletePeers ?? 0)
      + peer.selectedScopeCompletePeers;
  }
  total.emptyPeers += peer.emptyPeers;
  if (peer.authorityEmptyPeers) {
    total.authorityEmptyPeers = (total.authorityEmptyPeers ?? 0) + peer.authorityEmptyPeers;
  }
  if (peer.incompleteResponders) {
    total.incompleteResponders = (total.incompleteResponders ?? 0) + peer.incompleteResponders;
  }
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
 * Positive RFC-64 proof: an explicitly selected graph-complete SWM provider
 * reached the terminal boundary of the accepted public scope.
 *
 * This stays separate from `verifiedDataPeers`: a repeat run may prove the
 * exact same already-materialized scope while inserting zero new triples, and
 * calling that "verified data received" would corrupt the transfer telemetry.
 */
export function catchupPlaneProvenBySelectedScope(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.selectedScopeCompletePeers ?? 0) > 0;
}

/**
 * Does any signal in this round rule out an empty verdict outright?
 *
 * Shared by BOTH empty-proof modes below, because these are not "a peer that
 * failed" — they are evidence about the graph's contents that no peer's silence
 * can outrank.
 */
function emptyVerdictContradicted(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
): boolean {
  // Verified content, obviously.
  if (catchupPlaneProvenByData(completion)) return true;
  // Data that arrived and was rejected. A peer SERVED CONTENT for this graph
  // which then failed verification, so content exists even though we could not
  // keep it. `classifyDurableProgress` already treats these as blocking
  // failures per peer; this is the same rule applied to the round.
  if ((diagnostics?.dataRejectedMissingMeta ?? 0) > 0
    || (diagnostics?.rejectedKcs ?? 0) > 0) return true;
  // Data fetched anywhere in the round, whoever fetched it.
  return (diagnostics?.fetchedDataTriples ?? 0) > 0;
}

/**
 * Proof mode 1 — the CURATOR hosts the graph and it holds nothing.
 *
 * A registered public graph that really is empty still carries definition
 * triples in its own `<cg>/_meta`, so the peer hosting it answers
 * metadata-only, never wire-empty, and could never satisfy the whole-round rule
 * below. Its curator saying so is the only evidence such a graph can produce.
 *
 * Scoped to the metadata-resolved curator and nothing else. Any OTHER peer's
 * metadata-only round is the commonest state on the network — a member that has
 * `_meta` but has not synced the data yet — and accepting it would resettle
 * issue #2006's exact failure as `done` with zero Knowledge Assets.
 *
 * Another peer merely failing part-way cannot contradict the curator; another
 * peer producing CONTENT can, and that is what {@link emptyVerdictContradicted}
 * checks — it means the curator's view is behind the network's.
 */
export function catchupPlaneProvenByAuthorityHostedEmpty(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  // Private planes stay proof-by-content only: an authorized-but-filtered
  // response is indistinguishable from an empty one on this side of the wire.
  if (options.isPrivate) return false;
  if ((completion?.authorityEmptyPeers ?? 0) === 0) return false;
  return !emptyVerdictContradicted(completion, diagnostics);
}

/**
 * Proof mode 2 — a whole round in which nobody had anything.
 *
 * A peer that has never heard of a Context Graph and a peer that hosts an empty
 * one are byte-identical on the wire: an unknown CG has no access policy, so the
 * responder authorizes the request and its CG-scoped queries simply return zero
 * rows. The requester only reports `emptyResponses` when BOTH phase payloads are
 * empty (`sync-verify-worker-impl.ts`), so an empty response can never carry
 * hosting evidence — there is no per-peer signal that could distinguish the two.
 *
 * Emptiness is therefore a verdict over the whole round: some peer completed
 * cleanly empty, nobody delivered any graph CONTENT, and no peer engaged and
 * then failed part-way. That exact shape — 122,705 data triples fetched and
 * five failed phases, with five unrelated peers answering empty — is what
 * settled issue #2006's run as `done` with 1 KA out of 40, and either clause
 * kills it on its own.
 *
 * `metaOnlyResponses` also kills it. A non-curator that returned `_meta` and no
 * data is the ambiguous case this rule cannot resolve — the requester itself
 * logs "peer may have empty or pruned data graph" — and without the curator
 * present there is nothing to resolve it against. When the curator IS present,
 * proof mode 1 has already settled the plane, so voiding here costs the
 * legitimately-empty graph nothing.
 *
 * The verdict IS voided when the round had a resolvable curator that never
 * cleanly answered (`authorityUnanswered`). The peer best placed to know is the
 * one we failed to hear from, so "nobody had anything" is not established — the
 * round is incomplete, not empty. That closes issue #2006's own symptom in its
 * sharpest form: the walk puts a resolvable curator alone in wave 1, so when the
 * curator transport-fails the walk moves on to strangers, one answers empty, and
 * 40 Knowledge Assets get reported as zero.
 *
 * Scoped to the AUTHORITY rather than to `failedPeers`, and the difference is
 * load-bearing. `failedPeers` counts any unreachable peer, so voiding on it would
 * also kill the verdict when NO curator is resolvable at all — the state where
 * the hosted-empty backstop structurally cannot fire — leaving a legitimately
 * empty public graph pinned at `unreachable` by a single unreachable stranger.
 * That is the liveness failure this rule was originally written to avoid, and it
 * is still worth avoiding; it is only the curator's silence that is decisive.
 *
 * Two counters are deliberately NOT consulted:
 *
 * - `failedPeers`. A transport failure to a peer we never heard from, which on a
 *   live testnet can be most of the connected set. An unreachable STRANGER is
 *   evidence of nothing; an unreachable CURATOR is, and has its own signal above.
 * - `fetchedMetaTriples`. A raw triple count, not a per-peer verdict: a delta
 *   sync legitimately carries the whole metadata phase with nothing newer than
 *   the watermark, and the requester deliberately does NOT flag that as
 *   metadata-only. Voiding on the raw count would make a legitimately empty
 *   public graph permanently unreadable rather than merely unproven.
 * - `failedPeers`. That is a transport failure to a peer we never heard from —
 *   on a live testnet a majority of connected peers can be unreachable — and an
 *   unreachable stranger is evidence of nothing. A peer that DID engage and
 *   then failed shows up in `failedPhases` / `timedOutPhases` / `deniedPhases`
 *   / `deferredBackpressure`, all of which do void the verdict.
 *
 * Residual, unchanged from before this rule existed: if the only host is
 * unreachable while another peer answers cleanly empty, the round still reads
 * as empty. Readiness is re-derived on the next catch-up.
 */
export function catchupPlaneProvenByUnanimousEmpty(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  // Empty or metadata-only responses have never been able to prove that a
  // private graph is fully synchronized; that stays unchanged.
  if (options.isPrivate) return false;
  if (emptyVerdictContradicted(completion, diagnostics)) return false;
  // A non-curator that has `_meta` and no data cannot tell "the graph is empty"
  // from "I have not synced it yet". See the note above.
  if ((diagnostics?.metaOnlyResponses ?? 0) > 0) return false;
  // A peer that answered but did not finish paging leaves the round unresolved:
  // "nobody had anything" cannot be concluded while somebody's answer is still
  // half-delivered. This is not covered by the phase counters below — an
  // explicit `complete: false` is neither a failure nor a timeout — and it is
  // the one shape that survives `catchupPeerPlaneEvidence` erasing the peer to
  // an all-zero record.
  if ((completion?.incompleteResponders ?? 0) > 0) return false;
  // Completion evidence is PER-PEER and says explicitly whether that peer's
  // round was clean; `diagnostics.emptyResponses` is a raw aggregate that counts
  // an empty payload even when the peer's round was NOT complete. Where the
  // runner supplied completion evidence it is the whole truth for this plane, so
  // the aggregate must not re-admit a response the per-peer view already
  // excluded — otherwise an explicitly incomplete empty result proves the plane
  // ready. The aggregate is a fallback for legacy callers that carry no
  // completion evidence at all, never a second chance for callers that do.
  const cleanEmptyObserved = completion !== undefined
    ? (completion.emptyPeers ?? 0) > 0
    : (diagnostics?.emptyResponses ?? 0) > 0;
  if (!cleanEmptyObserved) return false;
  // The one peer whose silence is decisive. See the note above for why this is
  // scoped to the curator rather than to `failedPeers`.
  if (diagnostics?.authorityUnanswered) return false;
  return (diagnostics?.failedPhases ?? 0) === 0
    && (diagnostics?.timedOutPhases ?? 0) === 0
    && (diagnostics?.deniedPhases ?? 0) === 0
    && (diagnostics?.deferredBackpressure ?? 0) === 0;
}

/**
 * Canonical readiness proof for one catch-up plane: verified content, the
 * curator's hosted-empty word, or a whole round in which nobody had anything —
 * in that order of strength.
 *
 * The peer walk stops early only on {@link catchupPlaneProvenByData} or the
 * curator's own round, so whenever this falls through to the unanimous-empty
 * branch the full peer set really was walked and the "nobody saw anything"
 * denominator is meaningful.
 */
export function catchupPlaneReady(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  return catchupPlaneProvenByData(completion)
    || catchupPlaneProvenBySelectedScope(completion)
    || catchupPlaneProvenByAuthorityHostedEmpty(completion, diagnostics, options)
    || catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
}

export function catchupPeerSucceeded(
  durable: CatchupPhaseProgress | null | undefined,
  shared: CatchupPhaseProgress | null | undefined,
  peerDenied: boolean,
  durableComplete?: boolean,
  sharedCompletion?: {
    progress: DurableProgressClassification;
    /** This lane requires an explicit terminal boundary, not just clean I/O. */
    terminalBoundaryRequired: boolean;
  },
): boolean {
  const durableProgress = classifyDurableProgress(durable, { complete: durableComplete });
  const sharedProgress = shared
    ? sharedCompletion?.progress ?? classifyDurableProgress(shared)
    : null;
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
  if (sharedCompletion?.terminalBoundaryRequired
    && !sharedCompletion.progress.completedWithoutFailure) return false;
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
  /** Set once the worker dies; every later run fails fast instead of hanging. */
  private workerFailure: Error | undefined;

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
      this.fail(error);
    });
    // `close()` terminates the worker, which emits 'exit' — never 'error'. A
    // crashed or terminated worker is also permanent: the runner is constructed
    // once per daemon and `postMessage` to a dead worker neither throws nor
    // delivers. Without this, an in-flight run stayed pending forever AND every
    // later run did too, so the daemon's fire-and-forget subscribe jobs were
    // pinned at `running` with no `finishedAt` for the rest of the process's
    // life — and the route's dedupe then hands that stuck job back on every
    // re-subscribe, so an operator cannot even retrigger.
    this.worker.on('exit', (code) => {
      this.fail(new Error(`Catch-up worker exited (code ${code}) before the run completed`));
    });
  }

  /** Latch the terminal failure and settle everything waiting on the worker. */
  private fail(error: Error): void {
    this.workerFailure ??= error;
    const pending = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    for (const run of pending) run.reject(error);
  }

  run(request: CatchupRunRequest): Promise<CatchupJobResult> {
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    const runId = this.nextRunId++;
    return new Promise<CatchupJobResult>((resolve, reject) => {
      this.pendingRuns.set(runId, { resolve, reject });
      this.worker.postMessage({
        type: 'run',
        runId,
        request: {
          ...request,
          graphOwnedDurableRecovery:
            typeof this.agent.syncDurableRecoveryContextGraph === 'function',
        },
      });
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
        const [contextGraphId, includeSharedMemory = true] = args as [string, boolean?];
        const isPrivateContextGraph = await agent.isPrivateContextGraph(contextGraphId);
        // ONE resolution, two notions. Ranking uses whatever peer is available;
        // letting one peer's answer stand for the whole graph requires the
        // stricter notion, because a join-approval bootstrap hint is
        // authenticated but can be stale — it orders the walk without being
        // allowed to end it. Resolving twice would read `_meta` twice (and run
        // the registry fallback twice for a wallet-address curator) per
        // catch-up, and the resolver evicts the bootstrap hint once metadata
        // confirms a curator, so the second call is not the same call.
        const resolution: SyncPeerResolution =
          typeof agent.resolveSyncPeerWithProvenance === 'function'
            ? await agent.resolveSyncPeerWithProvenance(contextGraphId)
            : {
              peerId: await agent.resolvePreferredSyncPeerId(contextGraphId),
              // An agent without the provenance resolver cannot establish
              // authority, and must not be assumed to have it.
              provenance: 'bootstrap-hint',
            };
        const preferredPeerId = resolution.peerId;
        // The agent's own definition of "may end the walk", not a restatement
        // of it: a renamed or added provenance value has to break here rather
        // than silently downgrade every curator to non-authoritative.
        const authoritativePeerId = authoritativeSyncPeerId(resolution);
        const authoritativeSharedMemoryPeerIds: readonly string[] =
          includeSharedMemory
          && typeof agent.resolveRfc64CompleteSwmProviderPeerIdsV1 === 'function'
            ? agent.resolveRfc64CompleteSwmProviderPeerIdsV1(contextGraphId)
            : [];
        // Connection attempts only expand the candidate set. A stale curator
        // address (for example, a relayed peer returning NO_RESERVATION) must
        // not abort a public multi-peer repair before already-connected peers
        // can contribute their RFC-64 snapshot union. Private graphs remain
        // fail-closed in selectCatchupPeers; with no eligible curator they
        // simply produce an unreachable bounded job.
        await Promise.allSettled([
          ...(preferredPeerId === undefined
            ? []
            : [agent.ensurePeerConnected(preferredPeerId)]),
          ...authoritativeSharedMemoryPeerIds.map(
            (peerId) => agent.ensurePeerConnected(peerId),
          ),
        ]);
        await agent.primeCatchupConnections();

        const selectedPeerIds = agent.selectCatchupPeers(
          [...new Map(
            agent.node.libp2p.getConnections().map((connection: any) => [connection.remotePeer.toString(), connection.remotePeer]),
          ).values()],
          preferredPeerId,
          isPrivateContextGraph,
        ).map((peer: { toString(): string }) => peer.toString());
        const prioritizedPeerIds = [...new Set([
          ...authoritativeSharedMemoryPeerIds,
          ...(preferredPeerId === undefined ? [] : [preferredPeerId]),
        ])];
        const selectedPeerIdSet = new Set(selectedPeerIds);
        const prioritizedPeerIdSet = new Set(prioritizedPeerIds);
        const peerIds = [
          ...prioritizedPeerIds.filter((peerId) => selectedPeerIdSet.has(peerId)),
          ...selectedPeerIds.filter((peerId: string) => !prioritizedPeerIdSet.has(peerId)),
        ];

        return {
          preferredPeerId,
          authoritativePeerId,
          authoritativeSharedMemoryPeerIds,
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
          string, string, number | undefined, unknown,
        ];
        return agent.syncFromPeerDetailed(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          undefined,
          {
            ...(priority === undefined ? {} : { priority }),
            // This RPC argument crossed a structured-clone boundary, so its
            // compile-time type guaranteed nothing. Clamp it to the closed
            // diagnostic set HERE, at the untrusted edge, so every in-process
            // caller past it is typed `SyncAdmissionSource`.
            source: normalizeSyncAdmissionSource(
              typeof source === 'string' ? source : undefined,
            ),
          },
        );
      }
      case 'syncDurableRecovery': {
        const [peerId, contextGraphId] = args as [string, string];
        const recovery = await this.agent.syncDurableRecoveryContextGraph(contextGraphId, {
          candidatePeerIds: [peerId],
          candidatesAreSyncCapable: true,
        });
        return recovery.result;
      }
      case 'syncSharedMemory': {
        const [peerId, contextGraphId, priority, source, selected] = args as [
          string, string, number | undefined, unknown, unknown,
        ];
        const admission = {
          ...(priority === undefined ? {} : { priority }),
          source: normalizeSyncAdmissionSource(
            typeof source === 'string' ? source : undefined,
          ),
        };
        // One bridge operation owns producer selection. The Worker supplies a
        // closed boolean, and only literal `true` may enter the selected lane;
        // malformed structured-clone values retain ordinary behavior.
        if (selected === true) {
          return agent.syncSelectedSharedMemoryFromPeerDetailed(
            peerId,
            [contextGraphId],
            { ...admission, selectedSwmPriority: true },
          );
        }
        return agent.syncSharedMemoryFromPeerDetailed(
          peerId,
          [contextGraphId],
          admission,
        );
      }
      case 'logCatchupPass': {
        // The pass loop runs inside the Worker, which has no logger of its own,
        // so the line is FORMATTED there — where the coverage records live — and
        // only emitted here. Deliberately `info`: an operator diagnosing a job
        // that will not converge needs this without raising the log level, and a
        // catch-up emits at most a handful of these.
        const [message] = args as [string];
        agent.log.info(createOperationContext('sync'), message);
        return null;
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
