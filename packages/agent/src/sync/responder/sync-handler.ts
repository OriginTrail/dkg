import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  serializeWorkspacePublicSnapshotQuads,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import {
  readDurableCanonicalDataPage,
  readDurableDataPage,
  readDurableMetaPage,
  readSwmDataPage,
  readSwmMetaPage,
  serializeResponderRows,
} from './graph-plan.js';

interface RegisterSyncHandlerParams {
  /**
   * `register` callable. In production this is bound to the RAW
   * ProtocolRouter (via an adapter that re-exposes the string `peerId`),
   * not `Messenger.register`: sync runs outside the Universal Messenger
   * substrate as raw `/dkg/10.0.2/sync` so its large, never-reused page
   * responses are not cached in message_idempotency. The handler receives
   * the bare auth envelope `parseSyncRequest` expects and returns response
   * bytes for the router to send.
   */
  register: (
    protocolId: string,
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>,
  ) => void;
  protocolSync: string;
  syncDeniedResponse: string;
  syncPageSize: number;
  sharedMemoryTtlMs: number;
  store: TripleStore;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  peerId: string;
  parseSyncRequest: (data: Uint8Array) => SyncRequestEnvelope;
  authorizeSyncRequest: (request: SyncRequestEnvelope, remotePeerId: string) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export function registerSyncHandler(params: RegisterSyncHandlerParams): void {
  const {
    register,
    protocolSync,
    syncDeniedResponse,
    syncPageSize,
    sharedMemoryTtlMs,
    store,
    publicSnapshotStore,
    parseSyncRequest,
    authorizeSyncRequest,
    logWarn,
    logDebug,
  } = params;

  register(protocolSync, async (data, peerId) => {
    const handlerStartedAt = Date.now();
    const request = parseSyncRequest(data);
    const offset = Math.max(0, Math.min(Number.isSafeInteger(Number(request.offset)) ? Number(request.offset) : 0, 1_000_000));
    const limit = Math.max(1, Math.min(Number.isSafeInteger(Number(request.limit)) ? Number(request.limit) : syncPageSize, syncPageSize));
    const phase = request.phase ?? 'data';
    const isWorkspace = request.includeSharedMemory;
    const contextGraphId = request.contextGraphId;
    if (!contextGraphId || typeof contextGraphId !== 'string') {
      return new TextEncoder().encode('');
    }

    // Phase C: validate the optional delta hint into a non-negative bigint.
    // Malformed values are ignored so older or buggy requesters fall back to a
    // full scan instead of making the responder fail closed.
    let sinceBatchId: bigint | null = null;
    if (request.sinceBatchId != null && /^\d+$/.test(String(request.sinceBatchId))) {
      try {
        sinceBatchId = BigInt(String(request.sinceBatchId));
      } catch {
        sinceBatchId = null;
      }
    }
    const nquads: string[] = [];

    const authStartedAt = Date.now();
    const authorized = await authorizeSyncRequest(request, peerId);
    const authDurationMs = Date.now() - authStartedAt;
    if (!authorized) {
      logWarn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
      return new TextEncoder().encode(syncDeniedResponse);
    }

    if (isWorkspace) {
      const cutoff = sharedMemoryTtlMs > 0 ? new Date(Date.now() - sharedMemoryTtlMs).toISOString() : null;
      if (phase === 'snapshot') {
        const snapshotRef = request.snapshotRef?.trim();
        if (!snapshotRef || !publicSnapshotStore) {
          return new TextEncoder().encode('');
        }
        const snapshot = await publicSnapshotStore.getSnapshot(snapshotRef);
        if (!snapshot) {
          return new TextEncoder().encode('');
        }
        const page = snapshot.slice(offset, offset + limit);
        if (page.length === 0) {
          return new TextEncoder().encode('');
        }
        nquads.push(serializeWorkspacePublicSnapshotQuads(page).trimEnd());
        logDebug(createOperationContext('sync'), `Sync responder SWM snapshot for "${contextGraphId}" ref=${snapshotRef}: auth=${authDurationMs}ms quads=${page.length}`);
      } else if (phase === 'meta') {
        const queryStartedAt = Date.now();
        const rows = await readSwmMetaPage({
          store,
          graphList: await store.listGraphs(),
          contextGraphId,
          cutoffIso: cutoff,
          offset,
          limit,
        });
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        const serialized = serializeResponderRows(rows);
        if (serialized) nquads.push(serialized);
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        const queryStartedAt = Date.now();
        const rows = await readSwmDataPage({
          store,
          graphList: await store.listGraphs(),
          contextGraphId,
          cutoffIso: cutoff,
          offset,
          limit,
        });
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        const serialized = serializeResponderRows(rows);
        if (serialized) nquads.push(serialized);
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }

      if (nquads.length === 0) return new TextEncoder().encode('');
    } else if (phase === 'meta') {
      const queryStartedAt = Date.now();
      const rows = await readDurableMetaPage({ store, contextGraphId, offset, limit });
      const queryDurationMs = Date.now() - queryStartedAt;
      const serializeStartedAt = Date.now();
      const serialized = serializeResponderRows(rows);
      if (serialized) nquads.push(serialized);
      const serializeDurationMs = Date.now() - serializeStartedAt;
      logDebug(createOperationContext('sync'), `Sync responder durable meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
    } else {
      const queryStartedAt = Date.now();
      const rows = sinceBatchId == null
        ? await (async () => {
          const canonicalRows = await readDurableCanonicalDataPage({
            store,
            contextGraphId,
            offset,
            limit,
          });
          if (canonicalRows.length === limit) return canonicalRows;
          return readDurableDataPage({
            store,
            graphList: await store.listGraphs(),
            contextGraphId,
            sinceBatchId,
            offset,
            limit,
          });
        })()
        : await readDurableDataPage({
          store,
          graphList: await store.listGraphs(),
          contextGraphId,
          sinceBatchId,
          offset,
          limit,
        });
      const queryDurationMs = Date.now() - queryStartedAt;
      const serializeStartedAt = Date.now();
      const serialized = serializeResponderRows(rows);
      if (serialized) nquads.push(serialized);
      const serializeDurationMs = Date.now() - serializeStartedAt;
      logDebug(createOperationContext('sync'), `Sync responder durable data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
    }

    const totalDurationMs = Date.now() - handlerStartedAt;
    if (totalDurationMs > 100) {
      logDebug(createOperationContext('sync'), `Sync responder total for "${contextGraphId}" (phase=${phase}, workspace=${isWorkspace}): ${totalDurationMs}ms`);
    }
    return new TextEncoder().encode(nquads.join('\n'));
  });
}
