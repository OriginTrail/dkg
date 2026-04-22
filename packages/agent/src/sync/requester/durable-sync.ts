import { SYSTEM_PARANETS } from '@origintrail-official/dkg-core';
import { paranetDataGraphUri, paranetMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { PhaseCallback } from '@origintrail-official/dkg-publisher';
import type { SyncPageResult } from './page-fetch.js';

export interface DurableSyncSummary {
  insertedTriples: number;
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  deniedPhases: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
}

interface DurableSyncContext {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphIds: string[];
  onPhase?: PhaseCallback;
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
  ) => Promise<SyncPageResult>;
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
    createContextGraphSyncDeadline,
    fetchSyncPages,
    processDurableBatchInWorker,
    storeInsert,
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
    deniedPhases: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
  };

  try {
    for (const [index, pid] of contextGraphIds.entries()) {
      const dataGraph = paranetDataGraphUri(pid);
      const metaGraph = paranetMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

      onPhase?.('fetch', 'start');
      const fetchStartedAt = Date.now();

      const metaResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'meta', metaGraph, deadline);
      const dataResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'data', dataGraph, deadline);

      onPhase?.('fetch', 'end');
      const fetchDurationMs = Date.now() - fetchStartedAt;
      const isSystemContextGraph = (Object.values(SYSTEM_PARANETS) as string[]).includes(pid);

      onPhase?.('verify', 'start');
      const verifyStartedAt = Date.now();
      const processed = await processDurableBatchInWorker(dataResult.quads, metaResult.quads, ctx, isSystemContextGraph);
      onPhase?.('verify', 'end');
      const verifyDurationMs = Date.now() - verifyStartedAt;

      logInfo(ctx, `  meta: ${processed.totalFetchedMetaQuads} triples fetched`);
      logInfo(ctx, `  data: ${processed.totalFetchedDataQuads} triples fetched`);
      summary.bytesReceived += metaResult.bytesReceived + dataResult.bytesReceived;
      summary.resumedPhases += (metaResult.resumedFromOffset > 0 ? 1 : 0) + (dataResult.resumedFromOffset > 0 ? 1 : 0);
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;
      summary.metaOnlyResponses += processed.metaOnlyResponses;
      summary.dataRejectedMissingMeta += processed.dataRejectedMissingMeta;

      if (
        processed.emptyResponses > 0 ||
        processed.dataRejectedMissingMeta > 0 ||
        (processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && processed.metaOnlyResponses > 0)
      ) {
        continue;
      }

      onPhase?.('store', 'start');
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
      if (metaResult.completed) deleteCheckpoint(metaResult.checkpointKey);
      else setCheckpoint(metaResult.checkpointKey, metaResult.nextOffset);
      if (dataResult.completed) deleteCheckpoint(dataResult.checkpointKey);
      else setCheckpoint(dataResult.checkpointKey, dataResult.nextOffset);
      onPhase?.('store', 'end');
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
    }
    if (summary.insertedTriples > 0) {
      logInfo(ctx, `Sync complete: ${summary.insertedTriples} verified triples from ${remotePeerId}`);
    }
  } catch (err) {
    logWarn(ctx, `Sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    if ((err as Error & { syncDenied?: boolean }).syncDenied) {
      summary.deniedPhases += 1;
    }
    summary.failedPeers += 1;
  }

  return summary;
}
