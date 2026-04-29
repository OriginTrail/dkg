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
  /**
   * Invoked with the specific `contextGraphId` that was denied by the
   * remote peer (i.e. the remote responded with an `access-denied`
   * sync-protocol error for that CG). Callers use this to distinguish
   * "peer refused to serve this graph" from "sync completed but there
   * was nothing to send" — the two look identical at the summary level
   * but have very different operator meanings.
   */
  onAccessDenied?: (contextGraphId: string) => void;
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
    onAccessDenied,
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

  // each context graph is synced in
  // its own try/catch so that a transient failure on one CG does NOT
  // cascade into "skip every remaining CG for this peer". The previous
  // shape wrapped the entire loop in a single try/catch, which meant
  // `syncFromPeer(peer, ['cg-a', 'cg-b'])` would allocate a deadline
  // for cg-a, throw on cg-a, and return WITHOUT ever touching cg-b.
  // The per-context-graph deadline invariant — fresh deadline per CG
  // regardless of prior-CG outcome — is what `agent.test.ts`'s
  // "allocates a fresh sync deadline per context graph" test pins.
  try {
    for (const [index, pid] of contextGraphIds.entries()) {
     try {
      const dataGraph = paranetDataGraphUri(pid);
      const metaGraph = paranetMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

      onPhase?.('fetch', 'start');
      const fetchStartedAt = Date.now();

      let metaResult;
      let dataResult;
      try {
        metaResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'meta', metaGraph, deadline);
        dataResult = await fetchSyncPages(ctx, remotePeerId, pid, false, 'data', dataGraph, deadline);
      } catch (pidErr) {
        // `runDurableSync` has a catch-all below that sets `deniedPhases`
        // when a sync is rejected, but it collapses "which CG was
        // denied?" into a single counter. The `onAccessDenied` callback
        // exists precisely so callers (notably the daemon's subscribe
        // route) can tell "peer refused to serve this CG" apart from
        // "peer had nothing to send" per-graph. Re-throw so the outer
        // catch-all still records the denial in the summary and we don't
        // paper over genuine errors.
        if ((pidErr as Error & { syncDenied?: boolean }).syncDenied) {
          onPhase?.('fetch', 'end');
          onAccessDenied?.(pid);
        }
        throw pidErr;
      }

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
     } catch (err) {
      // Per-CG failure: log, account for it in the summary, and keep
      // iterating. Downstream CGs get their own deadline allocated by
      // the next loop iteration (see per-CG try/catch rationale above).
      logWarn(ctx, `Sync of context graph "${pid}" from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      if ((err as Error & { syncDenied?: boolean }).syncDenied) {
        summary.deniedPhases += 1;
      }
     }
    }
    if (summary.insertedTriples > 0) {
      logInfo(ctx, `Sync complete: ${summary.insertedTriples} verified triples from ${remotePeerId}`);
    }
  } catch (err) {
    // Outer catch retained for non-iteration-level failures
    // (e.g. the loop itself being unable to start). Per-iteration
    // failures are handled above so they cannot cascade.
    logWarn(ctx, `Sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    if ((err as Error & { syncDenied?: boolean }).syncDenied) {
      summary.deniedPhases += 1;
    }
    summary.failedPeers += 1;
  }

  return summary;
}
