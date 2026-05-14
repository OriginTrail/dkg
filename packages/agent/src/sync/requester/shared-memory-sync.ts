import { contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncPhase } from '../auth/request-build.js';
import type { SyncPageResult } from './page-fetch.js';

const DKG = 'http://dkg.io/ontology/';

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
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
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
  ensureContextGraph: (contextGraphId: string) => Promise<void>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
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
    ensureContextGraph,
    storeInsert,
    publicSnapshotStore,
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
      const wsGraph = contextGraphWorkspaceGraphUri(pid);
      const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(pid);
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
      });
      summary.bytesReceived += snapshotSync.bytesReceived;
      summary.resumedPhases += snapshotSync.resumedPhases;
      const snapshotDurationMs = Date.now() - snapshotStartedAt;

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
      if (fetchDurationMs + verifyDurationMs + snapshotDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester SWM timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms snapshots=${snapshotDurationMs}ms store+ownership=${storeDurationMs}ms`,
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

interface PublicSnapshotMetadata {
  ref: string;
  digest: string;
  count: number;
}

async function syncPublicSnapshotsForMeta(params: {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  deadline: number;
  metaQuads: readonly Quad[];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
}): Promise<{ bytesReceived: number; resumedPhases: number }> {
  const snapshots = collectPublicSnapshotMetadata(params.metaQuads);
  if (snapshots.length === 0) {
    return { bytesReceived: 0, resumedPhases: 0 };
  }
  if (!params.publicSnapshotStore) {
    throw new Error(
      `Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`,
    );
  }

  let bytesReceived = 0;
  let resumedPhases = 0;
  for (const snapshot of snapshots) {
    if (await hasValidSnapshot(params.publicSnapshotStore, snapshot)) {
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

    if (result.completed) params.deleteCheckpoint(result.checkpointKey);
    else {
      params.setCheckpoint(result.checkpointKey, result.nextOffset);
      throw new Error(`Timed out while syncing shared-memory public snapshot ${snapshot.ref}`);
    }

    const snapshotQuads = result.quads.map((quad) => ({ ...quad, graph: '' }));
    const actualDigest = workspacePublicQuadsDigest(snapshotQuads);
    if (actualDigest !== snapshot.digest || snapshotQuads.length !== snapshot.count) {
      throw new Error(
        `Shared-memory public snapshot ${snapshot.ref} failed digest/count validation ` +
        `(expected ${snapshot.digest}/${snapshot.count}, got ${actualDigest}/${snapshotQuads.length})`,
      );
    }
    await params.publicSnapshotStore.putSnapshot({ digest: snapshot.digest, quads: snapshotQuads });
  }

  return { bytesReceived, resumedPhases };
}

function collectPublicSnapshotMetadata(metaQuads: readonly Quad[]): PublicSnapshotMetadata[] {
  const bySubject = new Map<string, { ref?: string; digest?: string; count?: number }>();
  for (const quad of metaQuads) {
    if (
      quad.predicate !== `${DKG}publicSnapshotRef` &&
      quad.predicate !== `${DKG}publicQuadsDigest` &&
      quad.predicate !== `${DKG}publicQuadsCount`
    ) {
      continue;
    }
    const entry = bySubject.get(quad.subject) ?? {};
    if (quad.predicate === `${DKG}publicSnapshotRef`) entry.ref = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicQuadsDigest`) entry.digest = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicQuadsCount`) entry.count = parseIntegerLiteral(quad.object);
    bySubject.set(quad.subject, entry);
  }

  const byRef = new Map<string, PublicSnapshotMetadata>();
  for (const [subject, entry] of bySubject) {
    if (!entry.ref) continue;
    if (!entry.digest || !Number.isInteger(entry.count)) {
      throw new Error(`Shared-memory public snapshot metadata for ${subject} is missing digest/count`);
    }
    const existing = byRef.get(entry.ref);
    const metadata = { ref: entry.ref, digest: entry.digest, count: entry.count! };
    if (existing && (existing.digest !== metadata.digest || existing.count !== metadata.count)) {
      throw new Error(`Conflicting shared-memory public snapshot metadata for ${entry.ref}`);
    }
    byRef.set(entry.ref, metadata);
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
