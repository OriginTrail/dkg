import type {
  CatchupPassDecisionReason,
  ConfiguredContextGraphMetadataReconciliationResult,
  DKGAgent,
  SwmSnapshotCoverage,
} from '@origintrail-official/dkg-agent';
import { DKGEvent, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type {
  ContextGraphReadinessProvenance,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';
import {
  catchupPlaneCompletedWithoutFailure,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  catchupPlaneProvenBySelectedScope,
  catchupPlaneProvenByUnanimousEmpty,
  catchupPlaneReady,
  type CatchupJobResult,
  type CatchupPlaneCompletionEvidence,
} from './catchup-runner.js';

export { catchupPlaneCompletedWithoutFailure } from './catchup-runner.js';

export const CONTEXT_GRAPH_READINESS_VERSION = 1;

/**
 * Identifiers named in the terminal shortfall clause. The producer already caps
 * the sample; this bounds the SENTENCE independently, so a future producer
 * change cannot silently grow an operator-facing error string.
 */
const SWM_SHORTFALL_SAMPLE_LIMIT = 10;

/**
 * Rendered length of ONE identifier in that clause.
 *
 * Bounding the count is not enough: each identifier is a literal a public peer
 * put in its own SWM metadata, and the producer only trims it. Ten refs are ten
 * peer-chosen strings of any length.
 */
const SWM_SHORTFALL_REF_MAX_CHARS = 96;

/**
 * Make one peer-supplied snapshot ref safe to put in an operator-facing string.
 *
 * These identifiers are UNTRUSTED. They arrive as `dkg:publicSnapshotRef`
 * literals in a remote peer's shared-memory metadata, and the producer applies
 * only `.trim()`. Rendered verbatim into the terminal error — which surfaces
 * through the API and the node UI — a peer could:
 *
 *   - forge structure, e.g. a ref containing "\nSync denied by 3 remote peers",
 *     which reads as an additional line of our own diagnostics;
 *   - inflate the message without bound, which matters here specifically because
 *     oversized peer literals are a phenomenon this codebase has already met on
 *     the sync path, not a hypothetical.
 *
 * So: fold every C0/C1 control character (newlines and tabs included) to U+FFFD
 * rather than dropping it — dropping would let "a\nb" masquerade as the real ref
 * "ab" — then bound the length with a visible marker so a truncated identifier
 * cannot be mistaken for a complete one.
 *
 * Sanitising at the RENDERER is deliberate: it is the last point before the
 * string reaches an operator, so it holds regardless of which producer path
 * filled the sample or what a future one does.
 */
function sanitizeSnapshotRef(ref: string): string {
  const flattened = ref.replace(/[\u0000-\u001F\u007F-\u009F]/gu, '\uFFFD');
  return flattened.length > SWM_SHORTFALL_REF_MAX_CHARS
    ? `${flattened.slice(0, SWM_SHORTFALL_REF_MAX_CHARS)}\u2026(truncated)`
    : flattened;
}

/**
 * Why the continuation loop stopped, in operator-facing words.
 *
 * An exhaustive `Record` rather than a `switch` with a default: the vocabulary
 * is closed precisely so this message stays testable, and a new reason should
 * fail the build here rather than silently render nothing.
 *
 * `coverage-stalled` deliberately outranks `budget-exhausted` in the policy, so
 * a run that stalled AND ran out of time reports the stall. Its wording must
 * therefore never mention time: "ran out of time" would send an operator to
 * raise a budget that buys nothing, which is the precise misdirection that
 * precedence exists to prevent.
 */
const SWM_STOP_REASON_TEXT: Record<CatchupPassDecisionReason, string> = {
  // Not a stop at all — the loop was still willing to continue.
  continue: '',
  'plane-proven': 'the plane was proven by another peer',
  'coverage-stalled': 'a further pass stopped making progress, so more passes would not help',
  'no-capable-peers': 'no remaining peer reported holding the missing snapshots',
  'max-passes-reached': 'the pass limit was reached',
  'budget-exhausted': 'the time budget was exhausted',
};

/**
 * The shared-memory shortfall clause appended to the incomplete-progress
 * terminal message.
 *
 * Every figure comes from ONE {@link SwmSnapshotCoverage} record — the counts,
 * the peer they are attributed to, and the sample — so the sentence can never
 * describe a graph state no peer reported, and the named Knowledge Assets
 * always belong to the manifest the counts came from.
 *
 * Returns `''` whenever there is nothing to add, which is what keeps the base
 * sentence byte-identical on every other path: no snapshot inventory was
 * observed, or the selected manifest was fully retrieved AND fully written — in
 * which case the shortfall lies on another plane, and reporting "0 outstanding"
 * beside an `unreachable` verdict would misdirect the reader.
 */
export function swmShortfallClause(
  coverage: SwmSnapshotCoverage | undefined,
  continuationPasses: number | undefined,
  stopReason?: CatchupPassDecisionReason,
): string {
  if (!coverage) return '';
  // `missingCount` is MATERIALIZATION completeness, not fetch completeness: the
  // producer derives it as `snapshotsTotal - min(materializedRefCount, total)`,
  // so a ref that was fetched and digest-verified but failed to write to the
  // store raises it exactly like a ref that never arrived. The two are NOT
  // independent axes and must never be added together — `missingCount` already
  // includes every unwritten ref.
  //
  // `materializationFailures` is kept as the CAUSE indicator: it says the
  // shortfall is a store problem rather than a network one, which is the whole
  // reason the distinction is worth printing. It counts failing DESCRIPTORS
  // while `missingCount` counts REFS, so the two are not in the same unit and
  // neither is a subset count of the other — phrase them as separate facts, and
  // never as "N of which".
  // Defaulted, not trusted: this record crosses a worker RPC boundary, and an
  // absent counter must read as "none known" rather than making `<= 0` false
  // and forcing a clause onto a round with nothing to report.
  const failedToWrite = coverage.materializationFailures ?? 0;
  if (coverage.missingCount <= 0 && failedToWrite <= 0) return '';

  // `continuationPasses` counts the REPEATS, so the walk itself is one more.
  const passes = (continuationPasses ?? 0) + 1;
  // Sanitized per identifier, not merely capped in count. See
  // `sanitizeSnapshotRef`: these are untrusted peer literals. Mapping after the
  // slice keeps `unnamed` arithmetic on the SAMPLE COUNT, which sanitizing
  // cannot change — so the "(+N more)" accounting is unaffected by construction.
  const sample = coverage.missingSample
    .slice(0, SWM_SHORTFALL_SAMPLE_LIMIT)
    .map(sanitizeSnapshotRef);
  const unnamed = coverage.missingCount - sample.length;
  const named = sample.length > 0
    ? `, including ${sample.join(', ')}${unnamed > 0 ? ` (+${unnamed} more)` : ''}`
    : '';
  // Reported as separate clauses because they send an operator to different
  // places: the outstanding count is what is still missing locally, the write
  // failures say the store is why. Conflating them wastes the hour the
  // stop-reason wording exists to save.
  //
  // "not materialized", NOT "not retrieved": these refs are the ones absent from
  // the local store, and under a store fault they were fetched and digest-valid
  // before they failed. Naming a ref that arrived intact as "not retrieved"
  // sends the reader to the network and the peer set when the fault is entirely
  // local — the one misdirection this clause exists to prevent.
  const outstanding = coverage.missingCount > 0
    ? ` ${coverage.missingCount} not materialized${named}`
    : '';
  const writes = failedToWrite > 0
    ? `${outstanding ? ';' : ''} ${failedToWrite} store write failure(s)`
    : '';
  // An incomplete manifest means the denominator is only what this peer managed
  // to advertise before its metadata phase ran out, not what the graph holds —
  // presenting it as the total would understate the shortfall. It is also why
  // this peer got no further passes: the capability gate requires a complete
  // manifest, because a truncated round advances `snapshotsResolved` against a
  // truncated denominator while materializing nothing. Both facts belong here;
  // "the count is a lower bound" and "we stopped asking" are different things
  // for the person reading it.
  const lowerBound = coverage.manifestComplete
    ? ''
    : ` The peer's snapshot manifest was itself incomplete, so ${coverage.snapshotsTotal}`
      + ' is a lower bound and that peer was not retried.';
  // Absent whenever the continuation loop did not run — shared memory was not
  // requested, or no decision was reached.
  const stopped = stopReason && SWM_STOP_REASON_TEXT[stopReason]
    ? ` Continuation stopped because ${SWM_STOP_REASON_TEXT[stopReason]}.`
    : '';

  // Scoped to "Shared memory" throughout: continuation passes repeat the
  // shared-memory peer walk only, and the wording must not suggest the durable
  // plane was retried.
  // "materialized", NOT "fetched": `snapshotsResolved` counts refs whose
  // Knowledge Assets are WRITTEN and locally visible, not refs sitting valid in
  // the blob cache. Rendering it as "fetched" reported "250/250 snapshots
  // fetched" on a graph where every write failed and nothing landed — the
  // flattering direction, and undetectable by the reader. The word has to track
  // the producer: `snapshotsResolved` was redefined to mean materialized so the
  // capability gate could not be fooled by a cached-but-unwritten round, and
  // this sentence is the same number's operator-facing face.
  return ` (Shared memory: ${coverage.snapshotsResolved}/${coverage.snapshotsTotal}`
    + ` snapshots materialized from peer …${coverage.peerIdSuffix}`
    + ` after ${passes} ${passes === 1 ? 'pass' : 'passes'};`
    + `${outstanding}${writes}.)${lowerBound}${stopped}`;
}

export type ContextGraphReadinessStore = Pick<
  DashboardDB,
  'getContextGraphReadinessProvenance' | 'setContextGraphReadinessProvenance'
>;

export interface ContextGraphSubscriptionReadinessState {
  synced?: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  pendingMeta?: boolean;
}

export interface ContextGraphSubscriptionStatePatch {
  synced: boolean;
  sharedMemorySynced: boolean;
  metaSynced: boolean;
  pendingMeta: boolean;
}

export interface ContextGraphReadinessPatch {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
}

export interface MissingMetadataReadinessPatches {
  statePatch: ContextGraphSubscriptionStatePatch;
  readinessPatch: ContextGraphReadinessPatch;
}

/** Canonical fail-closed state for a graph without authoritative metadata. */
export function missingMetadataReadinessPatches(): MissingMetadataReadinessPatches {
  return {
    statePatch: {
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    },
    readinessPatch: {
      durableVerified: false,
      sharedMemoryVerified: false,
    },
  };
}

interface ContextGraphPlaneReadinessVerdict {
  /** Compatibility/write-readiness: either persisted usable plane opens the graph. */
  readonly writeReady: boolean;
  /** Catch-up completion: durable VM plus SWM when the caller requested it. */
  readonly requestedPlanesVerified: boolean;
  readonly missingRequestedDurable: boolean;
  readonly missingRequestedSharedMemory: boolean;
}

function contextGraphPlaneReadinessVerdict(input: {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
  includeSharedMemory: boolean;
}): ContextGraphPlaneReadinessVerdict {
  const missingRequestedDurable = !input.durableVerified;
  const missingRequestedSharedMemory =
    input.includeSharedMemory && !input.sharedMemoryVerified;
  return {
    writeReady: input.durableVerified || input.sharedMemoryVerified,
    requestedPlanesVerified:
      !missingRequestedDurable && !missingRequestedSharedMemory,
    missingRequestedDurable,
    missingRequestedSharedMemory,
  };
}

export function classifyExistingContextGraphReadiness(input: {
  subscription: ContextGraphSubscriptionReadinessState;
  readiness: ContextGraphReadinessProvenance;
  includeSharedMemory: boolean;
  hasConfirmedMeta: boolean;
}): {
  alreadyReady: boolean;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
} {
  const currentReadinessProvenance =
    input.readiness.version >= CONTEXT_GRAPH_READINESS_VERSION;
  const durableVerified =
    currentReadinessProvenance && input.readiness.durableVerified;
  const sharedMemoryVerified =
    currentReadinessProvenance && input.readiness.sharedMemoryVerified;
  const planeReadiness = contextGraphPlaneReadinessVerdict({
    durableVerified,
    sharedMemoryVerified,
    includeSharedMemory: input.includeSharedMemory,
  });
  const alreadyReady =
    input.hasConfirmedMeta &&
    planeReadiness.requestedPlanesVerified &&
    input.subscription.synced === true &&
    (!input.includeSharedMemory || input.subscription.sharedMemorySynced === true);

  if (alreadyReady) return { alreadyReady: true };

  if (!input.hasConfirmedMeta) {
    const missingMetadata = missingMetadataReadinessPatches();
    const stateAlreadyFailClosed =
      input.subscription.synced === false &&
      input.subscription.sharedMemorySynced === false &&
      input.subscription.metaSynced === false &&
      input.subscription.pendingMeta === true;
    return {
      alreadyReady: false,
      statePatch: stateAlreadyFailClosed
        ? undefined
        : missingMetadata.statePatch,
      // Subscription flags and provenance are persisted independently. A
      // prior bootstrap may already have reset the flags while leaving v1
      // proof behind, so metadata absence must invalidate provenance even
      // when the visible state is already fail-closed.
      readinessPatch: missingMetadata.readinessPatch,
    };
  }

  const statePatch =
    input.subscription.synced !== planeReadiness.writeReady ||
    input.subscription.sharedMemorySynced !== sharedMemoryVerified
      ? {
          synced: planeReadiness.writeReady,
          sharedMemorySynced: sharedMemoryVerified,
          metaSynced: true,
          pendingMeta: false,
        }
      : undefined;

  return {
    alreadyReady: false,
    statePatch,
    readinessPatch: currentReadinessProvenance
      ? undefined
      : {
          durableVerified: false,
          sharedMemoryVerified: false,
        },
  };
}

function catchupServedUsableData(result: CatchupJobResult): boolean {
  return result.dataSynced > 0 || result.sharedMemorySynced > 0;
}

/**
 * Did ANY peer complete this plane cleanly, whatever it carried?
 *
 * Every carrier of clean-completion evidence must be listed here, not just the
 * ones that prove readiness: this predicate gates the denial and no-response
 * branches that run BEFORE `catchupPlaneReady` is ever consulted, so a form of
 * evidence missing from it is silently unreachable. The curator's hosted-empty
 * round is the newest carrier and is exactly that shape — no data, no wire-empty
 * response, and still a clean answer from the one peer that speaks for the graph.
 */
function cleanCompletionHasResponse(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.verifiedDataPeers ?? 0) > 0 ||
    (completion?.verifiedPrivateOnlyPeers ?? 0) > 0 ||
    (completion?.selectedScopeCompletePeers ?? 0) > 0 ||
    (completion?.emptyPeers ?? 0) > 0 ||
    (completion?.authorityEmptyPeers ?? 0) > 0;
}

function catchupHasRequestedCleanPeerResponse(
  result: CatchupJobResult,
  includeSharedMemory: boolean,
): boolean {
  return cleanCompletionHasResponse(result.cleanPlaneCompletions?.durable) ||
    (
      includeSharedMemory &&
      cleanCompletionHasResponse(result.cleanPlaneCompletions?.sharedMemory)
    );
}

export function catchupResultHasCleanResponse(result: CatchupJobResult): boolean {
  const durable = result.diagnostics?.durable;
  const sharedMemory = result.diagnostics?.sharedMemory;
  const peerReturnedMetadata =
    (durable?.metaOnlyResponses ?? 0) > 0 ||
    (durable?.fetchedMetaTriples ?? 0) > 0 ||
    (sharedMemory?.fetchedMetaTriples ?? 0) > 0;

  return cleanCompletionHasResponse(result.cleanPlaneCompletions?.durable) ||
    cleanCompletionHasResponse(result.cleanPlaneCompletions?.sharedMemory) ||
    catchupServedUsableData(result) ||
    (durable?.emptyResponses ?? 0) > 0 ||
    (sharedMemory?.emptyResponses ?? 0) > 0 ||
    (!result.denied && peerReturnedMetadata);
}

interface CatchupPlaneReadinessThisRun {
  /** Whether this plane counts as ready for THIS run's reported job status. */
  ready: boolean;
  /**
   * Whether the evidence is strong enough to PERSIST as sticky readiness
   * provenance.
   *
   * Readiness provenance is carried forward by an OR against
   * `readinessBeforeCatchup`, so anything recorded here is permanent for the
   * subscription. Verified content earns it outright, as does the curator's own
   * word that it hosts an empty graph.
   *
   * A unanimous-empty round earns it only when the round was FULLY ACCOUNTED:
   * every peer the walk attempted actually answered (`failedPeers === 0`).
   * Emptiness is a verdict derived from ABSENCE of evidence, so it is only as
   * good as the denominator it was taken over — with peers unaccounted for and
   * no authoritative curator to anchor it, a single unrelated empty response
   * produces the same verdict as a genuinely empty graph.
   *
   * Splitting it this way keeps both properties that pulled against each other:
   *
   * - LIVENESS. The per-run verdict is unchanged, so a graph on a lossy network
   *   still reports `done` instead of retrying forever. Failing the verdict
   *   itself closed on unaccounted peers was rejected for exactly that reason.
   * - NO FROZEN GUESS. Nothing derived from a partial round is written down, so
   *   a wrong empty verdict cannot outlive the run that produced it.
   *
   * This bit is what `statePatch.synced` is built from, and `synced` gates
   * write preflight (`contextGraphRowIsWritable`), so anything admitted here
   * grants durable readiness to consumers that never see the job result.
   */
  persistable: boolean;
}

function catchupPlaneReadinessThisRun(input: {
  result: CatchupJobResult;
  plane: 'durable' | 'sharedMemory';
  isPrivate: boolean;
}): CatchupPlaneReadinessThisRun {
  const diagnostics = input.result.diagnostics?.[input.plane];
  const completion = input.result.cleanPlaneCompletions?.[input.plane];
  const options = { isPrivate: input.isPrivate };
  // Every attempted peer answered, so the empty verdict was taken over the
  // whole peer set rather than over whoever happened to reply.
  const fullyAccounted = (diagnostics?.failedPeers ?? 0) === 0;
  if (completion) {
    const provenPositively = catchupPlaneProvenByData(completion)
      || catchupPlaneProvenBySelectedScope(completion)
      || catchupPlaneProvenByAuthorityHostedEmpty(completion, diagnostics, options);
    const unanimousEmpty = catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
    return {
      ready: provenPositively || unanimousEmpty,
      persistable: provenPositively || (unanimousEmpty && fullyAccounted),
    };
  }

  // Backward compatibility for callers that construct a legacy result (for
  // example, an older in-process runner during a rolling upgrade). New worker
  // results always carry cleanPlaneCompletions, so aggregate failures are not
  // used as readiness evidence on the production path. The same fail-closed
  // rule applies: aggregate counters can show that SOMEBODY answered empty, but
  // only a content-free, failure-free round proves the plane really is empty.
  const dataProgress = input.plane === 'durable'
    ? input.result.dataSynced > 0 ||
      (input.result.diagnostics?.durable.verifiedPrivateOnlyResponses ?? 0) > 0
    : input.result.sharedMemorySynced > 0;
  if (catchupPlaneCompletedWithoutFailure(diagnostics) && dataProgress) {
    return { ready: true, persistable: true };
  }
  // Pass NO completion evidence rather than an all-zero stand-in: the empty
  // proof consults the raw aggregate counters only when completion evidence is
  // genuinely absent, and a synthetic `emptyPeers: 0` would read as "the
  // per-peer view saw no clean empty response" and suppress the legacy path.
  const ready = catchupPlaneReady(undefined, diagnostics, options);
  return {
    ready,
    // No completion evidence means neither positive proof mode can fire, so
    // anything true here came from the aggregate empty counter and is subject
    // to the same fully-accounted requirement.
    persistable: ready && fullyAccounted,
  };
}

export interface ContextGraphCatchupReadinessClassification {
  jobStatus: 'done' | 'failed' | 'denied' | 'partial' | 'unreachable';
  error?: string;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
  eventPayload?: {
    dataSynced: number;
    sharedMemorySynced: number;
    verifiedPrivateOnlyResponses: number;
  };
}

/**
 * Canonical policy for converting one catch-up result into externally visible
 * subscription readiness. The HTTP route gathers live metadata and applies
 * the returned patches; all readiness decisions remain in this pure function.
 */
export function classifyContextGraphCatchupReadiness(input: {
  result: CatchupJobResult;
  includeSharedMemory: boolean;
  hasConfirmedMeta: boolean;
  isPrivate: boolean;
  readinessBeforeCatchup: ContextGraphReadinessProvenance;
}): ContextGraphCatchupReadinessClassification {
  const { result } = input;
  const durableDataProgress = result.dataSynced > 0;
  const sharedMemoryProgress = result.sharedMemorySynced > 0;
  const servedUsableData = durableDataProgress || sharedMemoryProgress;
  const totalConnectedPeers = result.totalPeers ?? result.connectedPeers;
  const selectedConnectedPeers = result.selectedPeers ?? result.connectedPeers;
  const hasRequestedCleanPeerResponse = catchupHasRequestedCleanPeerResponse(
    result,
    input.includeSharedMemory,
  );

  if (result.denied && !servedUsableData && !hasRequestedCleanPeerResponse) {
    return {
      jobStatus: 'denied',
      error: result.deniedPeers > 1
        ? `Sync denied by ${result.deniedPeers} remote peers`
        : 'Sync denied by remote peer',
    };
  }

  if (catchupResultHasCleanResponse(result)) {
    if (!input.hasConfirmedMeta) {
      const missingMetadata = missingMetadataReadinessPatches();
      return {
        jobStatus: 'unreachable',
        error: 'No peer delivered authoritative context-graph metadata — the curator may be offline, or responding peers do not host this project.',
        ...missingMetadata,
      };
    }

    const durableThisRun = catchupPlaneReadinessThisRun({
      result,
      plane: 'durable',
      isPrivate: input.isPrivate,
    });
    const sharedMemoryThisRun = input.includeSharedMemory
      ? catchupPlaneReadinessThisRun({
        result,
        plane: 'sharedMemory',
        isPrivate: input.isPrivate,
      })
      : { ready: false, persistable: false };
    const durableReadyThisRun = durableThisRun.ready;
    const sharedMemoryReadyThisRun = sharedMemoryThisRun.ready;
    const currentReadinessProvenance =
      input.readinessBeforeCatchup.version >= CONTEXT_GRAPH_READINESS_VERSION;
    const durableVerifiedBefore =
      currentReadinessProvenance && input.readinessBeforeCatchup.durableVerified;
    const sharedMemoryVerifiedBefore =
      currentReadinessProvenance && input.readinessBeforeCatchup.sharedMemoryVerified;
    const durableVerified = durableVerifiedBefore || durableReadyThisRun;
    const sharedMemoryVerified = sharedMemoryVerifiedBefore || sharedMemoryReadyThisRun;
    // What this run is allowed to FREEZE, as opposed to what it reports. These
    // diverge only for a unanimous-empty verdict, which stays re-derived per run
    // so that a wrong empty verdict cannot become permanent.
    const durableVerifiedPersisted = durableVerifiedBefore || durableThisRun.persistable;
    const sharedMemoryVerifiedPersisted =
      sharedMemoryVerifiedBefore || sharedMemoryThisRun.persistable;
    // `subscription.synced` is a SECOND persisted readiness bit, living outside
    // the provenance store and consumed by callers that never see this job's
    // result — `contextGraphRowIsWritable` treats `subscribed && synced` as
    // writable. It must therefore carry the same verdict as `readinessPatch`,
    // not the transient one. The pre-catch-up path already assumes they agree:
    // it derives `synced` from the persisted provenance and patches the row
    // back into line, so letting them diverge here would be corrected away on
    // the next pass anyway — after a window in which the graph looked writable.
    const persistedPlaneReadiness = contextGraphPlaneReadinessVerdict({
      durableVerified: durableVerifiedPersisted,
      sharedMemoryVerified: sharedMemoryVerifiedPersisted,
      includeSharedMemory: input.includeSharedMemory,
    });
    // Use the same requested-plane contract as the pre-catch-up fast path so
    // SWM-only provenance can never synthesize or terminate a `done` job while
    // finalized VM remains unverified.
    const planeReadiness = contextGraphPlaneReadinessVerdict({
      durableVerified,
      sharedMemoryVerified,
      includeSharedMemory: input.includeSharedMemory,
    });
    const {
      missingRequestedDurable,
      missingRequestedSharedMemory,
    } = planeReadiness;
    const madeIncompleteProgress =
      (durableDataProgress && !durableReadyThisRun) ||
      (sharedMemoryProgress && !sharedMemoryReadyThisRun);

    let jobStatus: ContextGraphCatchupReadinessClassification['jobStatus'] = 'done';
    let error: string | undefined;
    if (missingRequestedDurable || missingRequestedSharedMemory) {
      jobStatus = 'unreachable';
      if (madeIncompleteProgress) {
        jobStatus = 'partial';
        // This terminal describes only the bounded foreground job. Selected
        // RFC-64 continuation has its own graph-level lifecycle and can keep
        // advancing after this job exhausts its budget.
        error = 'Verified data was inserted, but this bounded catch-up job ended before the requested plane was complete. The incomplete plane remains unready; graph-level synchronization may continue independently.'
          + swmShortfallClause(
            result.diagnostics?.sharedMemory?.swmCoverage,
            result.diagnostics?.sharedMemory?.continuationPasses,
            result.diagnostics?.sharedMemory?.continuationStopReason,
          );
      } else if (input.isPrivate && missingRequestedDurable && !sharedMemoryVerified) {
        error = 'No authorized context-graph peer delivered verified durable or shared-memory data — empty or metadata-only responses cannot prove a private graph is fully synchronized, and the curator may be offline.';
      } else if (input.isPrivate && missingRequestedDurable) {
        error = 'Shared-memory context-graph data synchronized, but durable VM catch-up did not complete. Retry to finish finalized VM synchronization.';
      } else if (input.isPrivate) {
        error = 'Durable context-graph data synchronized, but shared-memory catch-up did not complete. Retry to finish shared-memory synchronization.';
      } else {
        error = 'Context-graph catch-up did not complete cleanly for every requested data plane. Retry once the network is healthier.';
      }
    }

    return {
      jobStatus,
      error,
      statePatch: {
        synced: persistedPlaneReadiness.writeReady,
        sharedMemorySynced: sharedMemoryVerifiedPersisted,
        metaSynced: true,
        pendingMeta: false,
      },
      readinessPatch: {
        durableVerified: durableVerifiedPersisted,
        sharedMemoryVerified: sharedMemoryVerifiedPersisted,
      },
      eventPayload: durableReadyThisRun || sharedMemoryReadyThisRun
        ? {
            dataSynced: durableReadyThisRun ? result.dataSynced : 0,
            sharedMemorySynced: sharedMemoryReadyThisRun
              ? result.sharedMemorySynced
              : 0,
            verifiedPrivateOnlyResponses: durableReadyThisRun
              ? result.cleanPlaneCompletions?.durable.verifiedPrivateOnlyPeers
                ?? result.diagnostics?.durable.verifiedPrivateOnlyResponses
                ?? 0
              : 0,
          }
        : undefined,
    };
  }

  if (result.peersTried > 0 && (result.peersResponded ?? result.peersSucceeded) === 0) {
    return {
      jobStatus: 'unreachable',
      error: "No peer could deliver this project's data — the curator may be offline, or no node currently holds the data. You can still send a signed join request; they will receive it next time they come online.",
    };
  }
  if (result.peersTried > 0) {
    return {
      jobStatus: 'failed',
      error: 'Sync did not complete — all reachable peers failed (timeouts or transport errors). Retry once the network is healthier.',
    };
  }
  if (
    totalConnectedPeers > 0 &&
    selectedConnectedPeers >= totalConnectedPeers &&
    result.syncCapablePeers === 0
  ) {
    return {
      jobStatus: 'unreachable',
      error: 'No sync-capable peers found for catch-up — the curator may be offline.',
    };
  }
  if (totalConnectedPeers === 0) {
    return {
      jobStatus: 'unreachable',
      error: "No peers connected — couldn't reach the curator. They may be offline, or your node hasn't bootstrapped to the network yet.",
    };
  }

  return { jobStatus: 'done' };
}

export function readContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
): ContextGraphReadinessProvenance {
  const stored = store.getContextGraphReadinessProvenance?.(contextGraphId);
  return stored ?? {
    version: 0,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 0,
  };
}

export function writeContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  readiness: Pick<ContextGraphReadinessProvenance, 'durableVerified' | 'sharedMemoryVerified'>,
): void {
  store.setContextGraphReadinessProvenance?.(contextGraphId, {
    version: CONTEXT_GRAPH_READINESS_VERSION,
    durableVerified: readiness.durableVerified,
    sharedMemoryVerified: readiness.sharedMemoryVerified,
  });
}

// Bootstrap invalidation and automatic PROJECT_SYNCED persistence can race
// during daemon startup. Serialize both against the same agent/CG key so the
// later operation always revalidates live metadata before it writes.
const contextGraphReadinessMutationTails = new WeakMap<
  DKGAgent,
  Map<string, Promise<void>>
>();

async function withContextGraphReadinessMutationLock<T>(
  agent: DKGAgent,
  contextGraphId: string,
  task: () => Promise<T>,
): Promise<T> {
  let tails = contextGraphReadinessMutationTails.get(agent);
  if (!tails) {
    tails = new Map<string, Promise<void>>();
    contextGraphReadinessMutationTails.set(agent, tails);
  }
  const previous = tails.get(contextGraphId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(contextGraphId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(contextGraphId) === tail) tails.delete(contextGraphId);
  }
}

export type { ConfiguredContextGraphMetadataReconciliationResult };

/**
 * Repair, classify, and persist configured-graph readiness under one lock.
 * PROJECT_SYNCED persistence uses the same lock, so a newer authoritative
 * proof either wins before this operation classifies live state or runs after
 * its reset and restores readiness.
 */
export async function reconcileConfiguredContextGraphMetadata(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
}): Promise<ConfiguredContextGraphMetadataReconciliationResult> {
  const contextGraphId = input.contextGraphId.trim();
  if (!contextGraphId) {
    return {
      outcome: 'pending',
      reason: 'missing-metadata',
      repair: { status: 'failed', detail: 'Context graph id is empty' },
    };
  }

  return withContextGraphReadinessMutationLock(input.agent, contextGraphId, async () => {
    const reconciliation = await input.agent.reconcileConfiguredContextGraphMetadata(
      contextGraphId,
    );
    if (reconciliation.outcome === 'authoritative') {
      const subscription = input.agent.getSubscribedContextGraphs().get(contextGraphId);
      if (subscription?.metaSynced !== true || subscription.pendingMeta === true) {
        input.agent.markContextGraphSubscriptionState(contextGraphId, {
          metaSynced: true,
          pendingMeta: false,
        });
      }
      return reconciliation;
    }

    const patches = missingMetadataReadinessPatches();
    input.agent.markContextGraphSubscriptionState(contextGraphId, patches.statePatch);
    writeContextGraphReadiness(input.store, contextGraphId, patches.readinessPatch);
    return reconciliation;
  });
}

/**
 * Persist readiness proven by the agent's automatic post-approval catch-up.
 * PROJECT_SYNCED is also used as a UI event, so fail closed unless it carries
 * actual inserted data or a cryptographically verified private-only response,
 * and the graph's authoritative metadata is present.
 */
export async function persistProjectSyncedReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
  verifiedPrivateOnlyResponses?: number;
}): Promise<boolean> {
  const contextGraphId = input.contextGraphId.trim();
  const verifiedPrivateOnlyResponses = input.verifiedPrivateOnlyResponses ?? 0;
  const durableCompleted = (Number.isFinite(input.dataSynced) && input.dataSynced > 0) || (
    Number.isFinite(verifiedPrivateOnlyResponses)
    && verifiedPrivateOnlyResponses > 0
  );
  const sharedMemoryCompleted = Number.isFinite(input.sharedMemorySynced) &&
    input.sharedMemorySynced > 0;
  if (
    !contextGraphId ||
    (!durableCompleted && !sharedMemoryCompleted) ||
    typeof input.store.setContextGraphReadinessProvenance !== 'function'
  ) return false;

  return withContextGraphReadinessMutationLock(input.agent, contextGraphId, async () => {
    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(
      contextGraphId,
      { rejectUnregisteredPlaceholder: true },
    ).catch(() => false);
    if (!hasConfirmedMeta) return false;

    const current = readContextGraphReadiness(input.store, contextGraphId);
    const currentVersionVerified = current.version >= CONTEXT_GRAPH_READINESS_VERSION;
    writeContextGraphReadiness(input.store, contextGraphId, {
      durableVerified: durableCompleted ||
        (currentVersionVerified && current.durableVerified),
      sharedMemoryVerified: sharedMemoryCompleted ||
        (currentVersionVerified && current.sharedMemoryVerified),
    });
    return true;
  });
}

export interface ProjectSyncedReadinessPayload {
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
  verifiedPrivateOnlyResponses: number;
}

export function parseProjectSyncedReadinessPayload(
  data: unknown,
): ProjectSyncedReadinessPayload | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<ProjectSyncedReadinessPayload>;
  if (
    typeof candidate.contextGraphId !== 'string' ||
    typeof candidate.dataSynced !== 'number' ||
    !Number.isFinite(candidate.dataSynced) ||
    typeof candidate.sharedMemorySynced !== 'number' ||
    !Number.isFinite(candidate.sharedMemorySynced) ||
    (
      candidate.verifiedPrivateOnlyResponses !== undefined
      && (
        typeof candidate.verifiedPrivateOnlyResponses !== 'number'
        || !Number.isFinite(candidate.verifiedPrivateOnlyResponses)
      )
    )
  ) {
    return null;
  }
  return {
    contextGraphId: candidate.contextGraphId,
    dataSynced: candidate.dataSynced,
    sharedMemorySynced: candidate.sharedMemorySynced,
    verifiedPrivateOnlyResponses: candidate.verifiedPrivateOnlyResponses ?? 0,
  };
}

export function registerProjectSyncedReadinessPersistence(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  log: (message: string) => void;
}): void {
  input.agent.eventBus.on(DKGEvent.PROJECT_SYNCED, (data: unknown) => {
    const payload = parseProjectSyncedReadinessPayload(data);
    if (!payload) return;
    void persistProjectSyncedReadiness({
      agent: input.agent,
      store: input.store,
      ...payload,
    }).catch((err) => {
      input.log(
        `[warn] Failed to persist PROJECT_SYNCED readiness: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}

/**
 * One-time migration for subscription flags written before readiness carried
 * durable per-plane proof. Private/unconfirmed rows fail closed and must
 * complete a new catch-up. Confirmed public rows retain historical clean-empty
 * compatibility and receive provenance matching their already-persisted bits.
 */
export async function migrateLegacyContextGraphReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  log: (message: string) => void;
}): Promise<void> {
  const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

  for (const [contextGraphId, subscription] of input.agent.getSubscribedContextGraphs()) {
    if (systemContextGraphs.has(contextGraphId)) continue;
    const stored = readContextGraphReadiness(input.store, contextGraphId);
    if (stored.version >= CONTEXT_GRAPH_READINESS_VERSION) continue;

    // A locally curated graph is authoritative on this node, so its existing
    // flags can seed provenance. Remote membership proves authorization, not
    // that either data plane completed cleanly, and therefore cannot preserve
    // legacy readiness bits.
    const locallyCurated = typeof input.agent.isCuratorOf === 'function'
      ? await input.agent.isCuratorOf(contextGraphId).catch(() => false)
      : false;
    if (locallyCurated) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(
        `Preserved locally curated context-graph readiness during provenance migration: ${contextGraphId}`,
      );
      continue;
    }

    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(contextGraphId)
      .catch(() => false);
    const locallyPrivate = hasConfirmedMeta
      ? await input.agent.isPrivateContextGraph(contextGraphId).catch(() => true)
      : true;
    const onChainPolicy = typeof input.agent.getContextGraphOnChainPolicy === 'function'
      ? await input.agent.getContextGraphOnChainPolicy(contextGraphId).catch(() => ({}))
      : {};
    const chainPrivate = (onChainPolicy as { accessPolicy?: number }).accessPolicy === 1;
    const confirmedPublic = !chainPrivate && hasConfirmedMeta && !locallyPrivate;

    if (confirmedPublic) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(`Preserved confirmed public context-graph readiness during provenance migration: ${contextGraphId}`);
      continue;
    }

    const authoritativePrivateMeta = hasConfirmedMeta && locallyPrivate;
    input.agent.markContextGraphSubscriptionState(contextGraphId, {
      synced: false,
      sharedMemorySynced: false,
      metaSynced: authoritativePrivateMeta,
      pendingMeta: !authoritativePrivateMeta,
    });
    writeContextGraphReadiness(input.store, contextGraphId, {
      durableVerified: false,
      sharedMemoryVerified: false,
    });
    input.log(`Reset legacy unproven context-graph readiness: ${contextGraphId}`);
  }
}
