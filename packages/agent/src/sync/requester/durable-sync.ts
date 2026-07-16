import {
  parseDeterministicKnowledgeAssetUal,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { PhaseCallback } from '@origintrail-official/dkg-publisher';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import { packKnowledgeAssetIdFromIdentity } from '../../ka-identity.js';
import { planBoundedGraphScopedDurableBatch } from '../durable-integrity.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncPermanentRejection, isSyncTransportFailure } from '../error-tags.js';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import type { SyncPageResult } from './page-fetch.js';
import type {
  GraphScopedMaterializationOutcome,
  VerifiedGraphScopedAsset,
} from './graph-scoped-materialization.js';

const DKG_NS = 'http://dkg.io/ontology/';
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
const BATCH_ID = `${DKG_NS}batchId`;
const MATERIALIZED_VERSION = `${DKG_NS}materializedVersion`;
const TRANSACTION_HASH = `${DKG_NS}transactionHash`;
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const PEER_UNTRUSTED_METADATA_PREDICATES = new Set([
  MATERIALIZED_VERSION,
  `${DKG_NS}accessPolicy`,
  `${DKG_NS}allowedPeer`,
  `${DKG_NS}publisherPeerId`,
  `${DKG_NS}status`,
]);
const GRAPH_SCOPED_SYNC_METADATA_PREDICATES = new Set([
  `${DKG_NS}merkleRoot`,
  `${DKG_NS}contentScopeVersion`,
  `${DKG_NS}kaUal`,
  ASSERTION_VERSION,
  `${DKG_NS}publicTripleCount`,
  `${DKG_NS}privateTripleCount`,
  `${DKG_NS}privateMerkleRoot`,
  ASSERTION_GRAPH,
  `${DKG_NS}contextGraph`,
  `${DKG_NS}subGraphName`,
  TRANSACTION_HASH,
]);

export interface DurableSyncSummary {
  insertedTriples: number;
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  deniedPhases: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  verifiedPrivateOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures: number;
  /** Context Graph admissions deferred by local scheduler pressure. */
  deferredBackpressure: number;
}

/** Graph inventory from one clean, complete legacy full snapshot. */
export interface VerifiedFullSnapshot {
  contextGraphId: string;
  verifiedDataGraphs: ReadonlySet<string>;
  verifiedMetaGraphs: ReadonlySet<string>;
  /** False only when this CG's metadata phase was intentionally disabled. */
  metaFetched: boolean;
}

interface DurableSyncContext {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphIds: string[];
  onPhase?: PhaseCallback;
  /**
   * Invoked with the specific `contextGraphId` that was denied by the
   * remote peer (i.e. the remote responded with an `access-denied`
   * sync-protocol error for that CG). Callers use this to distinguish
   * "peer refused to serve this graph" from "sync completed but there
   * was nothing to send" — the two look identical at the summary level
   * but have very different operator meanings.
   */
  onAccessDenied?: (contextGraphId: string) => void;
  syncAgentsMeta?: boolean;
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
    sinceBatchId?: string,
  ) => Promise<SyncPageResult>;
  /**
   * Phase C — optional, gap-safe per-CG delta high-water mark resolver. When it
   * returns a value for a CG, the durable DATA fetch carries `sinceBatchId` and
   * the responder returns only KAs with `dkg:batchId` greater than it. MUST be
   * backed by a CONTIGUOUS watermark. Undefined ⇒ full scan (default today).
   */
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  stopOnBackoffWorthyFailure?: boolean;
  processDurableBatchInWorker: (
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified: boolean,
    mode: DurableBatchVerificationMode,
  ) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    verifiedGraphScopedDataGraphs?: string[];
    droppedSyncControlTriples?: number;
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    rejectedKcs: number;
    emptyResponses: number;
    metaOnlyResponses: number;
    verifiedPrivateOnlyResponses: number;
    dataRejectedMissingMeta: number;
  }>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  /** Exact replacement path for verified V2 KAs; absent capability fails closed. */
  storeGraphScopedAsset?: (
    asset: VerifiedGraphScopedAsset,
  ) => Promise<GraphScopedMaterializationOutcome>;
  /** Runs after verified snapshot writes and before phase checkpoints advance. */
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export async function runDurableSync(context: DurableSyncContext): Promise<DurableSyncSummary> {
  const {
    ctx,
    remotePeerId,
    contextGraphIds,
    onPhase,
    onAccessDenied,
    syncAgentsMeta = true,
    createContextGraphSyncDeadline,
    fetchSyncPages,
    sinceBatchIdFor,
    stopOnBackoffWorthyFailure = false,
    processDurableBatchInWorker,
    storeInsert,
    storeGraphScopedAsset,
    onVerifiedFullSnapshot,
    deleteCheckpoint,
    setCheckpoint,
    logInfo,
    logWarn,
    logDebug,
  } = context;

  const summary: DurableSyncSummary = {
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
    deniedPhases: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
  };

  const recordPhaseOutcome = (
    result: SyncPageResult,
    options: {
      updateCheckpoint: boolean;
      countProgress?: boolean;
      emptyPhase?: boolean;
    },
  ) => {
    const countProgress = options.countProgress ?? true;
    summary.resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
    summary.timedOutPhases += result.timedOut ? 1 : 0;
    if (options.updateCheckpoint && countProgress) {
      if (
        result.completed &&
        !result.timedOut &&
        (
          options.emptyPhase === true ||
          result.resumedFromOffset > 0 ||
          result.nextOffset > result.resumedFromOffset
        )
      ) {
        summary.completedPhases += 1;
      }
      if (result.nextOffset > result.resumedFromOffset) {
        summary.checkpointAdvances += 1;
      }
    }
    if (!options.updateCheckpoint) return;
    if (result.completed) deleteCheckpoint(result.checkpointKey);
    else if (result.nextOffset > 0 || result.resumedFromOffset > 0) {
      setCheckpoint(result.checkpointKey, result.nextOffset);
    }
  };

  let peerFailed = false;
  const shouldStopAfterBackoffWorthyFailure = (contextGraphId: string, reason: string): boolean => {
    if (!stopOnBackoffWorthyFailure) return false;
    logInfo(ctx, `Stopping durable sync fanout for ${remotePeerId} after "${contextGraphId}" (${reason})`);
    return true;
  };
  for (const [index, pid] of contextGraphIds.entries()) {
    let activePhase: 'fetch' | 'verify' | 'store' | undefined;
    let peerRespondedForContextGraph = false;
    const startPhase = (phase: 'fetch' | 'verify' | 'store') => {
      activePhase = phase;
      onPhase?.(phase, 'start');
    };
    const endPhase = () => {
      if (!activePhase) return;
      onPhase?.(activePhase, 'end');
      activePhase = undefined;
    };

    try {
      const dataGraph = contextGraphDataGraphUri(pid);
      const metaGraph = contextGraphMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

      startPhase('fetch');
      const fetchStartedAt = Date.now();
      const skipAgentsMeta = pid === SYSTEM_CONTEXT_GRAPHS.AGENTS && syncAgentsMeta === false;
      if (skipAgentsMeta) {
        logInfo(ctx, `Skipping agents meta sync from ${remotePeerId} (syncAgentsMeta=false)`);
      }
      const metaResult: SyncPageResult = skipAgentsMeta
        ? {
            quads: [],
            bytesReceived: 0,
            resumedFromOffset: 0,
            nextOffset: 0,
            checkpointKey: getSyncCheckpointKey(remotePeerId, pid, false, 'meta'),
            completed: true,
            timedOut: false,
          }
        : await fetchSyncPages(ctx, remotePeerId, pid, false, 'meta', metaGraph, deadline);
      if (!skipAgentsMeta) peerRespondedForContextGraph = true;
      if (metaResult.timedOut && shouldStopAfterBackoffWorthyFailure(pid, 'meta timeout')) {
        recordPhaseOutcome(metaResult, { updateCheckpoint: false });
        endPhase();
        break;
      }
      const sinceBatchId = sinceBatchIdFor?.(pid);
      const dataResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'data', dataGraph, deadline, undefined, sinceBatchId);
      peerRespondedForContextGraph = true;
      endPhase();
      const fetchDurationMs = Date.now() - fetchStartedAt;
      const isSystemContextGraph = (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(pid);

      let effectiveDataResult = dataResult;
      let dataForVerification = dataResult.quads;
      let verificationMode: DurableBatchVerificationMode = sinceBatchId === undefined
        ? { kind: 'fullSnapshot' }
        : { kind: 'sinceBatchId', sinceBatchId };

      // A rootless full snapshot is a deterministic concatenation of complete
      // exact graphs. When the deadline cuts the final graph mid-page, verify
      // and persist only the preceding complete graphs, then checkpoint their
      // absolute row boundary. The partial graph is deliberately discarded and
      // retried. This gives large V2 snapshots bounded memory and monotonic
      // progress without weakening legacy/mixed-layout fail-closed behaviour.
      if (
        sinceBatchId === undefined
        && !isSystemContextGraph
        && (dataResult.timedOut || dataResult.resumedFromOffset > 0)
      ) {
        const bounded = planBoundedGraphScopedDurableBatch(
          dataResult.quads,
          metaResult.quads,
          dataResult.resumedFromOffset,
          dataResult.nextOffset,
          dataResult.completed,
        );
        if (bounded) {
          dataForVerification = bounded.dataQuads;
          effectiveDataResult = {
            ...dataResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
          };
          verificationMode = {
            kind: 'changelogPage',
            changedDataGraphs: bounded.changedDataGraphs,
          };
          logInfo(
            ctx,
            `Rootless durable progress for "${pid}": `
              + `${bounded.completedGraphCount} complete graph(s), `
              + `safe offset ${dataResult.resumedFromOffset}->${bounded.safeNextOffset} `
              + `(raw ${dataResult.nextOffset})`,
          );
        }
      }

      startPhase('verify');
      const verifyStartedAt = Date.now();
      const processed = await processDurableBatchInWorker(
        dataForVerification,
        metaResult.quads,
        ctx,
        isSystemContextGraph,
        verificationMode,
      );
      endPhase();
      const verifyDurationMs = Date.now() - verifyStartedAt;

      logInfo(ctx, `  meta: ${processed.totalFetchedMetaQuads} triples fetched`);
      logInfo(ctx, `  data: ${processed.totalFetchedDataQuads} triples fetched`);
      summary.bytesReceived += metaResult.bytesReceived + dataResult.bytesReceived;
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;
      summary.metaOnlyResponses += processed.metaOnlyResponses;
      summary.verifiedPrivateOnlyResponses += processed.verifiedPrivateOnlyResponses;
      summary.dataRejectedMissingMeta += processed.dataRejectedMissingMeta;

      // A rejected KA means this page cannot be acknowledged safely. We may
      // still persist independently verified KAs from the page, but keeping
      // both cursors unchanged makes the next pass retry the rejected content
      // instead of silently skipping it.
      const batchVerifiedCleanly = processed.rejectedKcs === 0;
      if (!batchVerifiedCleanly) {
        logWarn(
          ctx,
          `Rejected ${processed.rejectedKcs} KCs that failed durable integrity verification from ${remotePeerId}`,
        );
        summary.rejectedKcs += processed.rejectedKcs;
      }

      const notifyVerifiedFullSnapshot = async (): Promise<void> => {
        if (
          !onVerifiedFullSnapshot
          || sinceBatchId !== undefined
          || !batchVerifiedCleanly
          || processed.dataRejectedMissingMeta !== 0
          || !effectiveDataResult.completed
          || effectiveDataResult.timedOut
          || effectiveDataResult.resumedFromOffset !== 0
          || (!skipAgentsMeta && (!metaResult.completed || metaResult.timedOut))
          || (!skipAgentsMeta && metaResult.resumedFromOffset !== 0)
        ) return;

        const verifiedDataGraphs = new Set(processed.verifiedData.map((quad) => quad.graph));
        for (const graph of processed.verifiedGraphScopedDataGraphs ?? []) {
          verifiedDataGraphs.add(graph);
        }
        await onVerifiedFullSnapshot({
          contextGraphId: pid,
          verifiedDataGraphs,
          verifiedMetaGraphs: new Set(processed.verifiedMeta.map((quad) => quad.graph)),
          metaFetched: !skipAgentsMeta,
        });
      };

      const metadataOnlyResponse = processed.metaOnlyResponses > 0;
      const droppedSyncControlTriples = processed.droppedSyncControlTriples ?? 0;
      const discardedOnlyMetadataResponse = metadataOnlyResponse
        && processed.verifiedData.length === 0
        && processed.verifiedMeta.length === 0
        && droppedSyncControlTriples > 0
        && droppedSyncControlTriples === processed.totalFetchedMetaQuads;
      const updateMetaCheckpoint = batchVerifiedCleanly
        && processed.dataRejectedMissingMeta === 0
        && (
          !metadataOnlyResponse
          || processed.verifiedMeta.length > 0
          || discardedOnlyMetadataResponse
        );
      const updateDataCheckpoint = batchVerifiedCleanly
        && processed.dataRejectedMissingMeta === 0
        && !metadataOnlyResponse;
      // Metadata-only pages may move the meta cursor after storage, but they
      // still are not usable data progress for freshness/backoff accounting.
      if (
        processed.emptyResponses > 0 ||
        processed.dataRejectedMissingMeta > 0 ||
        (processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && processed.metaOnlyResponses > 0)
      ) {
        await notifyVerifiedFullSnapshot();
        // The verifier reports an empty batch only when both fetched phase
        // payloads are empty. Record each phase independently: a completed
        // zero-offset phase is a real clean-empty response, while a sibling
        // timeout remains incomplete.
        const emptyPhase = processed.emptyResponses > 0;
        recordPhaseOutcome(metaResult, {
          updateCheckpoint: updateMetaCheckpoint,
          countProgress: !metadataOnlyResponse,
          emptyPhase,
        });
        recordPhaseOutcome(effectiveDataResult, {
          updateCheckpoint: updateDataCheckpoint,
          emptyPhase,
        });
        if ((metaResult.timedOut || effectiveDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
          break;
        }
        continue;
      }

      startPhase('store');
      const storeStartedAt = Date.now();
      const partitioned = partitionVerifiedGraphScopedAssets(
        pid,
        processed.verifiedData,
        processed.verifiedMeta,
        processed.verifiedGraphScopedDataGraphs ?? [],
      );
      if (partitioned.assets.length > 0 && !storeGraphScopedAsset) {
        throw Object.assign(
          new Error('Verified graph-scoped durable sync requires an exact materialization store path'),
          { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
        );
      }
      const appliedGraphScopedAssets: VerifiedGraphScopedAsset[] = [];
      for (const asset of partitioned.assets) {
        const outcome = await storeGraphScopedAsset!(asset);
        if (outcome === 'applied') appliedGraphScopedAssets.push(asset);
        else if (outcome === 'stale') {
          logDebug(ctx, `Skipped stale graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
        } else {
          logWarn(ctx, `Quarantined oversized graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
        }
      }
      if (partitioned.remainingData.length > 0) {
        await storeInsert(partitioned.remainingData);
        summary.insertedTriples += partitioned.remainingData.length;
        summary.insertedDataTriples += partitioned.remainingData.length;
      }
      if (partitioned.remainingMeta.length > 0) {
        await storeInsert(partitioned.remainingMeta);
        summary.insertedTriples += partitioned.remainingMeta.length;
        summary.insertedMetaTriples += partitioned.remainingMeta.length;
      }
      if (appliedGraphScopedAssets.length > 0) {
        const graphScopedDataCount = appliedGraphScopedAssets.reduce(
          (total, asset) => total + asset.dataQuads.length,
          0,
        );
        const graphScopedMetaCount = appliedGraphScopedAssets.reduce(
          (total, asset) => total + asset.metadataQuads.length,
          0,
        );
        summary.insertedTriples += graphScopedDataCount + graphScopedMetaCount;
        summary.insertedDataTriples += graphScopedDataCount;
        summary.insertedMetaTriples += graphScopedMetaCount;
      }
      await notifyVerifiedFullSnapshot();
      recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: !metadataOnlyResponse });
      recordPhaseOutcome(effectiveDataResult, { updateCheckpoint: updateDataCheckpoint });
      endPhase();
      if ((metaResult.timedOut || effectiveDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
        break;
      }
      const storeDurationMs = Date.now() - storeStartedAt;

      if (fetchDurationMs + verifyDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester durable timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms store=${storeDurationMs}ms`,
        );
      }

    } catch (pidErr) {
      endPhase();
      logWarn(ctx, `Sync for context graph "${pid}" from ${remotePeerId} failed: ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
      if (isSyncPermanentRejection(pidErr)) {
        // Missed-seam alarm (OT-RFC-56): the oversize guard should have
        // filtered this BEFORE the store insert. Reaching here means an
        // ingest path bypassed the guard — this page will fail identically
        // on every retry until that seam is wired.
        logWarn(ctx, `PERMANENT ingest rejection for "${pid}" reached the sync catch — an insert seam is missing the oversize guard (sync/oversize-filter.ts): ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
      }
      const backoffWorthy = isSyncBackoffWorthyError(pidErr);
      if (backoffWorthy) {
        summary.backoffWorthyFailures += 1;
      }
      if ((pidErr as Error & { syncDenied?: boolean }).syncDenied) {
        onAccessDenied?.(pid);
        summary.deniedPhases += 1;
      } else if (
        peerRespondedForContextGraph ||
        didSyncPeerRespond(pidErr) ||
        !isSyncTransportFailure(pidErr)
      ) {
        summary.failedPhases += 1;
      } else {
        peerFailed = true;
      }
      if (backoffWorthy && shouldStopAfterBackoffWorthyFailure(pid, 'backoff-worthy failure')) {
        break;
      }
    }
  }
  if (peerFailed) {
    summary.failedPeers = 1;
  }
  if (summary.insertedTriples > 0) {
    logInfo(ctx, `Sync complete: ${summary.insertedTriples} verified triples from ${remotePeerId}`);
  }

  return summary;
}

function partitionVerifiedGraphScopedAssets(
  contextGraphId: string,
  verifiedData: Quad[],
  verifiedMeta: Quad[],
  verifiedGraphs: readonly string[],
): {
  assets: VerifiedGraphScopedAsset[];
  remainingData: Quad[];
  remainingMeta: Quad[];
} {
  const graphSet = new Set(verifiedGraphs);
  // Apply the peer-control quarantine only to graph-scoped metadata subjects.
  // Legacy read-only KAs still rely on their already-verified status/access
  // rows, and stripping those globally would make an otherwise valid legacy
  // snapshot unreadable. An assertionVersion-only subject is included here as
  // a fail-closed torn-V2 marker even when its remaining envelope is missing.
  const graphScopedMetadataSubjects = new Set(
    verifiedMeta
      .filter((quad) => (
        quad.predicate === CONTENT_SCOPE_VERSION
        || quad.predicate === ASSERTION_GRAPH
        || quad.predicate === ASSERTION_VERSION
      ))
      .map((quad) => quad.subject),
  );
  // These predicates participate in local stale-write control. A peer may
  // supply assertionVersion only inside a fully verified graph-scoped asset;
  // materializedVersion is never peer-owned.
  const peerSafeMetadata = verifiedMeta.filter(
    (quad) => (
      !graphScopedMetadataSubjects.has(quad.subject)
      || !PEER_UNTRUSTED_METADATA_PREDICATES.has(quad.predicate)
    ),
  );
  if (graphSet.size === 0) {
    return {
      assets: [],
      remainingData: verifiedData,
      remainingMeta: peerSafeMetadata.filter((quad) => !(
        graphScopedMetadataSubjects.has(quad.subject)
        && quad.predicate === ASSERTION_VERSION
      )),
    };
  }

  const dataByGraph = new Map<string, Quad[]>();
  const remainingData: Quad[] = [];
  for (const quad of verifiedData) {
    if (!graphSet.has(quad.graph)) {
      remainingData.push(quad);
      continue;
    }
    const graphQuads = dataByGraph.get(quad.graph) ?? [];
    graphQuads.push(quad);
    dataByGraph.set(quad.graph, graphQuads);
  }

  const ualByGraph = new Map<string, Set<string>>();
  const metadataBySubject = new Map<string, Quad[]>();
  for (const quad of peerSafeMetadata) {
    const subjectQuads = metadataBySubject.get(quad.subject) ?? [];
    subjectQuads.push(quad);
    metadataBySubject.set(quad.subject, subjectQuads);
    if (quad.predicate !== ASSERTION_GRAPH) continue;
    const graph = stripLiteral(quad.object);
    if (!graphSet.has(graph)) continue;
    const owners = ualByGraph.get(graph) ?? new Set<string>();
    owners.add(quad.subject);
    ualByGraph.set(graph, owners);
  }

  const assets: VerifiedGraphScopedAsset[] = [];
  const handledUals = new Set<string>();
  for (const assertionGraph of [...graphSet].sort()) {
    const owners = ualByGraph.get(assertionGraph);
    if (!owners || owners.size !== 1) {
      throw new Error(`Verified graph-scoped assertion ${assertionGraph} has ${owners?.size ?? 0} metadata owners`);
    }
    const [ual] = owners;
    // Only persist structural fields used to verify and locate the exact
    // assertion. ACLs, status, timestamps and provenance are not Merkle-bound
    // by V2 data and must never become trusted local controls from a peer.
    const metadataQuads = (metadataBySubject.get(ual) ?? []).filter(
      (quad) => GRAPH_SCOPED_SYNC_METADATA_PREDICATES.has(quad.predicate),
    );
    const versions = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === ASSERTION_VERSION)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (versions.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} has ${versions.size} assertion versions`);
    }
    const [versionRaw] = versions;
    if (!versionRaw || !/^\d+$/.test(versionRaw)) {
      throw new Error(`Verified graph-scoped KA ${ual} has invalid assertionVersion ${versionRaw ?? '<missing>'}`);
    }
    const metaGraphs = new Set(metadataQuads.map((quad) => quad.graph));
    if (metaGraphs.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} spans ${metaGraphs.size} metadata graphs`);
    }
    const [metaGraph] = metaGraphs;
    const expectedContextGraph = `did:dkg:context-graph:${contextGraphId}`;
    const contextGraphs = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === CONTEXT_GRAPH)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (
      metaGraph !== `${expectedContextGraph}/_meta`
      || contextGraphs.size !== 1
      || !contextGraphs.has(expectedContextGraph)
    ) {
      throw new Error(
        `Verified graph-scoped KA ${ual} is not bound to requested context graph ${contextGraphId}`,
      );
    }
    const identity = parseDeterministicKnowledgeAssetUal(ual);
    const batchId = packKnowledgeAssetIdFromIdentity(identity);
    metadataQuads.push({
      subject: ual,
      predicate: BATCH_ID,
      object: `"${batchId}"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    });
    assets.push({
      contextGraphId,
      ual,
      assertionVersion: BigInt(versionRaw),
      assertionGraph,
      metaGraph,
      dataQuads: dataByGraph.get(assertionGraph) ?? [],
      metadataQuads,
    });
    handledUals.add(ual);
  }

  return {
    assets,
    remainingData,
    remainingMeta: peerSafeMetadata.filter(
      (quad) => (
        !handledUals.has(quad.subject)
        && !(
          graphScopedMetadataSubjects.has(quad.subject)
          && quad.predicate === ASSERTION_VERSION
        )
      ),
    ),
  };
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}
