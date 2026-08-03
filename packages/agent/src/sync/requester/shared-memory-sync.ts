import { contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncPhase } from '../auth/request-build.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncPermanentRejection, isSyncTransportFailure } from '../error-tags.js';
import { isSharedMemoryBucketDescendantDataGraph } from '../shared-memory-graphs.js';
import type { SyncPageResult } from './page-fetch.js';
import {
  materializeGraphScopedSwmRecoveryAsset,
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import type { SharedMemorySnapshotCommitter } from './swm-snapshot-committer.js';

const DKG = 'http://dkg.io/ontology/';

export interface SharedMemorySyncSummary {
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
  droppedDataTriples: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures: number;
  /** Context Graph admissions deferred by local scheduler pressure. */
  deferredBackpressure: number;
}

interface SharedMemorySyncContext {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphIds: string[];
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
  ) => Promise<SyncPageResult>;
  processSharedMemoryBatch: (
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    droppedDataTriples: number;
    emptyResponses: number;
    entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
  }>;
  ensureContextGraph: (contextGraphId: string) => Promise<void>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  /**
   * Everything needed to COMMIT verified public SWM snapshots as one cohesive
   * dependency: a store-focused materializer plus the post-commit settlement
   * policy. The production composition lives in `swm-snapshot-committer.ts`.
   *
   * Why it exists at all: contentScopeVersion-2 KAs carry no dkg:rootEntity,
   * so the aggregate data phase legitimately returns 0 data quads for them —
   * their content travels as immutable snapshots. The catch-up lane fetched
   * and VERIFIED those snapshots and then never wrote them, so a node that
   * missed the live gossip stayed empty forever ("0 data + N meta triples").
   * Absent entirely => materialization is skipped (never half-applied).
   */
  snapshotCommitter?: SharedMemorySnapshotCommitter;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  getRegisteredSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  getExcludedSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  stopOnBackoffWorthyFailure?: boolean;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  ensureOwnedMap: (ownershipKey: string) => Map<string, string>;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}


/**
 * True when the locally stored head version outranks the descriptor we are
 * about to materialize. BigInt-compared when both parse; anything unparseable
 * is treated as OUTRANKING — failing safe means never destroying local state
 * whose ordering we cannot establish.
 */
function storedVersionOutranksDescriptor(stored: string, descriptorVersion: string): boolean {
  try {
    return BigInt(stored) > BigInt(descriptorVersion);
  } catch {
    return true;
  }
}

export async function runSharedMemorySync(context: SharedMemorySyncContext): Promise<SharedMemorySyncSummary> {
  const {
    ctx,
    remotePeerId,
    contextGraphIds,
    createContextGraphSyncDeadline,
    fetchSyncPages,
    processSharedMemoryBatch,
    ensureContextGraph,
    storeInsert,
    snapshotCommitter,
    publicSnapshotStore,
    getRegisteredSubGraphNames,
    getExcludedSubGraphNames,
    stopOnBackoffWorthyFailure = false,
    deleteCheckpoint,
    setCheckpoint,
    ensureOwnedMap,
    logInfo,
    logWarn,
    logDebug,
  } = context;

  const summary: SharedMemorySyncSummary = {
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
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
  };

  const recordPhaseOutcome = (
    result: SyncPageResult,
    options: { updateCheckpoint?: boolean; emptyPhase?: boolean } = {},
  ) => {
    const updateCheckpoint = options.updateCheckpoint ?? true;
    summary.resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
    summary.timedOutPhases += result.timedOut ? 1 : 0;
    if (!updateCheckpoint) return;
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
    if (result.completed) deleteCheckpoint(result.checkpointKey);
    else if (result.nextOffset > 0 || result.resumedFromOffset > 0) {
      setCheckpoint(result.checkpointKey, result.nextOffset);
    }
  };

  let peerFailed = false;
  const shouldStopAfterBackoffWorthyFailure = (contextGraphId: string, reason: string): boolean => {
    if (!stopOnBackoffWorthyFailure) return false;
    logInfo(ctx, `Stopping SWM sync fanout for ${remotePeerId} after "${contextGraphId}" (${reason})`);
    return true;
  };
  for (const [index, pid] of contextGraphIds.entries()) {
    let peerRespondedForContextGraph = false;
    try {
      const wsGraph = contextGraphWorkspaceGraphUri(pid);
      const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing shared memory for context graph "${pid}" from ${remotePeerId}`);

      const fetchStartedAt = Date.now();
      const wsMetaResult = await fetchSyncPages(ctx, remotePeerId, pid, true, 'meta', wsMetaGraph, deadline);
      peerRespondedForContextGraph = true;
      if (wsMetaResult.timedOut && shouldStopAfterBackoffWorthyFailure(pid, 'meta timeout')) {
        recordPhaseOutcome(wsMetaResult, { updateCheckpoint: false });
        break;
      }
      const wsDataResult = await fetchSyncPages(ctx, remotePeerId, pid, true, 'data', wsGraph, deadline);
      peerRespondedForContextGraph = true;
      const fetchDurationMs = Date.now() - fetchStartedAt;

      const verifyStartedAt = Date.now();
      const registeredSubGraphNames = getRegisteredSubGraphNames
        ? await getRegisteredSubGraphNames(pid)
        : undefined;
      const excludedSubGraphNames = getExcludedSubGraphNames
        ? await getExcludedSubGraphNames(pid)
        : undefined;
      const processed = await processSharedMemoryBatch(
        wsDataResult.quads,
        wsMetaResult.quads,
        pid,
        registeredSubGraphNames,
        excludedSubGraphNames,
      );
      const verifyDurationMs = Date.now() - verifyStartedAt;
      logInfo(ctx, `  shared memory: ${processed.totalFetchedDataQuads} data + ${processed.totalFetchedMetaQuads} meta triples fetched`);
      summary.bytesReceived += wsMetaResult.bytesReceived + wsDataResult.bytesReceived;
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;

      if (processed.emptyResponses > 0) {
        // Count a genuinely empty public graph as complete without requiring
        // cursor movement. Each phase still owns its outcome, so a timeout in
        // one phase cannot be hidden by the sibling's clean empty response.
        recordPhaseOutcome(wsMetaResult, { emptyPhase: true });
        recordPhaseOutcome(wsDataResult, { emptyPhase: true });
        if ((wsMetaResult.timedOut || wsDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
          break;
        }
        continue;
      }

      const validWsQuads = processed.verifiedData;
      const dropped = processed.droppedDataTriples;
      const hydrateOwnership = () => {
        for (const { dataGraph, entity, creator } of processed.entityCreators) {
          const ownershipKey = sharedMemoryOwnershipKeyFromGraph(pid, dataGraph);
          if (!ownershipKey) {
            logWarn(ctx, `SWM sync skipped ownership cache hydration for "${entity}" from unexpected graph "${dataGraph}"`);
            continue;
          }
          const ownedMap = ensureOwnedMap(ownershipKey);
          if (!ownedMap.has(entity)) {
            ownedMap.set(entity, creator);
          }
        }
      };
      if (dropped > 0) {
        logWarn(ctx, `SWM sync dropped ${dropped} triples with invalid subjects (not in meta rootEntity or skolemized child)`);
        summary.droppedDataTriples += dropped;
      }

      // MATERIALIZE verified snapshots into the store, mirroring the private
      // recovery lane (`swm-recovery.ts` materializeReadySnapshot).
      //
      // Descriptors are parsed ONLY from verified meta, and only when the meta
      // phase completed: parseGraphScopedSwmRecoveryDescriptors throws on
      // incomplete metadata, and this lane pages meta, so a timed-out page would
      // otherwise abort the whole CG fanout. A parse failure here must degrade to
      // "no materialization this round" — never take down the sync.
      const snapshotMaterializer = snapshotCommitter?.materializer;
      const snapshotDescriptorsByRef = new Map<string, GraphScopedSwmRecoveryDescriptor[]>();
      if (snapshotMaterializer && publicSnapshotStore && wsMetaResult.completed) {
        try {
          for (const descriptor of parseGraphScopedSwmRecoveryDescriptors({
            contextGraphId: pid,
            metaQuads: processed.verifiedMeta,
            // Without the subgraph admission context every KA under a
            // REGISTERED subgraph is judged to live in an unregistered metadata
            // graph. The parser then throws, the catch clears ALL descriptors,
            // and materialization is silently disabled for the whole context
            // graph — not just for the subgraph KA that triggered it.
            ...(registeredSubGraphNames ? { registeredSubGraphNames } : {}),
            ...(excludedSubGraphNames ? { excludedSubGraphNames } : {}),
          })) {
            const ref = descriptor.publicSnapshotRef;
            if (!ref) continue; // no immutable snapshot for this KA
            const list = snapshotDescriptorsByRef.get(ref) ?? [];
            list.push(descriptor);
            snapshotDescriptorsByRef.set(ref, list);
          }
        } catch (err) {
          logWarn(ctx, `SWM sync could not parse graph-scoped snapshot descriptors for "${pid}": `
            + `${err instanceof Error ? err.message : String(err)}`);
          snapshotDescriptorsByRef.clear();
        }
      }
      let materializedGraphs = 0;
      let materializationFailures = 0;
      let materializedQuads = 0;
      const materializedKeys = new Set<string>();
      const settledDescriptors = new Map<string, GraphScopedSwmRecoveryDescriptor>();
      const materializeReadySnapshot = async (snapshotRef: string): Promise<void> => {
        const descriptors = snapshotDescriptorsByRef.get(snapshotRef);
        if (!descriptors?.length || !snapshotMaterializer || !publicSnapshotStore) return;
        for (const descriptor of descriptors) {
          const graphKey = `${descriptor.metaGraph}\u0000${descriptor.assertionGraph}`;
          if (materializedKeys.has(graphKey)) continue;
          try {
            await snapshotMaterializer.withKaWriteLock(
              pid,
              descriptor.subGraphName,
              descriptor.kaUal,
              async () => {
                // ALL decisions live INSIDE the lock. Between our pre-lock view
                // of the world and acquisition, live gossip may have committed
                // this KA — the lock stops the interleaving, and the two
                // re-checks below stop the other failure the lock alone cannot:
                // replacing newer content with an older verified snapshot.
                //
                // (a) Version ordering. A stored head newer than the descriptor
                // means gossip advanced this KA past our snapshot; replacing
                // would be overwrite-with-older, byte-for-byte the regression
                // this path once shipped (peer at 76 quads clobbered to 27).
                // Unparseable versions count as newer: when we cannot reason
                // about ordering we must not destroy. Nor may we "repair" the
                // head rows here — gossip owns a newer head and its
                // delete-then-insert already wrote it unambiguously.
                const storedHead = await snapshotMaterializer.readStoredHead(descriptor);
                if (
                  storedHead.version !== null
                  && storedVersionOutranksDescriptor(storedHead.version, descriptor.assertionVersion)
                ) {
                  materializedKeys.add(graphKey);
                  logDebug(ctx, `SWM sync for "${pid}": snapshot ${snapshotRef} superseded by `
                    + `stored version ${storedHead.version} (descriptor ${descriptor.assertionVersion}); skipping`);
                  return;
                }
                // (b) Exact content already present. Count AND digest: a
                // marker-only or short graph is the pre-fix broken state and
                // must be REPAIRED; an equal-count graph with a different
                // digest is an OLDER version of the same size and must be
                // replaced, not skipped.
                if (await snapshotMaterializer.isGraphAssetMaterialized(descriptor)) {
                  if (storedHead.needsRepair) {
                    // Content is already this descriptor's, but the head
                    // subject still carries union-insert residue (several
                    // version/operation rows) — e.g. a prior round replaced
                    // the graph and then failed before finishing the metadata
                    // swap. Collapse the head now; the fresh verified meta for
                    // this descriptor is re-inserted after the snapshot phase,
                    // exactly like the replace path below.
                    await snapshotMaterializer.replaceHeadMetadata(pid, descriptor);
                  }
                  materializedKeys.add(graphKey);
                  settledDescriptors.set(graphKey, descriptor);
                  return;
                }
                const asset = await materializeGraphScopedSwmRecoveryAsset({
                  descriptor,
                  fetchedDataQuads: [],
                  publicSnapshotStore,
                });
                await ensureContextGraph(pid);
                await snapshotMaterializer.replaceGraph(asset.assertionGraph, [...asset.quads]);
                // Graph first, THEN the head swap — a crash between the two
                // leaves content newer than the head, which the next round
                // repairs (digest matches → head collapsed above). The swap
                // deletes the old head + its operations so the append-style
                // `storeInsert(processed.verifiedMeta)` below lands on a clean
                // subject instead of stacking a second version onto it
                // (LIMIT-1 head readers would otherwise see an arbitrary mix).
                await snapshotMaterializer.replaceHeadMetadata(pid, descriptor);
                materializedKeys.add(graphKey);
                settledDescriptors.set(graphKey, descriptor);
                materializedGraphs += 1;
                materializedQuads += asset.quads.length;
                logInfo(ctx, `SWM sync for "${pid}": materialized snapshot ${snapshotRef} `
                  + `as ${asset.assertionGraph} (${asset.quads.length} triples)`);
              },
            );
          } catch (err) {
            // A failed replace must never be able to look materialized later.
            // Suppressing it here while the surrounding sync still inserts the
            // graph-scoped head marker makes the loss PERMANENT: the next pass
            // sees that marker, isGraphAssetMaterialized returns true, and the
            // missing assertion graph is skipped forever. Record the failure so
            // the caller keeps the phase incomplete and withholds the metadata
            // that would otherwise certify a graph that was never written.
            materializationFailures += 1;
            logWarn(ctx, `SWM sync failed to materialize snapshot ${snapshotRef} for "${pid}": `
              + `${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };

      const snapshotStartedAt = Date.now();
      const snapshotSync = await syncPublicSnapshotsForMeta({
        ctx,
        remotePeerId,
        contextGraphId: pid,
        deadline,
        metaQuads: processed.verifiedMeta,
        publicSnapshotStore,
        fetchSyncPages,
        deleteCheckpoint,
        setCheckpoint,
        // Fires for BOTH 'cache' and 'network' sources, so a node whose earlier
        // runs already cached the blobs materializes them on the next pass
        // without refetching a byte.
        ...(snapshotDescriptorsByRef.size > 0
          ? { onSnapshotReady: (snapshot: PublicSnapshotMetadata) => materializeReadySnapshot(snapshot.ref) }
          : {}),
      });
      if (materializedGraphs > 0) {
        summary.insertedTriples += materializedQuads;
        // Also data progress: lifecycle readiness classifies a round with zero
        // insertedDataTriples as metadata-only, which would mis-report a
        // successful graph-scoped materialization as "no data".
        summary.insertedDataTriples += materializedQuads;
        logInfo(ctx, `SWM sync for "${pid}": materialized ${materializedGraphs} graph-scoped `
          + `KA snapshot(s) totalling ${materializedQuads} triples`);
      }
      summary.bytesReceived += snapshotSync.bytesReceived;
      summary.resumedPhases += snapshotSync.resumedPhases;
      summary.timedOutPhases += snapshotSync.timedOutPhases;
      summary.completedPhases += snapshotSync.completedPhases;
      summary.checkpointAdvances += snapshotSync.checkpointAdvances;
      const snapshotDurationMs = Date.now() - snapshotStartedAt;
      // A snapshot that verified but could not be written must be treated
      // exactly like a snapshot phase that did not complete. Otherwise the meta
      // insert below stamps a graph-scoped head marker for an assertion graph
      // that was never materialized, and every later pass skips it as already
      // present — turning a transient store error into permanent, silent loss.
      const snapshotPhaseUsable = snapshotSync.completed && materializationFailures === 0;
      if (materializationFailures > 0) {
        logWarn(ctx, `SWM sync for "${pid}": ${materializationFailures} snapshot(s) verified but `
          + `not materialized — holding the phase incomplete so metadata cannot certify them`);
      }
      if (!snapshotPhaseUsable) {
        // The responder was reachable, but the snapshot phase did not produce
        // a complete, verified snapshot. Preserve any verified data prefix
        // below, while keeping the overall sync result non-successful so the
        // lifecycle scheduler retries instead of stamping this peer as caught
        // up with dangling/missing public snapshot state.
        summary.failedPhases += 1;
        if (validWsQuads.length > 0) {
          await ensureContextGraph(pid);
          await storeInsert(validWsQuads);
          summary.insertedTriples += validWsQuads.length;
          summary.insertedDataTriples += validWsQuads.length;
          recordPhaseOutcome(wsDataResult);
          hydrateOwnership();
        }
        if (snapshotSync.timedOutPhases > 0 && shouldStopAfterBackoffWorthyFailure(pid, 'snapshot timeout')) {
          break;
        }
        continue;
      }

      const storeStartedAt = Date.now();
      await ensureContextGraph(pid);

      if (validWsQuads.length > 0) {
        await storeInsert(validWsQuads);
        summary.insertedTriples += validWsQuads.length;
        summary.insertedDataTriples += validWsQuads.length;
      }
      if (processed.verifiedMeta.length > 0) {
        await storeInsert(processed.verifiedMeta);
        summary.insertedTriples += processed.verifiedMeta.length;
        summary.insertedMetaTriples += processed.verifiedMeta.length;
      }
      // Deliberately outside the per-KA snapshot lock above: the finalizer
      // acquires the same lock before stamping the local retirement marker.
      // Running settlement inside the materializer critical section would
      // deadlock. The higher-level committer keeps materialization and
      // settlement required together without giving the store adapter
      // finalization responsibilities.
      await snapshotCommitter?.settleCommittedSnapshots(
        pid,
        [...settledDescriptors.values()],
      );
      recordPhaseOutcome(wsMetaResult);
      recordPhaseOutcome(wsDataResult);
      if ((wsMetaResult.timedOut || wsDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
        break;
      }

      hydrateOwnership();
      const storeDurationMs = Date.now() - storeStartedAt;

      logInfo(ctx, `SWM sync for "${pid}": ${validWsQuads.length} data + ${processed.verifiedMeta.length} meta triples`);
      if (fetchDurationMs + verifyDurationMs + snapshotDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester SWM timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms snapshots=${snapshotDurationMs}ms store+ownership=${storeDurationMs}ms`,
        );
      }
    } catch (err) {
      logWarn(ctx, `SWM sync for context graph "${pid}" from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (isSyncPermanentRejection(err)) {
        // Missed-seam alarm (OT-RFC-56) — see durable-sync.ts: the oversize
        // guard should have filtered this before the insert.
        logWarn(ctx, `PERMANENT ingest rejection for "${pid}" reached the SWM sync catch — an insert seam is missing the oversize guard (sync/oversize-filter.ts): ${err instanceof Error ? err.message : String(err)}`);
      }
      const backoffWorthy = isSyncBackoffWorthyError(err);
      if (backoffWorthy) {
        summary.backoffWorthyFailures += 1;
      }
      if ((err as Error & { syncDenied?: boolean }).syncDenied) {
        summary.deniedPhases += 1;
      } else if (
        peerRespondedForContextGraph ||
        didSyncPeerRespond(err) ||
        !isSyncTransportFailure(err)
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
    logInfo(ctx, `SWM sync complete: ${summary.insertedTriples} triples from ${remotePeerId}`);
  }

  return summary;
}

export function sharedMemoryOwnershipKeyFromGraph(contextGraphId: string, dataGraph: string): string | undefined {
  const rootGraph = contextGraphWorkspaceGraphUri(contextGraphId);
  if (dataGraph === rootGraph || isSharedMemoryBucketDescendantDataGraph(dataGraph, rootGraph)) return contextGraphId;

  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory';
  if (!dataGraph.startsWith(prefix)) return undefined;

  const remainder = dataGraph.slice(prefix.length);
  const suffixAt = remainder.indexOf(suffix);
  if (suffixAt <= 0) return undefined;
  const bucketGraph = dataGraph.slice(0, prefix.length + suffixAt + suffix.length);
  const subGraphName = remainder.slice(0, suffixAt);
  const tail = remainder.slice(suffixAt + suffix.length);
  if (tail && (!tail.startsWith('/') || !isSharedMemoryBucketDescendantDataGraph(dataGraph, bucketGraph))) {
    return undefined;
  }
  if (!subGraphName || subGraphName.includes('/')) return undefined;
  if (!validateSubGraphName(subGraphName).valid) return undefined;

  return `${contextGraphId}\0${subGraphName}`;
}

export interface PublicSnapshotMetadata {
  ref: string;
  digest: string;
  count: number;
}

export async function syncPublicSnapshotsForMeta(params: {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  deadline: number;
  metaQuads: readonly Quad[];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  /**
   * Optional recovery hook invoked only after the complete immutable snapshot
   * has passed its signed digest/count check. Callers may make that one KA
   * visible immediately; an unverified prefix never reaches this hook.
   */
  onSnapshotReady?: (
    snapshot: PublicSnapshotMetadata,
    source: 'cache' | 'network',
  ) => Promise<void>;
}): Promise<{
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  /** Immutable snapshot refs already valid locally or fetched in this round. */
  readySnapshots: number;
  /** Total immutable snapshot refs declared by the verified SWM metadata. */
  totalSnapshots: number;
  completed: boolean;
}> {
  const snapshots = collectPublicSnapshotMetadata(params.metaQuads);
  if (snapshots.length === 0) {
    return {
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      readySnapshots: 0,
      totalSnapshots: 0,
      completed: true,
    };
  }
  if (!params.publicSnapshotStore) {
    throw new Error(
      `Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`,
    );
  }

  let bytesReceived = 0;
  let resumedPhases = 0;
  let timedOutPhases = 0;
  let completedPhases = 0;
  let checkpointAdvances = 0;
  let readySnapshots = 0;
  for (const snapshot of snapshots) {
    if (await hasValidSnapshot(params.publicSnapshotStore, snapshot)) {
      await params.onSnapshotReady?.(snapshot, 'cache');
      readySnapshots += 1;
      continue;
    }

    const result = await params.fetchSyncPages(
      params.ctx,
      params.remotePeerId,
      params.contextGraphId,
      true,
      'snapshot',
      '',
      params.deadline,
      snapshot.ref,
    );
    bytesReceived += result.bytesReceived;
    resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
    timedOutPhases += result.timedOut ? 1 : 0;
    if (result.completed) params.deleteCheckpoint(result.checkpointKey);
    else {
      // `fetchSyncPages` returns only the quads fetched during THIS call. We do
      // not persist an unverified prefix, so resuming a snapshot at nextOffset
      // would validate only the tail against the full digest/count and can never
      // succeed. Restart this one immutable KA at offset zero on the next round;
      // already completed snapshots remain cached and are skipped, preserving
      // monotonic recovery progress across the CG without accepting a partial
      // asset.
      params.deleteCheckpoint(result.checkpointKey);
      return {
        bytesReceived,
        resumedPhases,
        timedOutPhases,
        completedPhases,
        checkpointAdvances,
        readySnapshots,
        totalSnapshots: snapshots.length,
        completed: false,
      };
    }

    const snapshotQuads = result.quads.map((quad) => ({ ...quad, graph: '' }));
    if (snapshotQuads.length < snapshot.count) {
      // A relayed stream can terminate cleanly after returning a prefix. The
      // requester then sees `completed=true`, but the signed metadata gives us
      // an authoritative expected count and proves that this is incomplete,
      // not corrupt. Never cache or apply the prefix; retry it from offset zero
      // in a later bounded recovery round. Equal-count digest mismatches remain
      // fatal below so a complete but tampered snapshot is never softened into
      // a transport retry.
      params.deleteCheckpoint(result.checkpointKey);
      return {
        bytesReceived,
        resumedPhases,
        timedOutPhases,
        completedPhases,
        checkpointAdvances,
        readySnapshots,
        totalSnapshots: snapshots.length,
        completed: false,
      };
    }
    const actualDigest = workspacePublicQuadsDigest(snapshotQuads);
    if (actualDigest !== snapshot.digest || snapshotQuads.length !== snapshot.count) {
      throw new Error(
        `Shared-memory public snapshot ${snapshot.ref} failed digest/count validation ` +
        `(expected ${snapshot.digest}/${snapshot.count}, got ${actualDigest}/${snapshotQuads.length})`,
      );
    }
    await params.publicSnapshotStore.putSnapshot({ digest: snapshot.digest, quads: snapshotQuads });
    await params.onSnapshotReady?.(snapshot, 'network');
    completedPhases += 1;
    readySnapshots += 1;
  }

  return {
    bytesReceived,
    resumedPhases,
    timedOutPhases,
    completedPhases,
    checkpointAdvances,
    readySnapshots,
    totalSnapshots: snapshots.length,
    completed: true,
  };
}

export function collectPublicSnapshotMetadata(metaQuads: readonly Quad[]): PublicSnapshotMetadata[] {
  const bySubject = new Map<string, { ref?: string; digest?: string; count?: number; hasSnapshotGraph?: boolean }>();
  for (const quad of metaQuads) {
    if (
      quad.predicate !== `${DKG}publicSnapshotRef` &&
      quad.predicate !== `${DKG}publicSnapshotGraph` &&
      quad.predicate !== `${DKG}publicQuadsDigest` &&
      quad.predicate !== `${DKG}publicQuadsCount`
    ) {
      continue;
    }
    const entry = bySubject.get(quad.subject) ?? {};
    if (quad.predicate === `${DKG}publicSnapshotRef`) entry.ref = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicSnapshotGraph`) entry.hasSnapshotGraph = true;
    if (quad.predicate === `${DKG}publicQuadsDigest`) entry.digest = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicQuadsCount`) entry.count = parseIntegerLiteral(quad.object);
    bySubject.set(quad.subject, entry);
  }

  const byRef = new Map<string, PublicSnapshotMetadata>();
  for (const [subject, entry] of bySubject) {
    // Read-both (RFC ka-metadata-trim Phase 2): old-store rows carry an
    // explicit `dkg:publicSnapshotRef` (byte-identical to the digest); new
    // store-backed rows carry only the digest — their ref IS the digest
    // (`putSnapshot` returns `ref === digest`). Rows with a
    // `dkg:publicSnapshotGraph` are graph-backed, not snapshot-store-backed:
    // their quads travel through ordinary graph sync, so they are NOT
    // snapshot-fetch targets.
    let ref = entry.ref;
    if (!ref) {
      // Derived (new-shape) rows must be complete to qualify — an incomplete
      // digest-only row is ignored exactly as ref-less rows always were,
      // rather than promoted into the hard integrity throw below (which
      // stays reserved for explicit-ref rows written by older nodes).
      if (entry.hasSnapshotGraph || !entry.digest || !Number.isInteger(entry.count)) continue;
      ref = entry.digest;
    }
    if (!entry.digest || !Number.isInteger(entry.count)) {
      throw new Error(`Shared-memory public snapshot metadata for ${subject} is missing digest/count`);
    }
    const existing = byRef.get(ref);
    const metadata = { ref, digest: entry.digest, count: entry.count! };
    if (existing && (existing.digest !== metadata.digest || existing.count !== metadata.count)) {
      throw new Error(`Conflicting shared-memory public snapshot metadata for ${ref}`);
    }
    byRef.set(ref, metadata);
  }
  return [...byRef.values()];
}

async function hasValidSnapshot(
  publicSnapshotStore: WorkspacePublicSnapshotStore,
  snapshot: PublicSnapshotMetadata,
): Promise<boolean> {
  let quads: Quad[] | null;
  try {
    quads = await publicSnapshotStore.getSnapshot(snapshot.ref);
  } catch {
    return false;
  }
  if (!quads) return false;
  return quads.length === snapshot.count && workspacePublicQuadsDigest(quads) === snapshot.digest;
}

function stripLiteral(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[-A-Za-z0-9]+|\^\^<[^>]+>)?$/);
  if (!match) return value;
  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseIntegerLiteral(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(stripLiteral(value) ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
