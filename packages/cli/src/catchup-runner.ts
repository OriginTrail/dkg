import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent } from '@origintrail-official/dkg-core';

export interface CatchupJobResult {
  connectedPeers: number;
  syncCapablePeers: number;
  peersTried: number;
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
