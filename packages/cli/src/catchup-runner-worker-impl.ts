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
  let deniedPeers = 0;
  let noProtocolPeers = 0;

  const diagnostics: NonNullable<CatchupJobResult['diagnostics']> = {
    noProtocolPeers: 0,
    durable: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
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
      bytesReceived: 0,
      resumedPhases: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
    },
  };

  // Run per-peer syncs in parallel. The sequential version here used to
  // walk the peer set one at a time, which meant a curated-CG denial
  // from a 10-peer pool took 10 × (syncDurable timeout + syncSharedMemory
  // timeout) to report back — often minutes. The agent-side
  // `syncContextGraphFromConnectedPeers` (InlineCatchupRunner) already
  // uses `Promise.all`, but the daemon subscribe path goes through this
  // Worker implementation, so Codex N18 pointed out the parallel fix
  // never reached `/api/context-graph/subscribe`. Mirror the inline path
  // here so both runners have the same latency characteristics.
  const checked = await Promise.all(
    prepared.peerIds.map(async (peerId) => ({
      peerId,
      hasSync: await invoke<boolean>('waitForSyncProtocol', peerId),
    })),
  );
  const syncCapable: string[] = [];
  for (const { peerId, hasSync } of checked) {
    if (!hasSync) {
      noProtocolPeers += 1;
      continue;
    }
    syncCapable.push(peerId);
  }
  syncCapablePeers = syncCapable.length;
  peersTried = syncCapable.length;

  // Isolate per-peer failures: if one peer's sync steps throw, aggregate what we can
  // from the other peers instead of failing the entire subscribe/catch-up immediately.
  const emptyDurable = () => ({
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 1,
    deniedPhases: 0,
  });
  const emptyShared = () => ({
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 1,
    deniedPhases: 0,
  });
  const perPeerResults = await Promise.all(
    syncCapable.map(async (peerId) => {
      const durable = await invoke<any>('syncDurable', peerId, request.contextGraphId).catch(() => emptyDurable());
      const shared = request.includeSharedMemory
        ? await invoke<any>('syncSharedMemory', peerId, request.contextGraphId).catch(() => emptyShared())
        : null;
      return { durable, shared };
    }),
  );
  for (const { durable, shared } of perPeerResults) {
    let peerDenied = false;
    dataSynced += durable.insertedTriples;
    diagnostics.durable.fetchedMetaTriples += durable.fetchedMetaTriples;
    diagnostics.durable.fetchedDataTriples += durable.fetchedDataTriples;
    diagnostics.durable.insertedMetaTriples += durable.insertedMetaTriples;
    diagnostics.durable.insertedDataTriples += durable.insertedDataTriples;
    diagnostics.durable.bytesReceived += durable.bytesReceived;
    diagnostics.durable.resumedPhases += durable.resumedPhases;
    diagnostics.durable.emptyResponses += durable.emptyResponses;
    diagnostics.durable.metaOnlyResponses += durable.metaOnlyResponses;
    diagnostics.durable.dataRejectedMissingMeta += durable.dataRejectedMissingMeta;
    diagnostics.durable.rejectedKcs += durable.rejectedKcs;
    diagnostics.durable.failedPeers += durable.failedPeers;
    peerDenied = peerDenied || durable.deniedPhases > 0;

    if (shared) {
      sharedMemorySynced += shared.insertedTriples;
      diagnostics.sharedMemory.fetchedMetaTriples += shared.fetchedMetaTriples;
      diagnostics.sharedMemory.fetchedDataTriples += shared.fetchedDataTriples;
      diagnostics.sharedMemory.insertedMetaTriples += shared.insertedMetaTriples;
      diagnostics.sharedMemory.insertedDataTriples += shared.insertedDataTriples;
      diagnostics.sharedMemory.bytesReceived += shared.bytesReceived;
      diagnostics.sharedMemory.resumedPhases += shared.resumedPhases;
      diagnostics.sharedMemory.emptyResponses += shared.emptyResponses;
      diagnostics.sharedMemory.droppedDataTriples += shared.droppedDataTriples;
      diagnostics.sharedMemory.failedPeers += shared.failedPeers;
      peerDenied = peerDenied || shared.deniedPhases > 0;
    }

    if (peerDenied) {
      deniedPeers += 1;
    }
  }

  diagnostics.noProtocolPeers = noProtocolPeers;
  await invoke('finalizeCatchup', request.contextGraphId, dataSynced, sharedMemorySynced);

  const servedByPeer =
    dataSynced > 0 ||
    sharedMemorySynced > 0 ||
    diagnostics.durable.insertedMetaTriples > 0 ||
    diagnostics.sharedMemory.insertedMetaTriples > 0 ||
    diagnostics.durable.metaOnlyResponses > 0;

  return {
    connectedPeers: prepared.connectedPeers,
    syncCapablePeers,
    peersTried,
    dataSynced,
    sharedMemorySynced,
    denied: deniedPeers > 0 && !servedByPeer,
    deniedPeers,
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
