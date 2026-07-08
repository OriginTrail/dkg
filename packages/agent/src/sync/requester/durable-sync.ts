import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { PhaseCallback } from '@origintrail-official/dkg-publisher';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncTransportFailure } from '../error-tags.js';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import type { SyncPageResult } from './page-fetch.js';

const DKG_NS = 'http://dkg.io/ontology/';
const MERKLE_ROOT_PREDICATE = `${DKG_NS}merkleRoot`;

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
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures: number;
}

export type DurableSyncLifecycleAction = 'request' | 'response' | 'receive' | 'apply' | 'skip' | 'failure';

export interface DurableSyncLifecycleEvent {
  assetUal: string;
  event: string;
  action: DurableSyncLifecycleAction;
  result: string;
  source: string;
  contextGraphId: string;
  remotePeerId: string;
  fetchedMetaCount: number;
  fetchedDataCount: number;
  insertedMetaCount?: number;
  insertedDataCount?: number;
  rejectedKcs?: number;
  reason?: string;
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
  processDurableBatchInWorker: (dataQuads: Quad[], metaQuads: Quad[], ctx: OperationContext, acceptUnverified: boolean) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    rejectedKcs: number;
    emptyResponses: number;
    metaOnlyResponses: number;
    dataRejectedMissingMeta: number;
  }>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  logLifecycle?: (event: DurableSyncLifecycleEvent) => void;
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
    deleteCheckpoint,
    setCheckpoint,
    logLifecycle,
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
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    backoffWorthyFailures: 0,
  };

  const recordPhaseOutcome = (result: SyncPageResult, options: { updateCheckpoint: boolean; countProgress?: boolean }) => {
    const countProgress = options.countProgress ?? true;
    summary.resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
    summary.timedOutPhases += result.timedOut ? 1 : 0;
    if (options.updateCheckpoint && countProgress) {
      if (result.completed && (result.resumedFromOffset > 0 || result.nextOffset > result.resumedFromOffset)) {
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
      const dataResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'data', dataGraph, deadline, undefined, sinceBatchIdFor?.(pid));
      peerRespondedForContextGraph = true;
      endPhase();
      const fetchDurationMs = Date.now() - fetchStartedAt;
      const isSystemContextGraph = (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(pid);

      startPhase('verify');
      const verifyStartedAt = Date.now();
      const processed = await processDurableBatchInWorker(dataResult.quads, metaResult.quads, ctx, isSystemContextGraph);
      endPhase();
      const verifyDurationMs = Date.now() - verifyStartedAt;

      logInfo(ctx, `  meta: ${processed.totalFetchedMetaQuads} triples fetched`);
      logInfo(ctx, `  data: ${processed.totalFetchedDataQuads} triples fetched`);
      const publishedAssetUals = publishedAssetUalsFromMeta(processed.verifiedMeta);
      for (const assetUal of publishedAssetUals) {
        logLifecycle?.({
          assetUal,
          event: 'sync_request',
          action: 'request',
          result: 'sent',
          source: 'durable-sync',
          contextGraphId: pid,
          remotePeerId,
          fetchedMetaCount: processed.totalFetchedMetaQuads,
          fetchedDataCount: processed.totalFetchedDataQuads,
          rejectedKcs: processed.rejectedKcs,
        });
        logLifecycle?.({
          assetUal,
          event: 'sync_response',
          action: 'response',
          result: 'fetched',
          source: 'durable-sync',
          contextGraphId: pid,
          remotePeerId,
          fetchedMetaCount: processed.totalFetchedMetaQuads,
          fetchedDataCount: processed.totalFetchedDataQuads,
          rejectedKcs: processed.rejectedKcs,
        });
        logLifecycle?.({
          assetUal,
          event: 'sync_receive',
          action: 'receive',
          result: 'verified',
          source: 'durable-sync',
          contextGraphId: pid,
          remotePeerId,
          fetchedMetaCount: processed.totalFetchedMetaQuads,
          fetchedDataCount: processed.totalFetchedDataQuads,
          rejectedKcs: processed.rejectedKcs,
        });
      }
      summary.bytesReceived += metaResult.bytesReceived + dataResult.bytesReceived;
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;
      summary.metaOnlyResponses += processed.metaOnlyResponses;
      summary.dataRejectedMissingMeta += processed.dataRejectedMissingMeta;

      const metadataOnlyResponse = processed.metaOnlyResponses > 0;
      const skipReason = processed.dataRejectedMissingMeta > 0
        ? 'data-rejected-missing-meta'
        : processed.emptyResponses > 0
          ? 'empty-response'
          : processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && metadataOnlyResponse
            ? 'metadata-only-response'
            : undefined;
      const updateMetaCheckpoint = processed.dataRejectedMissingMeta === 0
        && (!metadataOnlyResponse || processed.verifiedMeta.length > 0);
      const updateDataCheckpoint = processed.dataRejectedMissingMeta === 0 && !metadataOnlyResponse;
      // Metadata-only pages may move the meta cursor after storage, but they
      // still are not usable data progress for freshness/backoff accounting.
      if (skipReason) {
        for (const assetUal of publishedAssetUals) {
          logLifecycle?.({
            assetUal,
            event: 'sync_skip',
            action: 'skip',
            result: 'deferred',
            source: 'durable-sync',
            contextGraphId: pid,
            remotePeerId,
            fetchedMetaCount: processed.totalFetchedMetaQuads,
            fetchedDataCount: processed.totalFetchedDataQuads,
            rejectedKcs: processed.rejectedKcs,
            reason: skipReason,
          });
        }
        recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: !metadataOnlyResponse });
        recordPhaseOutcome(dataResult, { updateCheckpoint: updateDataCheckpoint });
        if ((metaResult.timedOut || dataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
          break;
        }
        continue;
      }

      startPhase('store');
      const storeStartedAt = Date.now();
      if (processed.verifiedData.length > 0) {
        await storeInsert(processed.verifiedData);
        summary.insertedTriples += processed.verifiedData.length;
        summary.insertedDataTriples += processed.verifiedData.length;
      }
      if (processed.verifiedMeta.length > 0) {
        await storeInsert(processed.verifiedMeta);
        summary.insertedTriples += processed.verifiedMeta.length;
        summary.insertedMetaTriples += processed.verifiedMeta.length;
      }
      for (const assetUal of publishedAssetUals) {
        logLifecycle?.({
          assetUal,
          event: 'sync_apply',
          action: 'apply',
          result: 'inserted',
          source: 'durable-sync',
          contextGraphId: pid,
          remotePeerId,
          fetchedMetaCount: processed.totalFetchedMetaQuads,
          fetchedDataCount: processed.totalFetchedDataQuads,
          insertedMetaCount: processed.verifiedMeta.length,
          insertedDataCount: processed.verifiedData.length,
          rejectedKcs: processed.rejectedKcs,
        });
      }
      recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: !metadataOnlyResponse });
      recordPhaseOutcome(dataResult, { updateCheckpoint: updateDataCheckpoint });
      endPhase();
      if ((metaResult.timedOut || dataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
        break;
      }
      const storeDurationMs = Date.now() - storeStartedAt;

      if (fetchDurationMs + verifyDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester durable timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms store=${storeDurationMs}ms`,
        );
      }

      if (processed.rejectedKcs > 0) {
        logWarn(ctx, `Rejected ${processed.rejectedKcs} KCs with invalid merkle roots from ${remotePeerId}`);
        summary.rejectedKcs += processed.rejectedKcs;
      }
    } catch (pidErr) {
      endPhase();
      logWarn(ctx, `Sync for context graph "${pid}" from ${remotePeerId} failed: ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
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

function publishedAssetUalsFromMeta(metaQuads: readonly Quad[]): string[] {
  const out = new Set<string>();
  for (const quad of metaQuads) {
    if (quad.predicate === MERKLE_ROOT_PREDICATE && quad.subject.startsWith('did:dkg:')) {
      out.add(quad.subject);
    }
  }
  return [...out];
}
