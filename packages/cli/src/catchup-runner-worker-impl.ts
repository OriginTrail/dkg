import { parentPort } from 'node:worker_threads';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  SWM_CATCHUP_MAX_PASSES,
  SWM_CATCHUP_PASS_BUDGET_MS,
  catchupPassNowMs,
  catchupWaveSizes,
  createFailedPeerDurableSyncResult,
  mapWithConcurrency,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
  selectSwmSnapshotCoverage,
  shouldRunAnotherCatchupPass,
  type CatchupPlaneContext,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type SwmSnapshotCoverage,
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

/** What distinguishes one pass of the peer walk from the next. */
interface CatchupPassContext {
  /** Continuation passes re-pull only the shared-memory plane. */
  sharedMemoryOnly: boolean;
  /** Absent on pass 1: the budget bounds the REPEAT, not the original walk. */
  deadlineMs?: number;
}

/**
 * The peers a further pass may contact — the CAPABILITY GATE.
 *
 * Read this and nothing else: a peer is capable exactly when its own last round
 * said it holds refs we have not resolved.
 *
 * It deliberately does NOT consult `failedPhases`, `hasBlockingFailure`,
 * `peersSucceeded`, or membership in `cleanPlaneCompletions`. That looks like the
 * obvious tidy-up and it inverts the fix: a peer that yielded mid-manifest on the
 * local clock sets `failedPhases` (so a partial round cannot report `done`) and is
 * therefore absent from every one of those — and it is precisely the peer the next
 * pass exists to revisit. Gating on "no failures" would have given zero extra
 * passes to the two peers that mattered in the r26 incident, and extra passes to
 * the ten barren ones.
 *
 * `snapshotsResolved < snapshotsTotal` is what does the excluding — both for the
 * peers already done AND for the barren and cleanly-empty ones, which report
 * `0/0` and fail it at `0 < 0`.
 *
 * `snapshotsTotal > 0` is therefore a **defensive restatement with no reachable
 * effect**, kept because it states the intent legibly. Do NOT treat it as a live
 * guard: mutating it to `>= 0` leaves the entire suite green, and no honest
 * fixture can kill it — changing any outcome would need `resolved < total` to
 * hold while `total <= 0`, i.e. a negative resolved count, which no path
 * produces. A row written to kill it would pass only because its fixture is
 * impossible. Stated here rather than left in a commit message because the next
 * mutation window would otherwise re-derive it from scratch, and the next
 * refactor would preserve an inert clause believing it load-bearing.
 *
 * `manifestComplete` IS required, and it is not a failure signal — it states that
 * the denominator is the peer's whole manifest rather than a truncated prefix.
 * A truncated manifest is the one shape that can advance coverage forever while
 * materializing nothing: `runSharedMemorySync` parses descriptors only when the
 * meta phase completed, and wires `onSnapshotReady` only when descriptors exist,
 * so a truncated-meta round still fetches and caches blobs — advancing
 * `snapshotsResolved`, and so satisfying the coverage-advance gate — while
 * writing zero KAs. Every repeat would re-pay a full metadata phase to warm a
 * cache that cannot become visible until the manifest completes, and a fresh
 * per-round deadline is no more generous than the one that truncated it.
 *
 * This does NOT re-admit the failure-counter mistake above. A peer that yielded
 * mid-snapshot-list on the local clock — the peer this loop exists to revisit —
 * completed its META phase first and therefore carries `manifestComplete: true`,
 * so it stays capable. The two conditions are orthogonal: one says the
 * denominator is whole, the other would have said the peer faulted.
 */
function capablePeersForNextPass(coverageByPeer: Map<string, SwmSnapshotCoverage>): string[] {
  const capable: string[] = [];
  for (const [peerId, coverage] of coverageByPeer) {
    if (
      coverage.manifestComplete
      && coverage.snapshotsTotal > 0
      && coverage.snapshotsResolved < coverage.snapshotsTotal
    ) {
      capable.push(peerId);
    }
  }
  return capable;
}

/**
 * Emit one observability line through the host, and NEVER let it affect the job.
 *
 * The Worker has no logger, so the line travels as an RPC — and an RPC can
 * reject. A catch-up that failed because a log line could not be delivered would
 * be a strictly worse outcome than a catch-up with a missing log line, so the
 * rejection is swallowed here rather than unwinding `runCatchup`. This is also
 * what keeps a host that does not implement the method (older host, or a test
 * double that rejects unknown invokes) from turning observability into a
 * dependency.
 */
async function logPassLine(message: string): Promise<void> {
  await invoke<null>('logCatchupPass', message).catch(() => {});
}

/**
 * Render the reported coverage for the per-pass log line, naming the peer it came
 * from. Coverage is always attributed: the record is selected whole from one
 * round, so `178/250` and the peer that said it belong together, and a line that
 * printed the counts without the peer would invite reading them as a fleet total.
 */
function describeCoverage(coverage: SwmSnapshotCoverage | undefined): string {
  if (!coverage) return 'no peer reported snapshot coverage';
  const manifest = coverage.manifestComplete ? '' : ' (manifest truncated; total is a lower bound)';
  return `${coverage.snapshotsResolved}/${coverage.snapshotsTotal} snapshots from `
    + `...${coverage.peerIdSuffix}${manifest}`;
}

/**
 * The walk's coverage high-water reading: the best any single peer reported.
 *
 * A progress signal, never a correctness denominator — peers describe different
 * manifests, and the completion proof stays `catchupPlaneProvenByData`. Taken as a
 * max over whole per-peer records so no synthetic pair is ever formed.
 */
function highestResolvedCoverage(coverageByPeer: Map<string, SwmSnapshotCoverage>): number {
  let highest = 0;
  for (const coverage of coverageByPeer.values()) {
    if (coverage.snapshotsResolved > highest) highest = coverage.snapshotsResolved;
  }
  return highest;
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
    snapshotPlaneIncomplete: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
    // `swmCoverage` stays ABSENT here on purpose. This is the fallback for a
    // peer whose round threw, so it has no manifest to report; a fabricated
    // `0/0` would be a record the reduction could select and Chunk 5 could
    // print. Absent and `0/0` both read as "not capable", but only absent is
    // honest.
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
  // DISTINCT peers, not peer-passes. Once the walk can repeat, `+= 1` per round
  // counts the same peer once per pass — which inflates every one of these and
  // drives `peersNotAttempted` (`syncCapable.length - peersTried`) NEGATIVE on the
  // second pass. `continuationPasses` is the separate signal for how many passes
  // were spent.
  const peersTried = new Set<string>();
  const peersResponded = new Set<string>();
  const peersSucceeded = new Set<string>();
  /** Each peer's own coverage from its LAST round; the capability gate's input. */
  const lastCoverageByPeer = new Map<string, SwmSnapshotCoverage>();
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
      snapshotPlaneIncomplete: 0,
      continuationPasses: 0,
      replayPhaseBytesReceived: 0,
      snapshotPhaseBytesReceived: 0,
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
  const syncPeer = async (peerId: string, pass: CatchupPassContext): Promise<PeerRound> => {
    const fromAuthorityPeer = prepared.authoritativePeerId !== undefined
      && peerId === prepared.authoritativePeerId;
    // A deferred plane can burn up to CATCHUP_BACKPRESSURE_MAX_WAIT_MS (180 s)
    // inside a single admission, so a continuation pass can go past its budget
    // between one peer and the next. Decline to START another peer rather than
    // interrupt one: a wave member already in flight is never cancelled, for the
    // same reason the wave loop below never cancels one — an aborted resumed
    // session is indistinguishable from a responder supersede.
    //
    // Pass 1 has no deadline. It is today's walk unchanged, and the budget bounds
    // the REPEAT, not the original: a zero budget would otherwise expire before
    // the first peer and turn the kill switch into "fetch nothing".
    if (pass.deadlineMs !== undefined && catchupPassNowMs() >= pass.deadlineMs) {
      return { peerId, fromAuthority: fromAuthorityPeer, durable: null, shared: null };
    }
    peersTried.add(peerId);
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
    // A continuation pass is shared-memory only. The capability gate that put
    // this peer here is defined purely on SWM coverage, so re-pulling the durable
    // plane would be amplification with nothing selecting for it — and the whole
    // accepted cost of repeating the walk is per-pass replay. Pass 1's durable
    // evidence is already in `cleanPlaneCompletions`; a later pass producing none
    // cannot take it away.
    const needDurable = !pass.sharedMemoryOnly && (!optimize || !authorityProven.durable);
    const needSharedMemory = request.includeSharedMemory
      && (!optimize || !authorityProven.sharedMemory);
    const fromAuthority = fromAuthorityPeer;
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

  const accumulate = ({ peerId, durable, shared, fromAuthority }: PeerRound): void => {
    let peerDenied = false;
    if (shared) {
      // This peer's OWN latest coverage, kept apart from the reduced record in
      // `diagnostics`. The reduction picks one peer's record to REPORT; the
      // capability gate needs each peer's own, and last-round-wins is what makes
      // "still has refs we lack" a statement about now rather than about pass 1.
      //
      // A round that reports no coverage is forgotten ONLY when it completed
      // cleanly — a genuinely barren peer, whose record Chunk 1 suppresses at
      // `snapshotsTotal === 0`. A FAILED round retains what the peer last told
      // us, because a throw is not evidence of absence: `syncSharedMemory`'s
      // `.catch(() => emptyShared())` returns a truthy result carrying no
      // coverage, so forgetting on it would erase a peer's `178/250` the moment
      // one pass against it threw. If that was the last capable peer, the next
      // decision sees an empty set and stops at `no-capable-peers` — abandoning a
      // graph we have positive evidence is recoverable. That is the #2050
      // scenario itself: those peers were recorded with SWM transport failures,
      // and surviving them is the whole reason the walk repeats.
      //
      // The asymmetry is deliberate. A stale-but-positive record can only
      // over-attempt one peer, bounded by the pass cap and the budget; deleting
      // it gives up. `catchupPlaneCompletedWithoutFailure` is the same predicate
      // the authority-answering logic below uses, so the two cannot disagree, and
      // it already counts a deferred plane as not completed.
      //
      // For whoever reads a stop reason later: `highestResolvedCoverage` is a max
      // over this map, so any forgetting can make the reading DECREASE between
      // passes, which trips the stalled check and reports `coverage-stalled` for
      // what was really a transport failure. Requiring a clean round removes the
      // common cause; a decrease stays reachable when a barren round follows a
      // productive one against a different peer.
      if (shared.swmCoverage) {
        lastCoverageByPeer.set(peerId, shared.swmCoverage);
      } else if (catchupPlaneCompletedWithoutFailure(shared)) {
        lastCoverageByPeer.delete(peerId);
      }
    }
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
      diagnostics.sharedMemory.snapshotPlaneIncomplete += shared.snapshotPlaneIncomplete ?? 0;
      diagnostics.sharedMemory.replayPhaseBytesReceived += shared.replayPhaseBytesReceived ?? 0;
      diagnostics.sharedMemory.snapshotPhaseBytesReceived += shared.snapshotPhaseBytesReceived ?? 0;
      deferredBackpressure += shared.deferredBackpressure ?? 0;
      // Coverage is the one field here that is SELECTED, not summed. Summing —
      // or taking independent maxima over resolved and total — would let a peer
      // reporting 178/250 and a peer reporting 200/200 combine into 200/250: a
      // graph state no peer described, carrying a missing sample from neither.
      // `fromAuthority` is attached here because peer roles are the walk's
      // knowledge, not the agent-side sync's.
      if (shared.swmCoverage) {
        diagnostics.sharedMemory.swmCoverage = selectSwmSnapshotCoverage(
          diagnostics.sharedMemory.swmCoverage,
          { ...shared.swmCoverage, fromAuthority },
        );
      }
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
      peersResponded.add(peerId);
    }

    // Count peers that completed a sync round without a transport
    // failure/denial and either made phase/checkpoint progress, or cleanly
    // completed with no timeout. Mirrors the inline
    // `syncContextGraphFromConnectedPeers` path so both runners report the
    // same shape.
    if (catchupPeerSucceeded(durable, shared, peerDenied, durable?.complete)) {
      peersSucceeded.add(peerId);
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
  const runWalk = async (walkPeers: string[], pass: CatchupPassContext): Promise<void> => {
  const authorityFirst = prepared.authoritativePeerId !== undefined
    && walkPeers[0] === prepared.authoritativePeerId;
  // Waves exist ONLY so an authority can cut the walk short. With no authority
  // resolvable nothing can ever break the loop, so splitting the peer set into
  // waves cannot save a single fetch — it only adds a barrier between them,
  // making the round SLOWER than the single bounded pass it replaced. Fall back
  // to that pass rather than paying for a stop that cannot happen.
  const canStopEarly = CATCHUP_STOP_ON_PROOF && prepared.authoritativePeerId !== undefined;
  const waveSizes = canStopEarly
    ? catchupWaveSizes(
      walkPeers.length,
      CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
      authorityFirst ? 1 : CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
    )
    : [walkPeers.length];
  let cursor = 0;
  for (const waveSize of waveSizes) {
    const wave = walkPeers.slice(cursor, cursor + waveSize);
    if (wave.length === 0) break;
    cursor += wave.length;
    // Never cancel a wave member mid-stream: an aborted resumed session is
    // indistinguishable from a responder supersede. Let the wave finish, then
    // stop before dispatching the next one.
    const rounds = await mapWithConcurrency(
      wave,
      Math.min(CATCHUP_MAX_CONCURRENT_PEER_SYNCS, wave.length),
      (peerId) => syncPeer(peerId, pass),
    );
    for (const round of rounds) accumulate(round);
    settleAuthorityForWave();
    if (CATCHUP_STOP_ON_PROOF && authorityProvedEverything()) break;
  }
  };

  // Pass 1 IS today's walk: same peers, both planes, no deadline. Everything the
  // repeat loop adds happens after it returns, so a node with extra passes
  // disabled behaves exactly as it did before #2050.
  await runWalk(syncCapable, { sharedMemoryOnly: false });

  // The bounded, progress-aware repeat (#2050). A receiver that ran out of clock
  // mid-manifest used to terminate `unreachable` with a partial graph and no
  // resume path; now the walk repeats while it is provably converging.
  //
  // The budget is read from the environment rather than passed per request
  // because this runner has exactly one caller shape — the daemon's foreground
  // catch-up job. `DKG_SWM_CATCHUP_PASS_BUDGET_MS=0` is the operator kill switch
  // and needs no redeploy; it makes the deadline expire before the first repeat.
  let continuationPasses = 0;
  let coverageHighWaterMark = 0;
  if (request.includeSharedMemory) {
    const passDeadlineMs = catchupPassNowMs() + SWM_CATCHUP_PASS_BUDGET_MS;
    for (;;) {
      const lastPassCoverage = highestResolvedCoverage(lastCoverageByPeer);
      const decision = shouldRunAnotherCatchupPass({
        nowMs: catchupPassNowMs(),
        deadlineMs: passDeadlineMs,
        passesRun: 1 + continuationPasses,
        maxPasses: SWM_CATCHUP_MAX_PASSES,
        coverageHighWaterMark,
        lastPassCoverage,
        planeProven: catchupPlaneProvenByData(cleanPlaneCompletions.sharedMemory),
        capablePeers: capablePeersForNextPass(lastCoverageByPeer),
      });
      if (!decision.continue) {
        // Published ONLY on the decision that stops the loop, so `'continue'` is
        // structurally unrepresentable in this field rather than merely
        // unreachable-by-inspection. Assigning on every decision left the field
        // transiently holding `'continue'` and one added exit path — a
        // cancellation `break` after a pass, say — from publishing it. The
        // terminal message absorbs that value today (`SWM_STOP_REASON_TEXT.continue`
        // is `''`, which is falsy and omits the clause), so it would have degraded
        // quietly instead of rendering malformed text; this makes the defensive
        // entry provably dead rather than load-bearing.
        diagnostics.sharedMemory.continuationStopReason = decision.reason;
        // Logged even when no extra pass ran. "Why did it stop" is the question a
        // partial catch-up raises, and the answer is otherwise only reconstructable
        // from counters — `no-capable-peers` after a converged walk and after an
        // abandoned one look identical in the numbers.
        await logPassLine(`Catch-up SWM pass loop for "${request.contextGraphId}" `
          + `stopped after ${1 + continuationPasses} pass(es): ${decision.reason}; `
          + `${describeCoverage(diagnostics.sharedMemory.swmCoverage)}`);
        break;
      }
      coverageHighWaterMark = lastPassCoverage;
      continuationPasses += 1;
      const passStartedMs = catchupPassNowMs();
      await runWalk(decision.peers, { sharedMemoryOnly: true, deadlineMs: passDeadlineMs });
      // Coverage BEFORE and AFTER on one line: a pass whose elapsed time is large
      // and whose coverage did not move is the signature of a job that is not
      // converging, and that is not visible from either number alone.
      await logPassLine(`Catch-up SWM pass ${1 + continuationPasses} for `
        + `"${request.contextGraphId}": ${decision.peers.length} capable peer(s), coverage `
        + `${lastPassCoverage} -> ${highestResolvedCoverage(lastCoverageByPeer)} resolved, `
        + `${Math.round(catchupPassNowMs() - passStartedMs)}ms; `
        + `${describeCoverage(diagnostics.sharedMemory.swmCoverage)}`);
    }
    if (continuationPasses > 0) {
      diagnostics.sharedMemory.continuationPasses = continuationPasses;
    }
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
    peersTried: peersTried.size,
    peersResponded: peersResponded.size,
    peersSucceeded: peersSucceeded.size,
    peersNotAttempted: syncCapable.length - peersTried.size,
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
