import { paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from './page-fetch.js';

export interface SharedMemorySyncSummary {
  insertedTriples: number;
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  deniedPhases: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
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
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
  ) => Promise<SyncPageResult>;
  processSharedMemoryBatch: (wsDataQuads: Quad[], wsMetaQuads: Quad[]) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    droppedDataTriples: number;
    emptyResponses: number;
    entityCreators: Array<[string, string]>;
  }>;
  ensureParanet: (contextGraphId: string) => Promise<void>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  ensureOwnedMap: (contextGraphId: string) => Map<string, string>;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export async function runSharedMemorySync(context: SharedMemorySyncContext): Promise<SharedMemorySyncSummary> {
  const {
    ctx,
    remotePeerId,
    contextGraphIds,
    createContextGraphSyncDeadline,
    fetchSyncPages,
    processSharedMemoryBatch,
    ensureParanet,
    storeInsert,
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
    deniedPhases: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
  };

  try {
    for (const [index, pid] of contextGraphIds.entries()) {
      const wsGraph = paranetWorkspaceGraphUri(pid);
      const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing shared memory for context graph "${pid}" from ${remotePeerId}`);

      const fetchStartedAt = Date.now();
      const wsMetaResult = await fetchSyncPages(ctx, remotePeerId, pid, true, 'meta', wsMetaGraph, deadline);
      const wsDataResult = await fetchSyncPages(ctx, remotePeerId, pid, true, 'data', wsGraph, deadline);
      const fetchDurationMs = Date.now() - fetchStartedAt;

      const verifyStartedAt = Date.now();
      const processed = await processSharedMemoryBatch(wsDataResult.quads, wsMetaResult.quads);
      const verifyDurationMs = Date.now() - verifyStartedAt;
      logInfo(ctx, `  shared memory: ${processed.totalFetchedDataQuads} data + ${processed.totalFetchedMetaQuads} meta triples fetched`);
      summary.bytesReceived += wsMetaResult.bytesReceived + wsDataResult.bytesReceived;
      summary.resumedPhases += (wsMetaResult.resumedFromOffset > 0 ? 1 : 0) + (wsDataResult.resumedFromOffset > 0 ? 1 : 0);
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;

      if (processed.emptyResponses > 0) {
        continue;
      }

      const validWsQuads = processed.verifiedData;
      const dropped = processed.droppedDataTriples;
      if (dropped > 0) {
        logWarn(ctx, `SWM sync dropped ${dropped} triples with invalid subjects (not in meta rootEntity or skolemized child)`);
        summary.droppedDataTriples += dropped;
      }

      const storeStartedAt = Date.now();
      await ensureParanet(pid);

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
      if (wsMetaResult.completed) deleteCheckpoint(wsMetaResult.checkpointKey);
      else setCheckpoint(wsMetaResult.checkpointKey, wsMetaResult.nextOffset);
      if (wsDataResult.completed) deleteCheckpoint(wsDataResult.checkpointKey);
      else setCheckpoint(wsDataResult.checkpointKey, wsDataResult.nextOffset);

      const ownedMap = ensureOwnedMap(pid);
      for (const [entity, creator] of processed.entityCreators) {
        if (!ownedMap.has(entity)) {
          ownedMap.set(entity, creator);
        }
      }
      const storeDurationMs = Date.now() - storeStartedAt;

      logInfo(ctx, `SWM sync for "${pid}": ${validWsQuads.length} data + ${processed.verifiedMeta.length} meta triples`);
      if (fetchDurationMs + verifyDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester SWM timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms store+ownership=${storeDurationMs}ms`,
        );
      }
    }
    if (summary.insertedTriples > 0) {
      logInfo(ctx, `SWM sync complete: ${summary.insertedTriples} triples from ${remotePeerId}`);
    }
  } catch (err) {
    logWarn(ctx, `SWM sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    if ((err as Error & { syncDenied?: boolean }).syncDenied) {
      summary.deniedPhases += 1;
    }
    summary.failedPeers += 1;
  }

  return summary;
}
