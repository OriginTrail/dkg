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
  hardFailureDetails: string[];
}

/** The only agent capabilities required by the route-level durable leg. */
export interface DurableCatchupAgent {
  syncFromPeerDetailed?: OmitThisParameter<DKGAgent['syncFromPeerDetailed']>;
  syncFromPeer?: OmitThisParameter<DKGAgent['syncFromPeer']>;
}

export interface DurableCatchupLegResult {
  insertedTriples: number;
  complete?: boolean;
  diagnostics?: DurableLegDiagnostics;
  error?: string;
}

export interface DurableCatchupAttempt {
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

/**
 * Adapt the agent's typed durable result for operator-facing catch-up APIs.
 * Whole-leg completion comes only from the explicit agent contract; phase
 * counters remain diagnostics and can describe safely committed prefixes.
 */
export function summarizeDurableLeg(result: DurableSyncResult): DurableLegSummary {
  const {
    insertedTriples,
    complete,
    ...diagnostics
  } = normalizeDurableSyncResult(result);
  const hardFailureDetails = [
    ['failedPeers', diagnostics.failedPeers],
    ['failedPhases', diagnostics.failedPhases],
    ['deniedPhases', diagnostics.deniedPhases],
    ['rejectedKcs', diagnostics.rejectedKcs],
    ['dataRejectedMissingMeta', diagnostics.dataRejectedMissingMeta],
  ].flatMap(([name, value]) => Number(value) > 0 ? [`${name}=${value}`] : []);
  const committedProgress = insertedTriples > 0
    || diagnostics.insertedDataTriples > 0
    || diagnostics.insertedMetaTriples > 0
    || diagnostics.checkpointAdvances > 0;
  if (!complete && !committedProgress && hardFailureDetails.length === 0) {
    // A timeout/backpressure stop before the first durable boundary is not a
    // successful no-op. Give the HTTP adapter a typed failure reason so
    // durable-only automation keeps retrying instead of treating 200/ok as an
    // already-synchronized graph. Safely committed prefixes remain observable
    // as retryable progress and intentionally do not enter this branch.
    hardFailureDetails.push('incompleteWithoutProgress=1');
  }
  return {
    insertedTriples,
    diagnostics,
    complete,
    hardFailureDetails,
  };
}

/**
 * Execute one durable route leg behind a typed capability boundary. Detailed
 * agents expose completion/diagnostics; older agents retain the legacy count.
 */
export async function runDurableCatchupLeg(
  agent: DurableCatchupAgent,
  peerId: string,
  contextGraphId: string,
  totalTimeoutMs: number,
): Promise<DurableCatchupLegResult> {
  try {
    if (typeof agent.syncFromPeerDetailed === 'function') {
      const detailed = await agent.syncFromPeerDetailed(
        peerId,
        [contextGraphId],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs },
      );
      const summary = summarizeDurableLeg(detailed);
      return {
        insertedTriples: summary.insertedTriples,
        complete: summary.complete,
        diagnostics: summary.diagnostics,
        ...(summary.hardFailureDetails.length > 0 ? {
          error: `Durable sync did not complete (${summary.hardFailureDetails.join(', ')})`,
        } : {}),
      };
    }

    return {
      insertedTriples: typeof agent.syncFromPeer === 'function'
        ? await agent.syncFromPeer(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          { totalTimeoutMs },
        )
        : 0,
    };
  } catch (error) {
    return {
      insertedTriples: 0,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
    && attempts.every((attempt) => Boolean(attempt.durableError || attempt.error));
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

export function catchupPeerSucceeded(
  durable: CatchupPhaseProgress,
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
  durable: CatchupPhaseProgress,
  shared: CatchupPhaseProgress | null | undefined,
): boolean {
  const phaseResponded = (phase: CatchupPhaseProgress): boolean => {
    const progress = classifyDurableProgress(phase);
    if (progress.transportFailed) return false;
    if (!progress.deferredByBackpressure) return true;
    return (phase.bytesReceived ?? 0) > 0
      || (phase.completedPhases ?? 0) > 0
      || (phase.emptyResponses ?? 0) > 0
      || (phase.insertedMetaTriples ?? 0) > 0
      || (phase.insertedDataTriples ?? phase.insertedTriples ?? 0) > 0;
  };
  return phaseResponded(durable) || Boolean(shared && phaseResponded(shared));
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
      for (const [, pending] of this.pendingRuns) pending.reject(error);
      this.pendingRuns.clear();
    });
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
        const [peerId, contextGraphId] = args as [string, string];
        return agent.syncFromPeerDetailed(peerId, [contextGraphId]);
      }
      case 'syncSharedMemory': {
        const [peerId, contextGraphId] = args as [string, string];
        return agent.syncSharedMemoryFromPeerDetailed(peerId, [contextGraphId]);
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
    }) as Promise<CatchupJobResult>;
  }

  async close(): Promise<void> {
    // No resources to close.
  }
}
