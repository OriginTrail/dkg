import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';

const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;

export interface CatchupJobResult {
  connectedPeers: number;
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
   * transport failure, without an explicit ACL denial, and with either real
   * progress or a clean non-metadata-only empty completion.
   */
  peersSucceeded: number;
  dataSynced: number;
  sharedMemorySynced: number;
  denied: boolean;
  deniedPeers: number;
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
      dataRejectedMissingMeta: number;
      rejectedKcs: number;
      failedPeers: number;
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
    };
  };
}

export interface CatchupRunRequest {
  contextGraphId: string;
  includeSharedMemory: boolean;
}

export interface CatchupPhaseProgress {
  timedOutPhases?: number;
  resumedPhases?: number;
  completedPhases?: number;
  checkpointAdvances?: number;
  failedPeers?: number;
  insertedTriples?: number;
  insertedDataTriples?: number;
  insertedMetaTriples?: number;
  metaOnlyResponses?: number;
}

export function catchupPeerSucceeded(
  durable: CatchupPhaseProgress,
  shared: CatchupPhaseProgress | null | undefined,
  peerDenied: boolean,
): boolean {
  if (!catchupPeerResponded(durable, shared) || peerDenied) return false;
  const durableProgress = (durable.insertedDataTriples ?? durable.insertedTriples ?? 0) > 0
    || (durable.checkpointAdvances ?? 0) > 0
    || ((durable.completedPhases ?? 0) > 0 && (durable.resumedPhases ?? 0) > 0);
  const sharedProgress = shared
    ? (shared.insertedDataTriples ?? shared.insertedTriples ?? 0) > 0
      || (shared.checkpointAdvances ?? 0) > 0
      || ((shared.completedPhases ?? 0) > 0 && (shared.resumedPhases ?? 0) > 0)
    : false;
  const peerMadeProgress = durableProgress || sharedProgress;
  const peerMetadataOnly = !peerMadeProgress && (
    (durable.insertedMetaTriples ?? 0) > 0
    || (durable.metaOnlyResponses ?? 0) > 0
    || (shared ? (shared.insertedMetaTriples ?? 0) > 0 : false)
  );
  const peerTimedOut = (durable.timedOutPhases ?? 0) > 0 || (shared ? (shared.timedOutPhases ?? 0) > 0 : false);
  return peerMadeProgress || (!peerTimedOut && !peerMetadataOnly);
}

export function catchupPeerResponded(
  durable: CatchupPhaseProgress,
  shared: CatchupPhaseProgress | null | undefined,
): boolean {
  const durableFailed = (durable.failedPeers ?? 0) > 0;
  const sharedFailed = shared ? (shared.failedPeers ?? 0) > 0 : false;
  return !durableFailed && !sharedFailed;
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
        const [contextGraphId, dataSynced, sharedMemorySynced] = args as [string, number, number];
        await agent.refreshMetaSyncedFlags([contextGraphId]);
        if (dataSynced > 0 || sharedMemorySynced > 0) {
          agent.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
            contextGraphId,
            dataSynced,
            sharedMemorySynced,
          });
        }
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
