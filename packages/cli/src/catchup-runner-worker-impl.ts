import { parentPort } from 'node:worker_threads';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  catchupWaveSizes,
  createFailedPeerDurableSyncResult,
  mapWithConcurrency,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
} from '@origintrail-official/dkg-agent';
import {
  catchupPeerResponded,
  catchupPeerSucceeded,
  catchupPlaneCompletedWithoutFailure,
  type CatchupJobResult,
  type CatchupRunRequest,
} from './catchup-runner.js';

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

/** A per-peer sync round; a plane is absent when the walk skipped it. */
interface PeerRound {
  peerId: string;
  /** The resolved curator for this Context Graph produced this round. */
  fromAuthority: boolean;
  durable: any | null;
  shared: any | null;
}

function emptyShared() {
  return {
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
    deferredBackpressure: 0,
  };
}

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
  let deferredBackpressure = 0;
  let dataSynced = 0;
  let sharedMemorySynced = 0;
  let deniedPeers = 0;
  let noProtocolPeers = 0;

  const cleanPlaneCompletions: NonNullable<CatchupJobResult['cleanPlaneCompletions']> = {
    durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
    sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
  };

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
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
      failedPhases: 0,
      deferredBackpressure: 0,
      deniedPhases: 0,
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
      deferredBackpressure: 0,
      deniedPhases: 0,
    },
  };

  // Probe every connected peer for PROTOCOL_SYNC up front, bounded by the shared
  // catch-up cap. This stays eager on purpose: `syncCapablePeers` and
  // `noProtocolPeers` are read by daemon status mapping as counts over the whole
  // connected set ("no sync-capable peers found — the curator may be offline"),
  // and the probe is a peerStore lookup, not a transfer.
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

  // Only the resolved curator's snapshot is a reference for the WHOLE graph: a
  // peer's `complete` flag proves it served its own manifest, so a
  // non-authoritative peer carrying a subset would otherwise be able to cut the
  // walk short and strand another peer's Knowledge Assets. Both optimisations
  // below — skipping remaining peers, and skipping an already-proven plane on
  // the peers we do contact — are therefore gated on AUTHORITY proof. With no
  // resolvable curator the walk degrades to the previous full bounded fan-out
  // and keeps unioning every peer's data.
  const authorityProven = { durable: false, sharedMemory: false };
  const authorityProvedEverything = (): boolean => authorityProven.durable
    && (!request.includeSharedMemory || authorityProven.sharedMemory);

  // Isolate per-peer failures: if one peer's sync steps throw, aggregate what we
  // can from the other peers instead of failing the entire subscribe/catch-up.
  const syncPeer = async (peerId: string): Promise<PeerRound> => {
    const syncDurable = ({ priority, source }: { priority?: number; source?: string }) =>
      invoke<any>('syncDurable', peerId, request.contextGraphId, priority, source)
        .catch(() => createFailedPeerDurableSyncResult())
        .then((rawDurable: any) => ({
          ...rawDurable,
          verifiedPrivateOnlyResponses: rawDurable.verifiedPrivateOnlyResponses ?? 0,
        }));
    const syncSharedMemory = ({ priority, source }: { priority?: number; source?: string }) =>
      invoke<any>('syncSharedMemory', peerId, request.contextGraphId, priority, source)
        .catch(() => emptyShared());

    // Narrow each fallback peer to the planes the AUTHORITY has not already
    // settled. One plane is often settled long before the other — a Context
    // Graph whose public VM data is empty can never prove its durable plane by
    // data — so without this a single unproven plane would drag a full re-pull
    // of the already-settled plane out of every remaining peer, which is the
    // amplification this fix exists to remove. The kill-switch restores the
    // previous fan-out faithfully: every peer, both requested planes.
    const optimize = CATCHUP_STOP_ON_PROOF;
    const needDurable = !optimize || !authorityProven.durable;
    const needSharedMemory = request.includeSharedMemory
      && (!optimize || !authorityProven.sharedMemory);
    const fromAuthority = peerId === prepared.preferredPeerId;
    if (!needDurable) {
      const shared = needSharedMemory
        ? await runCatchupPlaneWithPolicy('foreground', syncSharedMemory)
        : null;
      return { peerId, fromAuthority, durable: null, shared };
    }
    const round = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: needSharedMemory,
      syncDurable,
      syncSharedMemory,
    });
    return { peerId, fromAuthority, ...round };
  };

  const accumulate = ({ durable, shared, fromAuthority }: PeerRound): void => {
    let peerDenied = false;
    if (durable) {
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
      diagnostics.durable.verifiedPrivateOnlyResponses +=
        durable.verifiedPrivateOnlyResponses;
      diagnostics.durable.dataRejectedMissingMeta += durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += durable.rejectedKcs;
      diagnostics.durable.failedPeers += durable.failedPeers;
      diagnostics.durable.failedPhases += durable.failedPhases ?? 0;
      diagnostics.durable.deferredBackpressure += durable.deferredBackpressure ?? 0;
      deferredBackpressure += durable.deferredBackpressure ?? 0;
      diagnostics.durable.deniedPhases =
        (diagnostics.durable.deniedPhases ?? 0) + (durable.deniedPhases ?? 0);
      peerDenied = peerDenied || durable.deniedPhases > 0;

      if (catchupPlaneCompletedWithoutFailure(durable, durable.complete)) {
        const provenByData = (durable.insertedDataTriples ?? 0) > 0
          || durable.verifiedPrivateOnlyResponses > 0;
        if ((durable.insertedDataTriples ?? 0) > 0) {
          cleanPlaneCompletions.durable.verifiedDataPeers += 1;
        }
        if (durable.verifiedPrivateOnlyResponses > 0) {
          cleanPlaneCompletions.durable.verifiedPrivateOnlyPeers += 1;
        }
        if ((durable.emptyResponses ?? 0) > 0) {
          cleanPlaneCompletions.durable.emptyPeers += 1;
        }
        // The curator answering cleanly settles this plane whether it carried
        // data or was legitimately empty: "the host says there is nothing here"
        // is the authoritative empty proof, and without it a graph with no
        // public data on one plane could never stop the walk.
        if (fromAuthority && (provenByData || (durable.emptyResponses ?? 0) > 0)) {
          authorityProven.durable = true;
        }
      }
    }

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
      diagnostics.sharedMemory.deferredBackpressure += shared.deferredBackpressure ?? 0;
      deferredBackpressure += shared.deferredBackpressure ?? 0;
      diagnostics.sharedMemory.deniedPhases =
        (diagnostics.sharedMemory.deniedPhases ?? 0) + (shared.deniedPhases ?? 0);
      peerDenied = peerDenied || shared.deniedPhases > 0;

      if (catchupPlaneCompletedWithoutFailure(shared)) {
        if ((shared.insertedDataTriples ?? 0) > 0) {
          cleanPlaneCompletions.sharedMemory.verifiedDataPeers += 1;
        }
        if ((shared.emptyResponses ?? 0) > 0) {
          cleanPlaneCompletions.sharedMemory.emptyPeers += 1;
        }
        // Same rule as durable: the curator settles the plane by answering
        // cleanly, with data or empty. Shared memory is frequently empty for a
        // graph that has durable data, and `includeSharedMemory` defaults to
        // true on subscribe, so without this the early stop would almost never
        // fire in the shape the fix targets.
        if (fromAuthority && ((shared.insertedDataTriples ?? 0) > 0 || (shared.emptyResponses ?? 0) > 0)) {
          authorityProven.sharedMemory = true;
        }
      }
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
    if (catchupPeerSucceeded(durable, shared, peerDenied, durable?.complete)) {
      peersSucceeded += 1;
    }
  };

  // Progressive peer walk (issue #2006). The peer list arrives ranked
  // authority-first (preferred/curator, then known cores, then the rest), but
  // that ordering used never to become *selection*: every sync-capable peer got
  // a full durable+SWM pull, so a 14-peer testnet downloaded the same graph 5-6
  // times (147,246 fetched triples for a 24,541-triple graph, ~278MB) and the
  // node-wide sync-global queue (2 inflight / 4 queued) saturated against
  // itself.
  //
  // Instead, walk escalating waves and stop as soon as the AUTHORITY has proven
  // every requested plane with verified data — see `authorityProven` above for
  // why only the curator's snapshot may cut the walk short. Wave 1 is that
  // curator when one is resolvable, so the happy path transfers exactly one
  // payload; with no resolvable curator nothing is ever authority-proven and
  // this degrades to the previous full bounded fan-out.
  //
  // The stop condition is also deliberately POSITIVE-only: an empty round proves
  // nothing on its own (an unrelated peer and an empty host are byte-identical
  // on the wire), so emptiness stays a whole-round verdict evaluated by
  // `catchupPlaneProvenByUnanimousEmpty` after every peer has been walked.
  //
  // Tradeoff, stated deliberately: even the curator's `complete` flag proves it
  // served its own manifest, not that the manifest was network-complete.
  // Foreground catch-up therefore optimises for one fast authoritative payload;
  // breadth and eventual convergence remain the background reconcile lane's job.
  // DKG_CATCHUP_STOP_ON_PROOF=0 restores the previous full fan-out.
  //
  // The single-peer opening wave is spent on the authority, so it is only taken
  // when there IS one: if no curator resolved (or it is not sync-capable), the
  // head of the ranked list has no special claim and serialising it would just
  // add a round-trip to the front of every round, with no early stop to earn it
  // back. In that case the walk opens at the full concurrency cap — the previous
  // first-round latency.
  const authorityFirst = prepared.preferredPeerId !== undefined
    && syncCapable[0] === prepared.preferredPeerId;
  const waveSizes = CATCHUP_STOP_ON_PROOF
    ? catchupWaveSizes(
      syncCapable.length,
      CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
      authorityFirst ? 1 : CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
    )
    : [syncCapable.length];
  let cursor = 0;
  for (const waveSize of waveSizes) {
    const wave = syncCapable.slice(cursor, cursor + waveSize);
    if (wave.length === 0) break;
    cursor += wave.length;
    peersTried += wave.length;
    // Never cancel a wave member mid-stream: an aborted resumed session is
    // indistinguishable from a responder supersede. Let the wave finish, then
    // stop before dispatching the next one.
    const rounds = await mapWithConcurrency(
      wave,
      Math.min(CATCHUP_MAX_CONCURRENT_PEER_SYNCS, wave.length),
      syncPeer,
    );
    for (const round of rounds) accumulate(round);
    if (CATCHUP_STOP_ON_PROOF && authorityProvedEverything()) break;
  }

  diagnostics.noProtocolPeers = noProtocolPeers;
  if (deferredBackpressure === 0) {
    await invoke('finalizeCatchup', request.contextGraphId, dataSynced, sharedMemorySynced);
  }

  return {
    connectedPeers: prepared.connectedPeers,
    totalPeers: prepared.connectedPeers,
    selectedPeers: prepared.peerIds.length,
    syncCapablePeers,
    peersTried,
    peersResponded,
    peersSucceeded,
    peersNotAttempted: syncCapable.length - peersTried,
    deferredBackpressure,
    dataSynced,
    sharedMemorySynced,
    denied: deniedPeers > 0,
    deniedPeers,
    cleanPlaneCompletions,
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
