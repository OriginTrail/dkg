import { parentPort } from 'node:worker_threads';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  catchupWaveSizes,
  createFailedPeerDurableSyncResult,
  mapWithConcurrency,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
  type CatchupPlaneContext,
  type DurableSyncResult,
  type SharedMemorySyncResult,
} from '@origintrail-official/dkg-agent';
import {
  addCatchupPlaneEvidence,
  catchupPeerPlaneEvidence,
  catchupPeerResponded,
  catchupPeerSucceeded,
  catchupPlaneCompletedWithoutFailure,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  type CatchupJobResult,
  type CatchupPlaneCompletionEvidence,
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

/**
 * One peer's durable plane. The wire shape is the agent's own
 * `DurableSyncResult`, structured-cloned back across the Worker RPC;
 * `verifiedPrivateOnlyResponses` is normalized to a number on arrival so the
 * accumulation below never has to re-guard it.
 */
type CatchupDurableResult = DurableSyncResult & { verifiedPrivateOnlyResponses: number };

/** One peer's shared-memory plane, as returned across the Worker RPC. */
type CatchupSharedMemoryResult = SharedMemorySyncResult;

/**
 * One peer's sync round. A plane is `null` when the walk deliberately skipped
 * it because the authority already settled that plane — that is the ONLY
 * exceptional case, and it is distinct from a plane that ran and failed.
 */
interface PeerRound {
  peerId: string;
  /** The resolved curator for this Context Graph produced this round. */
  fromAuthority: boolean;
  durable: CatchupDurableResult | null;
  shared: CatchupSharedMemoryResult | null;
}

function emptyShared(): CatchupSharedMemoryResult {
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
    /**
     * The preferred peer ONLY when it came from authoritative Context Graph
     * metadata. A join-approval bootstrap hint arrives as `preferredPeerId`
     * without this, so it orders the walk but can never end it.
     */
    authoritativePeerId?: string;
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
    durable: {
      verifiedDataPeers: 0,
      verifiedPrivateOnlyPeers: 0,
      emptyPeers: 0,
      authorityEmptyPeers: 0,
    },
    sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0, authorityEmptyPeers: 0 },
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

  /**
   * The CURATOR's own evidence, kept apart from the round total.
   *
   * The round total mixes in every peer, and only the curator may end the walk —
   * so proof-by-data has to be read from this, not from
   * `cleanPlaneCompletions`, or any peer's data would stop it.
   */
  const authorityEvidence: Record<'durable' | 'sharedMemory', CatchupPlaneCompletionEvidence> = {
    durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0, authorityEmptyPeers: 0 },
    sharedMemory: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0, authorityEmptyPeers: 0 },
  };

  /**
   * Whether the curator's round settles a plane well enough to stop walking.
   *
   * Verified content from the curator always does. Its EMPTINESS is weaker: it
   * is exactly `catchupPlaneProvenByAuthorityHostedEmpty`, the same predicate
   * the readiness classifier applies — called here with the round's diagnostics
   * so the two cannot disagree.
   *
   * That matters, because the round can contradict the curator. If another peer
   * fetched data, or served content that failed verification, the curator's
   * "there is nothing here" is stale and readiness voids it. Stopping the walk
   * on it anyway would skip peers that might have delivered valid content and
   * then report the job unready — the worst of both.
   *
   * Evaluated at the END of a wave rather than per peer, so a contradiction
   * raised by ANY member of the same wave is already visible regardless of the
   * order results happened to arrive in.
   */
  const authoritySettles = (
    plane: 'durable' | 'sharedMemory',
  ): boolean => catchupPlaneProvenByData(authorityEvidence[plane])
    || catchupPlaneProvenByAuthorityHostedEmpty(
      authorityEvidence[plane],
      diagnostics[plane],
      { isPrivate: prepared.isPrivateContextGraph },
    );

  /**
   * Did the curator cleanly answer this plane at all?
   *
   * Separate from `authorityProven`: a curator that answered with data proves the
   * plane, and one that answered content-free may or may not, but BOTH count as
   * having answered. What readiness needs to know is the third case — the curator
   * was selected and we never heard a clean word from it — because then a
   * stranger's empty response cannot stand for the graph.
   */
  const authorityAnswered = { durable: false, sharedMemory: false };

  /** Fold the wave's accumulated state into the stop flags. */
  const settleAuthorityForWave = (): void => {
    if (!authorityProven.durable && authoritySettles('durable')) {
      authorityProven.durable = true;
    }
    if (request.includeSharedMemory
      && !authorityProven.sharedMemory
      && authoritySettles('sharedMemory')) {
      authorityProven.sharedMemory = true;
    }
  };

  // Isolate per-peer failures: if one peer's sync steps throw, aggregate what we
  // can from the other peers instead of failing the entire subscribe/catch-up.
  const syncPeer = async (peerId: string): Promise<PeerRound> => {
    const syncDurable = (
      { priority, source }: CatchupPlaneContext,
    ): Promise<CatchupDurableResult> =>
      invoke<DurableSyncResult>('syncDurable', peerId, request.contextGraphId, priority, source)
        .catch(() => createFailedPeerDurableSyncResult())
        .then((rawDurable) => ({
          ...rawDurable,
          verifiedPrivateOnlyResponses: rawDurable.verifiedPrivateOnlyResponses ?? 0,
        }));
    const syncSharedMemory = (
      { priority, source }: CatchupPlaneContext,
    ): Promise<CatchupSharedMemoryResult> =>
      invoke<CatchupSharedMemoryResult>('syncSharedMemory', peerId, request.contextGraphId, priority, source)
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
    const fromAuthority = prepared.authoritativePeerId !== undefined
      && peerId === prepared.authoritativePeerId;
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

      const durableEvidence = catchupPeerPlaneEvidence(durable, {
        complete: durable.complete,
        fromAuthority,
        plane: 'durable',
      });
      addCatchupPlaneEvidence(cleanPlaneCompletions.durable, durableEvidence);
      if (fromAuthority) {
        addCatchupPlaneEvidence(authorityEvidence.durable, durableEvidence);
        if (catchupPlaneCompletedWithoutFailure(durable, durable.complete)) {
          authorityAnswered.durable = true;
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

      // Shared memory carries no verified-private-only signal, so the shared
      // evidence only ever has data/empty set — the same reducer still applies.
      const sharedEvidence = catchupPeerPlaneEvidence(shared, { fromAuthority, plane: 'shared-memory' });
      addCatchupPlaneEvidence(cleanPlaneCompletions.sharedMemory, sharedEvidence);
      if (fromAuthority) {
        addCatchupPlaneEvidence(authorityEvidence.sharedMemory, sharedEvidence);
        if (catchupPlaneCompletedWithoutFailure(shared)) {
          authorityAnswered.sharedMemory = true;
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
  // The `!== undefined` half is DEFENSIVE, not behavioural, and is called out
  // as such so it does not read as a load-bearing clause a test should pin:
  // with no resolvable curator and no sync-capable peers both sides are
  // `undefined` and would compare equal, but `catchupWaveSizes(0, …)` is `[]`
  // (pinned in `catchup-concurrency.test.ts`), so a zero-peer walk runs no
  // waves and the opening width is unobservable. The comparison is what
  // actually decides: narrow the opening wave only when the authority IS the
  // peer that wave would contact.
  const authorityFirst = prepared.authoritativePeerId !== undefined
    && syncCapable[0] === prepared.authoritativePeerId;
  // Waves exist ONLY so an authority can cut the walk short. With no authority
  // resolvable nothing can ever break the loop, so splitting the peer set into
  // waves cannot save a single fetch — it only adds a barrier between them,
  // making the round SLOWER than the single bounded pass it replaced. Fall back
  // to that pass rather than paying for a stop that cannot happen.
  const canStopEarly = CATCHUP_STOP_ON_PROOF && prepared.authoritativePeerId !== undefined;
  const waveSizes = canStopEarly
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
    settleAuthorityForWave();
    if (CATCHUP_STOP_ON_PROOF && authorityProvedEverything()) break;
  }

  // A curator we resolved but never heard cleanly from makes the round
  // incomplete rather than empty. Recorded per plane, since a curator can answer
  // one and fail the other.
  if (prepared.authoritativePeerId !== undefined) {
    diagnostics.durable.authorityUnanswered = !authorityAnswered.durable;
    if (request.includeSharedMemory) {
      diagnostics.sharedMemory.authorityUnanswered = !authorityAnswered.sharedMemory;
    }
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
