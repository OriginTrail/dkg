import { parentPort } from 'node:worker_threads';
import type { CatchupJobResult, CatchupRunRequest } from './catchup-runner.js';

type InvokeResultMessage = {
  type: 'invoke-result';
  invokeId: number;
  result?: unknown;
  error?: string;
};

let nextInvokeId = 0;
const pendingInvokes = new Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>();

parentPort!.on('message', async (message: any) => {
  if (message.type === 'run') {
    try {
      const result = await runCatchup(message.request as CatchupRunRequest);
      parentPort!.postMessage({ type: 'run-result', runId: message.runId, result });
    } catch (error) {
      parentPort!.postMessage({
        type: 'run-result',
        runId: message.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (message.type === 'invoke-result') {
    const pending = pendingInvokes.get(message.invokeId);
    if (!pending) return;
    pendingInvokes.delete(message.invokeId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }
});

async function runCatchup(request: CatchupRunRequest): Promise<CatchupJobResult> {
  const prepared = await invoke<{
    preferredPeerId?: string;
    isPrivateContextGraph: boolean;
    peerIds: string[];
    connectedPeers: number;
  }>('prepareCatchup', request.contextGraphId);

  let syncCapablePeers = 0;
  let peersTried = 0;
  let dataSynced = 0;
  let sharedMemorySynced = 0;
  let noProtocolPeers = 0;

  const diagnostics: NonNullable<CatchupJobResult['diagnostics']> = {
    noProtocolPeers: 0,
    durable: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
    },
    sharedMemory: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
    },
  };

  for (const peerId of prepared.peerIds) {
    const hasSync = await invoke<boolean>('waitForSyncProtocol', peerId);
    if (!hasSync) {
      noProtocolPeers += 1;
      continue;
    }

    syncCapablePeers += 1;
    peersTried += 1;

    const durable = await invoke<any>('syncDurable', peerId, request.contextGraphId);
    dataSynced += durable.insertedTriples;
    diagnostics.durable.fetchedMetaTriples += durable.fetchedMetaTriples;
    diagnostics.durable.fetchedDataTriples += durable.fetchedDataTriples;
    diagnostics.durable.insertedMetaTriples += durable.insertedMetaTriples;
    diagnostics.durable.insertedDataTriples += durable.insertedDataTriples;
    diagnostics.durable.emptyResponses += durable.emptyResponses;
    diagnostics.durable.metaOnlyResponses += durable.metaOnlyResponses;
    diagnostics.durable.dataRejectedMissingMeta += durable.dataRejectedMissingMeta;
    diagnostics.durable.rejectedKcs += durable.rejectedKcs;
    diagnostics.durable.failedPeers += durable.failedPeers;

    if (request.includeSharedMemory) {
      const shared = await invoke<any>('syncSharedMemory', peerId, request.contextGraphId);
      sharedMemorySynced += shared.insertedTriples;
      diagnostics.sharedMemory.fetchedMetaTriples += shared.fetchedMetaTriples;
      diagnostics.sharedMemory.fetchedDataTriples += shared.fetchedDataTriples;
      diagnostics.sharedMemory.insertedMetaTriples += shared.insertedMetaTriples;
      diagnostics.sharedMemory.insertedDataTriples += shared.insertedDataTriples;
      diagnostics.sharedMemory.emptyResponses += shared.emptyResponses;
      diagnostics.sharedMemory.droppedDataTriples += shared.droppedDataTriples;
      diagnostics.sharedMemory.failedPeers += shared.failedPeers;
    }
  }

  diagnostics.noProtocolPeers = noProtocolPeers;
  await invoke('finalizeCatchup', request.contextGraphId, dataSynced, sharedMemorySynced);

  return {
    connectedPeers: prepared.connectedPeers,
    syncCapablePeers,
    peersTried,
    dataSynced,
    sharedMemorySynced,
    diagnostics,
  };
}

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const invokeId = nextInvokeId++;
  return new Promise<T>((resolve, reject) => {
    pendingInvokes.set(invokeId, { resolve, reject });
    parentPort!.postMessage({ type: 'invoke', invokeId, method, args });
  });
}
