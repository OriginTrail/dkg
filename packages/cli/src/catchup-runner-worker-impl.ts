import { parentPort } from 'node:worker_threads';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  SwmCatchupPassTracker,
  catchupPassNowMs,
  catchupWaveSizes,
  createFailedPeerDurableSyncResult,
  mapWithConcurrency,
  resolveSwmCatchupPassConfig,
  runSwmCatchupContinuations,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
  selectSwmSnapshotCoverage,
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
  /** The metadata-resolved curator produced this round. */
  fromDurableAuthority: boolean;
  /** An operator-pinned RFC-64 graph-complete SWM provider produced this round. */
  fromSharedMemoryAuthority: boolean;
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
    /** Operator-pinned RFC-64 providers that each carry the complete public SWM graph. */
    authoritativeSharedMemoryPeerIds?: string[];
    isPrivateContextGraph: boolean;
    peerIds: string[];
    connectedPeers: number;
  }>('prepareCatchup', request.contextGraphId, request.includeSharedMemory);
  const authoritativeSharedMemoryPeerIds = new Set(
    prepared.authoritativeSharedMemoryPeerIds ?? [],
  );

  let syncCapablePeers = 0;
  // DISTINCT peers, not peer-passes. Once the walk can repeat, `+= 1` per round
  // counts the same peer once per pass — which inflates every one of these and
  // drives `peersNotAttempted` (`syncCapable.length - peersTried`) NEGATIVE on the
  // second pass. `continuationPasses` is the separate signal for how many passes
  // were spent.
  const peersTried = new Set<string>();
  const peersResponded = new Set<string>();
  const peersSucceeded = new Set<string>();
  const passTracker = new SwmCatchupPassTracker<SwmSnapshotCoverage>();
  let deferredBackpressure = 0;
  let dataSynced = 0;
  let sharedMemorySynced = 0;
  // Also DISTINCT peers, for the reason above — a peer that denies on every
  // pass would otherwise be counted once per pass. The agent driver already
  // models this as a set (`accessDeniedPeers`), so a scalar here additionally
  // made the two drivers disagree on the semantics of a field they both return.
  const deniedPeers = new Set<string>();
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

  // Only a plane-specific authority may let one snapshot stand for the WHOLE
  // graph: metadata resolves the durable/VM authority, while an explicit
  // RFC-64 manifest may separately pin a graph-complete SWM provider. A peer's
  // `complete` flag otherwise proves only its own manifest. Both optimisations
  // below — skipping remaining peers and skipping an already-proven plane —
  // are therefore gated on the corresponding authority proof.
  const authorityProven = { durable: false, sharedMemory: false };
  const authorityProvedEverything = (): boolean => authorityProven.durable
    && (!request.includeSharedMemory || authorityProven.sharedMemory);

  /**
   * Each plane authority's own evidence, kept apart from the round total.
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
   * Whether the corresponding authority settles a plane well enough to stop walking.
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
   * Did the corresponding authority cleanly answer this plane at all?
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
    const fromDurableAuthority = prepared.authoritativePeerId !== undefined
      && peerId === prepared.authoritativePeerId;
    const fromSharedMemoryAuthority = authoritativeSharedMemoryPeerIds.size > 0
      ? authoritativeSharedMemoryPeerIds.has(peerId)
      : fromDurableAuthority;
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
      return {
        peerId,
        fromDurableAuthority,
        fromSharedMemoryAuthority,
        durable: null,
        shared: null,
      };
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
    const hasDedicatedDurableAuthority = prepared.authoritativePeerId !== undefined;
    const hasDedicatedSharedMemoryAuthority = authoritativeSharedMemoryPeerIds.size > 0;
    const needDurable = !pass.sharedMemoryOnly
      && (!optimize || !authorityProven.durable)
      && (
        !optimize
        || !hasDedicatedDurableAuthority
        || fromDurableAuthority
        || !fromSharedMemoryAuthority
      );
    // A policy-selected continuation peer is here precisely because its latest
    // complete manifest still names unresolved snapshots. Authority proof may
    // optimize pass 1, but it must never turn that selected retry into a no-op.
    const needSharedMemory = request.includeSharedMemory
      && (pass.sharedMemoryOnly || !optimize || !authorityProven.sharedMemory)
      && (
        pass.sharedMemoryOnly
        || !optimize
        || !hasDedicatedSharedMemoryAuthority
        || fromSharedMemoryAuthority
        || !fromDurableAuthority
      );
    if (!needDurable) {
      const shared = needSharedMemory
        ? await runCatchupPlaneWithPolicy('foreground', syncSharedMemory)
        : null;
      return {
        peerId,
        fromDurableAuthority,
        fromSharedMemoryAuthority,
        durable: null,
        shared,
      };
    }
    const round = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: needSharedMemory,
      syncDurable,
      syncSharedMemory,
    });
    return { peerId, fromDurableAuthority, fromSharedMemoryAuthority, ...round };
  };

  const accumulate = (
    {
      peerId,
      durable,
      shared,
      fromDurableAuthority,
      fromSharedMemoryAuthority,
    }: PeerRound,
    isContinuationRound = false,
  ): void => {
    let peerDenied = false;
    if (shared) {
      passTracker.recordPeerRound(
        peerId,
        shared.swmCoverage,
        catchupPlaneCompletedWithoutFailure(shared),
      );
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
        fromAuthority: fromDurableAuthority,
        plane: 'durable',
      });
      addCatchupPlaneEvidence(cleanPlaneCompletions.durable, durableEvidence);
      if (fromDurableAuthority) {
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
      // The DIAGNOSTIC above counts every deferral, including continuation
      // ones — that is the honest observability number. The JOB-LEVEL scalar
      // below must not, and the reason is a behaviour change rather than a
      // tidy-up.
      //
      // `deferredBackpressure > 0` makes the daemon route short-circuit BEFORE
      // classification (`routes/context-graph.ts`), which is the only path to
      // `classifyContextGraphCatchupReadiness`, the readiness write, the
      // subscription state patch and `PROJECT_SYNCED`. Its premise — "an
      // incomplete round has no readiness to inspect" — holds when the round
      // was cut short. It is FALSE when pass 1 completed and only a
      // best-effort EXTRA pass was refused capacity: nothing was lost, and the
      // readiness pass 1 earned is real.
      //
      // Without this gate the continuation loop can demote an already
      // successful job to `deferred` and discard its readiness, on exactly the
      // workload #2050 targets — a large public graph under store pressure is
      // precisely when admission defers. The pass budget's own rationale
      // anticipates it ("sized so at least two extra passes fit even when a
      // peer's plane is deferred"), so this is a designed-for state, not an
      // edge case.
      if (!isContinuationRound) {
        deferredBackpressure += shared.deferredBackpressure ?? 0;
      }
      // Coverage is the one field here that is SELECTED, not summed. Summing —
      // or taking independent maxima over resolved and total — would let a peer
      // reporting 178/250 and a peer reporting 200/200 combine into 200/250: a
      // graph state no peer described, carrying a missing sample from neither.
      // `fromAuthority` is attached here because peer roles are the walk's
      // knowledge, not the agent-side sync's.
      if (shared.swmCoverage) {
        diagnostics.sharedMemory.swmCoverage = selectSwmSnapshotCoverage(
          diagnostics.sharedMemory.swmCoverage,
          { ...shared.swmCoverage, fromAuthority: fromSharedMemoryAuthority },
        );
      }
      diagnostics.sharedMemory.deniedPhases =
        (diagnostics.sharedMemory.deniedPhases ?? 0) + (shared.deniedPhases ?? 0);
      peerDenied = peerDenied || shared.deniedPhases > 0;

      // Shared memory carries no verified-private-only signal, so the shared
      // evidence only ever has data/empty set — the same reducer still applies.
      const sharedEvidence = catchupPeerPlaneEvidence(shared, {
        fromAuthority: fromSharedMemoryAuthority,
        plane: 'shared-memory',
      });
      addCatchupPlaneEvidence(cleanPlaneCompletions.sharedMemory, sharedEvidence);
      if (fromSharedMemoryAuthority) {
        addCatchupPlaneEvidence(authorityEvidence.sharedMemory, sharedEvidence);
        if (catchupPlaneCompletedWithoutFailure(shared)) {
          authorityAnswered.sharedMemory = true;
        }
      }
    }

    if (peerDenied) {
      deniedPeers.add(peerId);
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

  // Progressive peer walk (issue #2006). The peer list arrives ranked with
  // RFC-64 SWM providers and the metadata curator first, then known cores and the rest, but
  // that ordering used never to become *selection*: every sync-capable peer got
  // a full durable+SWM pull, so a 14-peer testnet downloaded the same graph 5-6
  // times (147,246 fetched triples for a 24,541-triple graph, ~278MB) and the
  // node-wide sync-global queue (2 inflight / 4 queued) saturated against
  // itself.
  //
  // Instead, walk escalating waves and stop as soon as each requested plane's
  // authority has proven it with verified data. Distinct VM and SWM authorities
  // share the opening wave and each runs only its own plane. With no authority,
  // this degrades to the previous full bounded fan-out.
  //
  // The stop condition is also deliberately POSITIVE-only: an empty round proves
  // nothing on its own (an unrelated peer and an empty host are byte-identical
  // on the wire), so emptiness stays a whole-round verdict evaluated by
  // `catchupPlaneProvenByUnanimousEmpty` after every peer has been walked.
  //
  // Tradeoff, stated deliberately: metadata authority alone still proves only
  // the curator's hosted view. An RFC-64 `completeSwmProviders` entry is a
  // stronger operator assertion scoped to one accepted public policy; omitting
  // it retains the ordinary union walk and background convergence.
  // DKG_CATCHUP_STOP_ON_PROOF=0 restores the previous full fan-out.
  //
  // The opening wave is spent on the reachable plane authorities, so it is only
  // narrowed when at least one heads the ranked list. If none is sync-capable, the
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
  const runWalk = async (
    walkPeers: readonly string[],
    pass: CatchupPassContext,
  ): Promise<void> => {
  const isPlaneAuthority = (peerId: string): boolean => (
    peerId === prepared.authoritativePeerId
    || authoritativeSharedMemoryPeerIds.has(peerId)
  );
  let openingAuthorityCount = 0;
  while (
    openingAuthorityCount < walkPeers.length
    && openingAuthorityCount < CATCHUP_MAX_CONCURRENT_PEER_SYNCS
    && isPlaneAuthority(walkPeers[openingAuthorityCount]!)
  ) openingAuthorityCount += 1;
  // Waves exist ONLY so an authority can cut the walk short. With no authority
  // resolvable nothing can ever break the loop, so splitting the peer set into
  // waves cannot save a single fetch — it only adds a barrier between them,
  // making the round SLOWER than the single bounded pass it replaced. Fall back
  // to that pass rather than paying for a stop that cannot happen.
  const canStopEarly = CATCHUP_STOP_ON_PROOF && (
    prepared.authoritativePeerId !== undefined
    || authoritativeSharedMemoryPeerIds.size > 0
  );
  const waveSizes = canStopEarly
    ? catchupWaveSizes(
      walkPeers.length,
      CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
      openingAuthorityCount > 0
        ? openingAuthorityCount
        : CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
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
    // `sharedMemoryOnly` is set only by the continuation loop; pass 1 is the
    // mandatory round. See the deferral gate inside `accumulate`.
    for (const round of rounds) accumulate(round, pass.sharedMemoryOnly);
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
  // Resolve once per job, then pass one explicit value into every decision.
  // This avoids module-import order becoming hidden configuration state while
  // retaining the operator kill switches.
  const passConfig = resolveSwmCatchupPassConfig();
  if (request.includeSharedMemory) {
    const execution = await runSwmCatchupContinuations({
      units: [{
        key: request.contextGraphId,
        ledger: passTracker,
        planeProven: () => catchupPlaneProvenByData(cleanPlaneCompletions.sharedMemory),
      }],
      config: passConfig,
      nowMs: catchupPassNowMs,
      onStop: async (stop) => {
        // Published ONLY on the decision that stops the loop, so `'continue'` is
        // structurally unrepresentable in this field rather than merely
        // unreachable-by-inspection. Assigning on every decision left the field
        // transiently holding `'continue'` and one added exit path — a
        // cancellation `break` after a pass, say — from publishing it. The
        // terminal message absorbs that value today (`SWM_STOP_REASON_TEXT.continue`
        // is `''`, which is falsy and omits the clause), so it would have degraded
        // quietly instead of rendering malformed text; this makes the defensive
        // entry provably dead rather than load-bearing.
        diagnostics.sharedMemory.continuationStopReason = stop.reason;
        // Logged even when no extra pass ran. "Why did it stop" is the question a
        // partial catch-up raises, and the answer is otherwise only reconstructable
        // from counters — `no-capable-peers` after a converged walk and after an
        // abandoned one look identical in the numbers.
        await logPassLine(`Catch-up SWM pass loop for "${request.contextGraphId}" `
          + `stopped after ${1 + stop.continuationPasses} pass(es): ${stop.reason}; `
          + `${describeCoverage(diagnostics.sharedMemory.swmCoverage)}`);
      },
      runPass: async ([candidate], deadlineMs) => {
        if (!candidate) return;
        await candidate.runStarted(async (pass) => {
          const passStartedMs = catchupPassNowMs();
          await runWalk(pass.peers, {
            sharedMemoryOnly: true,
            deadlineMs,
          });
          // Progress BEFORE and AFTER on one line: a pass whose elapsed time is large
          // and whose progress did not move is the signature of a job that is not
          // converging, and that is not visible from either number alone.
          //
          // Labelled "summed across peers" because that is exactly what it is — a
          // total over every peer's own high-water, spanning peers with different
          // manifests. It sits beside `describeCoverage`, which is ONE whole record
          // from ONE peer, and whose own doc warns that counts printed without their
          // peer invite being read as a fleet total. Two different quantities on one
          // line need the more surprising one named, or the reader will assume both
          // describe the record at the end of the sentence.
          await logPassLine(`Catch-up SWM pass ${1 + pass.continuationPass} for `
            + `"${request.contextGraphId}": ${pass.peers.length} capable peer(s), progress `
            + `${pass.progressBefore} -> ${pass.progress()} resolved `
            + 'summed across peers, '
            + `${Math.round(catchupPassNowMs() - passStartedMs)}ms; `
            + `${describeCoverage(diagnostics.sharedMemory.swmCoverage)}`);
        });
      },
    });
    if (execution.continuationPasses > 0) {
      diagnostics.sharedMemory.continuationPasses = execution.continuationPasses;
    }
  }

  // A curator we resolved but never heard cleanly from makes the round
  // incomplete rather than empty. Recorded per plane, since a curator can answer
  // one and fail the other.
  if (prepared.authoritativePeerId !== undefined) {
    diagnostics.durable.authorityUnanswered = !authorityAnswered.durable;
  }
  if (
    request.includeSharedMemory
    && (
      prepared.authoritativePeerId !== undefined
      || authoritativeSharedMemoryPeerIds.size > 0
    )
  ) {
    diagnostics.sharedMemory.authorityUnanswered = !authorityAnswered.sharedMemory;
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
    denied: deniedPeers.size > 0,
    deniedPeers: deniedPeers.size,
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
