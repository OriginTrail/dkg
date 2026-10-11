import {
  classifyDurableProgress,
  type DurableProgressSummary,
} from '@origintrail-official/dkg-agent';

/** Progress fields shared by durable and shared-memory catch-up proof producers. */
export interface CatchupPhaseProgress extends DurableProgressSummary {
  bytesReceived?: number;
  emptyResponses?: number;
  fetchedDataTriples?: number;
  insertedDataTriples?: number;
  metaOnlyResponses?: number;
  verifiedPrivateOnlyResponses?: number;
}

export function catchupPlaneCompletedWithoutFailure(
  progress: CatchupPhaseProgress | null | undefined,
  complete?: boolean,
): boolean {
  return classifyDurableProgress(progress, { complete }).completedWithoutFailure;
}

/** Per-plane clean-completion evidence accumulated across the peers this run contacted. */
export interface CatchupPlaneCompletionEvidence {
  verifiedDataPeers: number;
  /** Peers that cleanly verified one or more V2 KAs with no public triples. */
  verifiedPrivateOnlyPeers?: number;
  /**
   * RFC-64 providers whose selected public-SWM scope reached its explicit
   * terminal boundary. Unlike an ordinary peer's empty response, this is a
   * graph-complete proof tied to the accepted provider policy.
   */
  selectedScopeCompletePeers?: number;
  emptyPeers: number;
  /**
   * The metadata-resolved curator cleanly completed this plane while hosting
   * the graph and carrying no data at all. See
   * {@link catchupPlaneProvenByUnanimousEmpty}.
   */
  authorityEmptyPeers?: number;
  /**
   * Peers that ANSWERED this plane but whose round did not complete cleanly.
   *
   * Every other field here records what a peer proved. This one records what a
   * peer left unresolved, and it exists because the absence of a peer from the
   * positive counters is ambiguous: `catchupPeerPlaneEvidence` returns an
   * all-zero record for an incomplete round, so a peer that answered EMPTY but
   * did not finish paging is indistinguishable from a peer that was never
   * contacted. That ambiguity is invisible to the round diagnostics too — an
   * explicit `complete: false` is not a transport failure, so it never reaches
   * `failedPeers`.
   *
   * Without it, a round of one clean-empty peer plus one incomplete-empty peer
   * reads as unanimously empty. Pure transport failures are deliberately NOT
   * counted here: an unreachable stranger is already `failedPeers`, and folding
   * it in would pin legitimately empty graphs in a retry loop on a lossy
   * network.
   */
  incompleteResponders?: number;
}

/** The aggregate per-plane counters a whole-round verdict is allowed to consult. */
export interface CatchupPlaneRoundDiagnostics {
  fetchedMetaTriples?: number;
  fetchedDataTriples?: number;
  emptyResponses?: number;
  /** Peers that returned `_meta` and no data; durable-only. */
  metaOnlyResponses?: number;
  failedPeers?: number;
  failedPhases?: number;
  timedOutPhases?: number;
  deniedPhases?: number;
  deferredBackpressure?: number;
  /** Durable-only integrity rejections; the shared-memory plane never sets them. */
  dataRejectedMissingMeta?: number;
  rejectedKcs?: number;
  /**
   * A metadata-resolved curator WAS selected for this walk and did not cleanly
   * answer this plane — it transport-failed, timed out, was denied, or never got
   * contacted. Distinct from `failedPeers`, which counts any unreachable peer.
   */
  authorityUnanswered?: boolean;
}

/**
 * Reduce ONE peer's plane result to the evidence a round accumulates from it.
 *
 * This is the single definition of what a peer's round contributes, so the
 * walk's stop condition and the readiness classifier cannot drift: the walk
 * feeds one peer's evidence to {@link catchupPlaneProvenByData}, and readiness
 * feeds the summed evidence to the same predicate. Adding a new verified-content
 * signal therefore has exactly one place to change.
 *
 * A plane that did not complete cleanly contributes nothing at all.
 */
export function catchupPeerPlaneEvidence(
  plane:
    | (CatchupPhaseProgress & { emptyResponses?: number; fetchedDataTriples?: number })
    | null
    | undefined,
  options: {
    /**
     * Which plane this result came from. REQUIRED, and deliberately not
     * defaulted: the strongest thing this function can say — hosted-empty
     * evidence — is true on the durable plane and false on shared memory, so a
     * defaulted `plane` would let a shared-memory call site silently take the
     * durable branch. Only a test would notice, and the whole point is that a
     * mistake here settles a plane nobody proved.
     */
    plane: 'durable' | 'shared-memory';
    /** Durable lifecycle state; selected SWM supplies its own typed equivalent. */
    complete?: boolean;
    /**
     * Lane-specific clean-completion verdict when raw diagnostics deliberately
     * retain superseded failures. Selected SWM is the current producer: its
     * freshness classifier resolves bounded historical yields while preserving
     * those counters for telemetry.
     */
    completedWithoutFailure?: boolean;
    fromAuthority?: boolean;
  },
): CatchupPlaneCompletionEvidence {
  const none = {
    verifiedDataPeers: 0,
    verifiedPrivateOnlyPeers: 0,
    emptyPeers: 0,
    authorityEmptyPeers: 0,
  };
  if (!plane) return none;
  if (!(options.completedWithoutFailure
    ?? catchupPlaneCompletedWithoutFailure(plane, options.complete))) {
    // The peer answered and its round was not clean. A pure transport failure is
    // NOT that: we never heard from it, it is already counted in `failedPeers`,
    // and treating unreachable strangers as unresolved evidence would stop a
    // genuinely empty graph from ever settling on a lossy network.
    const answeredButUnresolved = (plane.failedPeers ?? 0) === 0;
    return answeredButUnresolved ? { ...none, incompleteResponders: 1 } : none;
  }
  // "The host says there is nothing here." Only the curator can say it: a
  // response is content-free either by being wire-empty or by carrying nothing
  // but `_meta`, and only the metadata-resolved curator's silence about data
  // means the graph has none. Any other peer's identical answer just means that
  // peer does not have it.
  const carriedNoData = (plane.insertedDataTriples ?? 0) === 0
    && (plane.fetchedDataTriples ?? 0) === 0;
  // Whose emptiness counts, and on which plane.
  //
  // DURABLE: the Context Graph is the curator's. `<cg>/_meta` carries its own
  // definition triples, so a curator serving them proves it hosts the graph, and
  // a curator with no data means the graph has none. Both wire-empty and
  // metadata-only rounds are hosted-empty evidence there.
  //
  // SHARED MEMORY: nobody's emptiness counts, not even the curator's. SWM is a
  // per-agent-address layered union (`<swm>/<addr>/<number>`) contributed by many
  // members, so a curator holding no SWM rows says nothing about the members'
  // layers — it does not own them. Letting it settle the plane skipped peers that
  // held valid rows and could report `sharedMemoryVerified` with
  // `sharedMemorySynced: 0`. An empty SWM plane is still provable, but only as a
  // WHOLE-ROUND verdict once every peer has answered, which is what
  // `catchupPlaneProvenByUnanimousEmpty` is for.
  //
  // Verified DATA from the curator still settles either plane. That is the
  // tradeoff this PR states openly — a peer's `complete` flag proves only its own
  // manifest, and the background reconciler remains the convergence mechanism —
  // and it is what keeps the amplification fixed for an SWM-heavy graph, which
  // issue #2006 measured at 122,705 fetched triples on the shared plane alone.
  const answered = options.plane !== 'shared-memory'
    && ((plane.emptyResponses ?? 0) > 0
      || (plane.metaOnlyResponses ?? 0) > 0
      || (plane.insertedMetaTriples ?? 0) > 0);
  return {
    verifiedDataPeers: (plane.insertedDataTriples ?? 0) > 0 ? 1 : 0,
    verifiedPrivateOnlyPeers: (plane.verifiedPrivateOnlyResponses ?? 0) > 0 ? 1 : 0,
    emptyPeers: (plane.emptyResponses ?? 0) > 0 ? 1 : 0,
    authorityEmptyPeers: options.fromAuthority && carriedNoData && answered ? 1 : 0,
  };
}

/** Fold one peer's evidence into the running per-plane totals. */
export function addCatchupPlaneEvidence(
  total: CatchupPlaneCompletionEvidence,
  peer: CatchupPlaneCompletionEvidence,
): void {
  total.verifiedDataPeers += peer.verifiedDataPeers;
  if (peer.verifiedPrivateOnlyPeers) {
    total.verifiedPrivateOnlyPeers = (total.verifiedPrivateOnlyPeers ?? 0)
      + peer.verifiedPrivateOnlyPeers;
  }
  if (peer.selectedScopeCompletePeers) {
    total.selectedScopeCompletePeers = (total.selectedScopeCompletePeers ?? 0)
      + peer.selectedScopeCompletePeers;
  }
  total.emptyPeers += peer.emptyPeers;
  if (peer.authorityEmptyPeers) {
    total.authorityEmptyPeers = (total.authorityEmptyPeers ?? 0) + peer.authorityEmptyPeers;
  }
  if (peer.incompleteResponders) {
    total.incompleteResponders = (total.incompleteResponders ?? 0) + peer.incompleteResponders;
  }
}

/**
 * Positive proof: some peer cleanly completed this plane while carrying
 * cryptographically verified content. This is the only evidence strong enough
 * to stop contacting further peers mid-run, because it is the only evidence a
 * single peer can produce on its own.
 */
export function catchupPlaneProvenByData(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.verifiedDataPeers ?? 0) > 0
    || (completion?.verifiedPrivateOnlyPeers ?? 0) > 0;
}

/**
 * Positive RFC-64 proof: an explicitly selected graph-complete SWM provider
 * reached the terminal boundary of the accepted public scope.
 *
 * This stays separate from `verifiedDataPeers`: a repeat run may prove the
 * exact same already-materialized scope while inserting zero new triples, and
 * calling that "verified data received" would corrupt the transfer telemetry.
 */
export function catchupPlaneProvenBySelectedScope(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.selectedScopeCompletePeers ?? 0) > 0;
}

/**
 * Does any signal in this round rule out an empty verdict outright?
 *
 * Shared by BOTH empty-proof modes below, because these are not "a peer that
 * failed" — they are evidence about the graph's contents that no peer's silence
 * can outrank.
 */
function emptyVerdictContradicted(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
): boolean {
  // Verified content, obviously.
  if (catchupPlaneProvenByData(completion)) return true;
  // Data that arrived and was rejected. A peer SERVED CONTENT for this graph
  // which then failed verification, so content exists even though we could not
  // keep it. `classifyDurableProgress` already treats these as blocking
  // failures per peer; this is the same rule applied to the round.
  if ((diagnostics?.dataRejectedMissingMeta ?? 0) > 0
    || (diagnostics?.rejectedKcs ?? 0) > 0) return true;
  // Data fetched anywhere in the round, whoever fetched it.
  return (diagnostics?.fetchedDataTriples ?? 0) > 0;
}

/**
 * Proof mode 1 — the CURATOR hosts the graph and it holds nothing.
 *
 * A registered public graph that really is empty still carries definition
 * triples in its own `<cg>/_meta`, so the peer hosting it answers
 * metadata-only, never wire-empty, and could never satisfy the whole-round rule
 * below. Its curator saying so is the only evidence such a graph can produce.
 *
 * Scoped to the metadata-resolved curator and nothing else. Any OTHER peer's
 * metadata-only round is the commonest state on the network — a member that has
 * `_meta` but has not synced the data yet — and accepting it would resettle
 * issue #2006's exact failure as `done` with zero Knowledge Assets.
 *
 * Another peer merely failing part-way cannot contradict the curator; another
 * peer producing CONTENT can, and that is what {@link emptyVerdictContradicted}
 * checks — it means the curator's view is behind the network's.
 */
export function catchupPlaneProvenByAuthorityHostedEmpty(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  // Private planes stay proof-by-content only: an authorized-but-filtered
  // response is indistinguishable from an empty one on this side of the wire.
  if (options.isPrivate) return false;
  if ((completion?.authorityEmptyPeers ?? 0) === 0) return false;
  return !emptyVerdictContradicted(completion, diagnostics);
}

/**
 * Proof mode 2 — a whole round in which nobody had anything.
 *
 * A peer that has never heard of a Context Graph and a peer that hosts an empty
 * one are byte-identical on the wire: an unknown CG has no access policy, so the
 * responder authorizes the request and its CG-scoped queries simply return zero
 * rows. The requester only reports `emptyResponses` when BOTH phase payloads are
 * empty (`sync-verify-worker-impl.ts`), so an empty response can never carry
 * hosting evidence — there is no per-peer signal that could distinguish the two.
 *
 * Emptiness is therefore a verdict over the whole round: some peer completed
 * cleanly empty, nobody delivered any graph CONTENT, and no peer engaged and
 * then failed part-way. That exact shape — 122,705 data triples fetched and
 * five failed phases, with five unrelated peers answering empty — is what
 * settled issue #2006's run as `done` with 1 KA out of 40, and either clause
 * kills it on its own.
 *
 * `metaOnlyResponses` also kills it. A non-curator that returned `_meta` and no
 * data is the ambiguous case this rule cannot resolve — the requester itself
 * logs "peer may have empty or pruned data graph" — and without the curator
 * present there is nothing to resolve it against. When the curator IS present,
 * proof mode 1 has already settled the plane, so voiding here costs the
 * legitimately-empty graph nothing.
 *
 * The verdict IS voided when the round had a resolvable curator that never
 * cleanly answered (`authorityUnanswered`). The peer best placed to know is the
 * one we failed to hear from, so "nobody had anything" is not established — the
 * round is incomplete, not empty. That closes issue #2006's own symptom in its
 * sharpest form: the walk puts a resolvable curator alone in wave 1, so when the
 * curator transport-fails the walk moves on to strangers, one answers empty, and
 * 40 Knowledge Assets get reported as zero.
 *
 * Scoped to the AUTHORITY rather than to `failedPeers`, and the difference is
 * load-bearing. `failedPeers` counts any unreachable peer, so voiding on it would
 * also kill the verdict when NO curator is resolvable at all — the state where
 * the hosted-empty backstop structurally cannot fire — leaving a legitimately
 * empty public graph pinned at `unreachable` by a single unreachable stranger.
 * That is the liveness failure this rule was originally written to avoid, and it
 * is still worth avoiding; it is only the curator's silence that is decisive.
 *
 * Two counters are deliberately NOT consulted:
 *
 * - `failedPeers`. A transport failure to a peer we never heard from, which on a
 *   live testnet can be most of the connected set. An unreachable STRANGER is
 *   evidence of nothing; an unreachable CURATOR is, and has its own signal above.
 * - `fetchedMetaTriples`. A raw triple count, not a per-peer verdict: a delta
 *   sync legitimately carries the whole metadata phase with nothing newer than
 *   the watermark, and the requester deliberately does NOT flag that as
 *   metadata-only. Voiding on the raw count would make a legitimately empty
 *   public graph permanently unreadable rather than merely unproven.
 * - `failedPeers`. That is a transport failure to a peer we never heard from —
 *   on a live testnet a majority of connected peers can be unreachable — and an
 *   unreachable stranger is evidence of nothing. A peer that DID engage and
 *   then failed shows up in `failedPhases` / `timedOutPhases` / `deniedPhases`
 *   / `deferredBackpressure`, all of which do void the verdict.
 *
 * Residual, unchanged from before this rule existed: if the only host is
 * unreachable while another peer answers cleanly empty, the round still reads
 * as empty. Readiness is re-derived on the next catch-up.
 */
export function catchupPlaneProvenByUnanimousEmpty(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  // Empty or metadata-only responses have never been able to prove that a
  // private graph is fully synchronized; that stays unchanged.
  if (options.isPrivate) return false;
  if (emptyVerdictContradicted(completion, diagnostics)) return false;
  // A non-curator that has `_meta` and no data cannot tell "the graph is empty"
  // from "I have not synced it yet". See the note above.
  if ((diagnostics?.metaOnlyResponses ?? 0) > 0) return false;
  // A peer that answered but did not finish paging leaves the round unresolved:
  // "nobody had anything" cannot be concluded while somebody's answer is still
  // half-delivered. This is not covered by the phase counters below — an
  // explicit `complete: false` is neither a failure nor a timeout — and it is
  // the one shape that survives `catchupPeerPlaneEvidence` erasing the peer to
  // an all-zero record.
  if ((completion?.incompleteResponders ?? 0) > 0) return false;
  // Completion evidence is PER-PEER and says explicitly whether that peer's
  // round was clean; `diagnostics.emptyResponses` is a raw aggregate that counts
  // an empty payload even when the peer's round was NOT complete. Where the
  // runner supplied completion evidence it is the whole truth for this plane, so
  // the aggregate must not re-admit a response the per-peer view already
  // excluded — otherwise an explicitly incomplete empty result proves the plane
  // ready. The aggregate is a fallback for legacy callers that carry no
  // completion evidence at all, never a second chance for callers that do.
  const cleanEmptyObserved = completion !== undefined
    ? (completion.emptyPeers ?? 0) > 0
    : (diagnostics?.emptyResponses ?? 0) > 0;
  if (!cleanEmptyObserved) return false;
  // The one peer whose silence is decisive. See the note above for why this is
  // scoped to the curator rather than to `failedPeers`.
  if (diagnostics?.authorityUnanswered) return false;
  return (diagnostics?.failedPhases ?? 0) === 0
    && (diagnostics?.timedOutPhases ?? 0) === 0
    && (diagnostics?.deniedPhases ?? 0) === 0
    && (diagnostics?.deferredBackpressure ?? 0) === 0;
}

/**
 * Canonical readiness proof for one catch-up plane: verified content, the
 * curator's hosted-empty word, or a whole round in which nobody had anything —
 * in that order of strength.
 *
 * The peer walk stops early only on {@link catchupPlaneProvenByData} or the
 * curator's own round, so whenever this falls through to the unanimous-empty
 * branch the full peer set really was walked and the "nobody saw anything"
 * denominator is meaningful.
 */
export function catchupPlaneReady(
  completion: CatchupPlaneCompletionEvidence | undefined,
  diagnostics: CatchupPlaneRoundDiagnostics | undefined,
  options: { isPrivate: boolean },
): boolean {
  return catchupPlaneProvenByData(completion)
    || catchupPlaneProvenBySelectedScope(completion)
    || catchupPlaneProvenByAuthorityHostedEmpty(completion, diagnostics, options)
    || catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
}
