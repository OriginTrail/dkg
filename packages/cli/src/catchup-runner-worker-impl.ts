import { parentPort } from 'node:worker_threads';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS, mapWithConcurrency } from '@origintrail-official/dkg-agent';
import { catchupPeerResponded, catchupPeerSucceeded, type CatchupJobResult, type CatchupRunRequest } from './catchup-runner.js';

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
  let peersResponded = 0;
  let peersSucceeded = 0;
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
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
      failedPhases: 0,
    },
    sharedMemory: {
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
    },
  };

  // Run per-peer syncs in parallel, but BOUNDED. The sequential version here
  // used to walk the peer set one at a time, which meant a curated-CG denial
  // from a 10-peer pool took 10 × (syncDurable timeout + syncSharedMemory
  // timeout) to report back — often minutes. Codex N18 then parallelised this
  // Worker path (the daemon `/api/context-graph/subscribe` route) with an
  // unbounded `Promise.all` — which made it the 2026-07-07 mainnet sync-storm
  // engine: one subscribe on a high-degree node fired a full durable+SWM pull
  // at EVERY sync-capable peer at once, saturating the triple store. Mirror
  // the agent-side `syncContextGraphFromConnectedPeers` fix: run the fan-out
  // through `mapWithConcurrency` under the shared cap
  // (CATCHUP_MAX_CONCURRENT_PEER_SYNCS, env DKG_CATCHUP_MAX_CONCURRENT_PEERS)
  // so both runners have the same latency AND the same load ceiling. The
  // protocol probe below is lighter but fans out over the full post-prime-dial
  // peer list, so it gets the same bound.
  const checked = await mapWithConcurrency(
    prepared.peerIds,
    CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
    async (peerId) => ({
      peerId,
      hasSync: await invoke<boolean>('waitForSyncProtocol', peerId),
    }),
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
    timedOutPhases: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 1,
    failedPhases: 0,
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
    timedOutPhases: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 1,
    failedPhases: 0,
    deniedPhases: 0,
  });
  // Bounded fan-out (sync-storm mitigation C-1): at most
  // CATCHUP_MAX_CONCURRENT_PEER_SYNCS full per-peer sync rounds in flight.
  // Every sync-capable peer is still synced and the result array is unchanged
  // (input order, one entry per peer, per-peer failures isolated by the
  // `.catch`es inside the callback) — the load is just staggered into waves.
  const perPeerResults = await mapWithConcurrency(
    syncCapable,
    CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
    async (peerId) => {
      const durable = await invoke<any>('syncDurable', peerId, request.contextGraphId).catch(() => emptyDurable());
      const shared = request.includeSharedMemory
        ? await invoke<any>('syncSharedMemory', peerId, request.contextGraphId).catch(() => emptyShared())
        : null;
      return { durable, shared };
    },
  );
  for (const { durable, shared } of perPeerResults) {
    let peerDenied = false;
    dataSynced += durable.insertedDataTriples ?? 0;
    diagnostics.durable.fetchedMetaTriples += durable.fetchedMetaTriples;
    diagnostics.durable.fetchedDataTriples += durable.fetchedDataTriples;
    diagnostics.durable.insertedMetaTriples += durable.insertedMetaTriples;
    diagnostics.durable.insertedDataTriples += durable.insertedDataTriples;
    diagnostics.durable.bytesReceived += durable.bytesReceived;
    diagnostics.durable.resumedPhases += durable.resumedPhases;
    diagnostics.durable.timedOutPhases += durable.timedOutPhases ?? 0;
    diagnostics.durable.completedPhases += durable.completedPhases ?? 0;
    diagnostics.durable.checkpointAdvances += durable.checkpointAdvances ?? 0;
    diagnostics.durable.emptyResponses += durable.emptyResponses;
    diagnostics.durable.metaOnlyResponses += durable.metaOnlyResponses;
    diagnostics.durable.dataRejectedMissingMeta += durable.dataRejectedMissingMeta;
    diagnostics.durable.rejectedKcs += durable.rejectedKcs;
    diagnostics.durable.failedPeers += durable.failedPeers;
    diagnostics.durable.failedPhases += durable.failedPhases ?? 0;
    peerDenied = peerDenied || durable.deniedPhases > 0;

    if (shared) {
      sharedMemorySynced += shared.insertedDataTriples ?? 0;
      diagnostics.sharedMemory.fetchedMetaTriples += shared.fetchedMetaTriples;
      diagnostics.sharedMemory.fetchedDataTriples += shared.fetchedDataTriples;
      diagnostics.sharedMemory.insertedMetaTriples += shared.insertedMetaTriples;
      diagnostics.sharedMemory.insertedDataTriples += shared.insertedDataTriples;
      diagnostics.sharedMemory.bytesReceived += shared.bytesReceived;
      diagnostics.sharedMemory.resumedPhases += shared.resumedPhases;
      diagnostics.sharedMemory.timedOutPhases += shared.timedOutPhases ?? 0;
      diagnostics.sharedMemory.completedPhases += shared.completedPhases ?? 0;
      diagnostics.sharedMemory.checkpointAdvances += shared.checkpointAdvances ?? 0;
      diagnostics.sharedMemory.emptyResponses += shared.emptyResponses;
      diagnostics.sharedMemory.droppedDataTriples += shared.droppedDataTriples;
      diagnostics.sharedMemory.failedPeers += shared.failedPeers;
      diagnostics.sharedMemory.failedPhases += shared.failedPhases ?? 0;
      peerDenied = peerDenied || shared.deniedPhases > 0;
    }

    if (peerDenied) {
      deniedPeers += 1;
    }

    if (catchupPeerResponded(durable, shared)) {
      peersResponded += 1;
    }

    // Count peers that completed a sync round without a transport
    // failure/denial and either made phase/checkpoint progress, or cleanly
    // completed with no timeout. Mirrors the inline
    // `syncContextGraphFromConnectedPeers` path so both runners report the
    // same shape.
    if (catchupPeerSucceeded(durable, shared, peerDenied)) {
      peersSucceeded += 1;
    }
  }

  diagnostics.noProtocolPeers = noProtocolPeers;
  await invoke('finalizeCatchup', request.contextGraphId, dataSynced, sharedMemorySynced);

  return {
    connectedPeers: prepared.connectedPeers,
    totalPeers: prepared.connectedPeers,
    selectedPeers: prepared.peerIds.length,
    syncCapablePeers,
    peersTried,
    peersResponded,
    peersSucceeded,
    dataSynced,
    sharedMemorySynced,
    denied: deniedPeers > 0,
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
