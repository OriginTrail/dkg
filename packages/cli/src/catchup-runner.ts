import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDurableProgress,
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

/**
 * Adapt the agent's typed durable result for operator-facing catch-up APIs.
 * Whole-leg completion comes only from the explicit agent contract; phase
 * counters remain diagnostics and can describe safely committed prefixes.
 */
export function summarizeDurableLeg(result: DurableSyncResult): DurableLegSummary {
  const count = (value: number | undefined): number => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
    return value;
  };
  const diagnostics: DurableLegDiagnostics = {
    fetchedMetaTriples: count(result.fetchedMetaTriples),
    fetchedDataTriples: count(result.fetchedDataTriples),
    insertedMetaTriples: count(result.insertedMetaTriples),
    insertedDataTriples: count(result.insertedDataTriples),
    bytesReceived: count(result.bytesReceived),
    resumedPhases: count(result.resumedPhases),
    timedOutPhases: count(result.timedOutPhases),
    completedPhases: count(result.completedPhases),
    checkpointAdvances: count(result.checkpointAdvances),
    deniedPhases: count(result.deniedPhases),
    emptyResponses: count(result.emptyResponses),
    metaOnlyResponses: count(result.metaOnlyResponses),
    verifiedPrivateOnlyResponses: count(result.verifiedPrivateOnlyResponses),
    dataRejectedMissingMeta: count(result.dataRejectedMissingMeta),
    rejectedKcs: count(result.rejectedKcs),
    failedPeers: count(result.failedPeers),
    failedPhases: count(result.failedPhases),
    backoffWorthyFailures: count(result.backoffWorthyFailures),
    deferredBackpressure: count(result.deferredBackpressure),
  };
  const hardFailureDetails = [
    ['failedPeers', diagnostics.failedPeers],
    ['failedPhases', diagnostics.failedPhases],
    ['deniedPhases', diagnostics.deniedPhases],
    ['rejectedKcs', diagnostics.rejectedKcs],
    ['dataRejectedMissingMeta', diagnostics.dataRejectedMissingMeta],
  ].flatMap(([name, value]) => Number(value) > 0 ? [`${name}=${value}`] : []);
  return {
    insertedTriples: count(result.insertedTriples),
    diagnostics,
    complete: result.complete,
    hardFailureDetails,
  };
}

export function catchupPlaneCompletedWithoutFailure(
  progress: CatchupPhaseProgress | null | undefined,
): boolean {
  return classifyDurableProgress(progress).completedWithoutFailure;
}

export function catchupPeerSucceeded(
  durable: CatchupPhaseProgress,
  shared: CatchupPhaseProgress | null | undefined,
  peerDenied: boolean,
): boolean {
  const durableProgress = classifyDurableProgress(durable);
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
