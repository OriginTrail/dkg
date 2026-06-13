import {
  createOperationContext,
  QuietRetryableHandlerError,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  serializeWorkspacePublicSnapshotQuads,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../durable-session.js';
import {
  createResponderGraphListMemo,
  createResponderSyncRowListMemo,
  createResponderSubGraphRegistrationMemo,
  createResponderSwmAdmissionMemo,
  readDurableDataPage,
  readDurableMetaPage,
  readSwmDataPage,
  readSwmMetaPage,
  serializeResponderRows,
} from './graph-plan.js';

const MAX_SYNC_SESSION_TOKENS = 256;

type SyncSessionTokenEntry = {
  token: string;
  expiresAt: number;
};

type PreparedResponderSession = {
  rowListCacheKey: string;
  refreshRowList: boolean;
};

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
    handler: (data: Uint8Array, peerId: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array>,
  ) => void;
  protocolSync: string;
  syncDeniedResponse: string;
  syncPageSize: number;
  sharedMemoryTtlMs: number;
  store: TripleStore;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  peerId: string;
  parseSyncRequest: (data: Uint8Array) => SyncRequestEnvelope;
  authorizeSyncRequest: (
    request: SyncRequestEnvelope,
    remotePeerId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

const SYNC_RESPONDER_GLOBAL_CONCURRENCY = 3;
const SYNC_RESPONDER_PER_PEER_CONCURRENCY = 1;
const SYNC_RESPONDER_QUEUE_LIMIT = 32;
const SYNC_RESPONDER_PER_PEER_QUEUE_LIMIT = 4;
const SYNC_RESPONDER_MAX_QUEUE_WAIT_MS = 10_000;

class SyncResponderBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncResponderBusyError';
  }
}

interface SyncResponderQueueEntry {
  peerId: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

function createSyncResponderLimiter() {
  let running = 0;
  const runningByPeer = new Map<string, number>();
  const queuedByPeer = new Map<string, number>();
  const queue: SyncResponderQueueEntry[] = [];

  const canRun = (peerId: string): boolean =>
    running < SYNC_RESPONDER_GLOBAL_CONCURRENCY &&
    (runningByPeer.get(peerId) ?? 0) < SYNC_RESPONDER_PER_PEER_CONCURRENCY;

  const releaseFor = (peerId: string): (() => void) => {
    let released = false;
    running += 1;
    runningByPeer.set(peerId, (runningByPeer.get(peerId) ?? 0) + 1);
    return () => {
      if (released) return;
      released = true;
      running -= 1;
      const peerRunning = (runningByPeer.get(peerId) ?? 1) - 1;
      if (peerRunning <= 0) runningByPeer.delete(peerId);
      else runningByPeer.set(peerId, peerRunning);
      pump();
    };
  };

  const incrementQueued = (peerId: string): void => {
    queuedByPeer.set(peerId, (queuedByPeer.get(peerId) ?? 0) + 1);
  };

  const decrementQueued = (peerId: string): void => {
    const count = (queuedByPeer.get(peerId) ?? 1) - 1;
    if (count <= 0) queuedByPeer.delete(peerId);
    else queuedByPeer.set(peerId, count);
  };

  const removeQueued = (entry: SyncResponderQueueEntry): boolean => {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    decrementQueued(entry.peerId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    return true;
  };

  const startQueued = (entry: SyncResponderQueueEntry): void => {
    decrementQueued(entry.peerId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(releaseFor(entry.peerId));
  };

  const pump = (): void => {
    for (let i = 0; i < queue.length && running < SYNC_RESPONDER_GLOBAL_CONCURRENCY;) {
      const entry = queue[i];
      if (!canRun(entry.peerId)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      startQueued(entry);
    }
  };

  const acquire = (peerId: string, signal?: AbortSignal): Promise<() => void> => {
    throwIfAborted(signal);
    if (canRun(peerId)) return Promise.resolve(releaseFor(peerId));
    if (queue.length >= SYNC_RESPONDER_QUEUE_LIMIT) {
      throw new SyncResponderBusyError('sync responder queue full');
    }
    if ((queuedByPeer.get(peerId) ?? 0) >= SYNC_RESPONDER_PER_PEER_QUEUE_LIMIT) {
      throw new SyncResponderBusyError('sync responder peer queue full');
    }
    return new Promise((resolve, reject) => {
      const entry: SyncResponderQueueEntry = {
        peerId,
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          if (removeQueued(entry)) reject(new SyncResponderBusyError('sync responder queue wait exceeded'));
        }, SYNC_RESPONDER_MAX_QUEUE_WAIT_MS),
      };
      entry.onAbort = () => {
        if (removeQueued(entry)) reject(asAbortError(signal?.reason));
      };
      incrementQueued(peerId);
      queue.push(entry);
      if (signal) {
        signal.addEventListener('abort', entry.onAbort, { once: true });
        if (signal.aborted) entry.onAbort();
      }
    });
  };

  return {
    async run<T>(peerId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
      const release = await acquire(peerId, signal);
      try {
        throwIfAborted(signal);
        return await fn();
      } finally {
        release();
      }
    },
  };
}

function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
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
  const graphListMemo = createResponderGraphListMemo(store);
  const durableDataRowsMemo = createResponderSyncRowListMemo(DURABLE_DATA_SYNC_SESSION_TTL_MS);
  const durableMetaRowsMemo = createResponderSyncRowListMemo(DURABLE_DATA_SYNC_SESSION_TTL_MS);
  const swmRowsMemo = createResponderSyncRowListMemo(DURABLE_DATA_SYNC_SESSION_TTL_MS);
  const syncSessionTokens = new Map<string, SyncSessionTokenEntry>();
  const subGraphRegistrationMemo = createResponderSubGraphRegistrationMemo(store);
  const swmAdmissionMemo = createResponderSwmAdmissionMemo(store);
  const limiter = createSyncResponderLimiter();
  let warnedPreDispatchCancellation = false;

  const pruneSyncSessionTokens = (now = Date.now()) => {
    for (const [key, entry] of syncSessionTokens) {
      if (entry.expiresAt <= now) syncSessionTokens.delete(key);
    }
    while (syncSessionTokens.size > MAX_SYNC_SESSION_TOKENS) {
      const oldest = syncSessionTokens.keys().next().value;
      if (!oldest) break;
      syncSessionTokens.delete(oldest);
    }
  };

  const rememberSyncSessionToken = (key: string, token: string, now = Date.now()) => {
    pruneSyncSessionTokens(now);
    if (!syncSessionTokens.has(key) && syncSessionTokens.size >= MAX_SYNC_SESSION_TOKENS) {
      const oldest = syncSessionTokens.keys().next().value;
      if (oldest) syncSessionTokens.delete(oldest);
    }
    syncSessionTokens.set(key, {
      token,
      expiresAt: now + DURABLE_DATA_SYNC_SESSION_TTL_MS,
    });
  };

  const prepareResponderSession = (
    label: string,
    key: string,
    token: string | undefined,
    offset: number,
    now = Date.now(),
  ): PreparedResponderSession | undefined => {
    if (!token) return undefined;
    pruneSyncSessionTokens(now);
    const activeToken = syncSessionTokens.get(key)?.token;
    if (offset > 0 && activeToken !== token) {
      throw new Error(`${label} sync session was superseded before page completion`);
    }
    const refreshRowList = offset === 0 && activeToken !== token;
    rememberSyncSessionToken(key, token, now);
    return {
      rowListCacheKey: key,
      refreshRowList,
    };
  };

  register(protocolSync, async (data, peerId, options) => {
    const signal = options?.signal;
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
    throwIfAborted(signal);

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

    return limiter.run(peerId, signal, async () => {
      throwIfAborted(signal);
      const authStartedAt = Date.now();
      const authorized = await authorizeSyncRequest(request, peerId, { signal });
      const authDurationMs = Date.now() - authStartedAt;
      throwIfAborted(signal);
      if (!authorized) {
        logWarn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
        return new TextEncoder().encode(syncDeniedResponse);
      }

      if (store.queryCancellation === 'pre-dispatch' && !warnedPreDispatchCancellation) {
        warnedPreDispatchCancellation = true;
        logWarn(
          createOperationContext('sync'),
          'Sync responder is using a store backend whose query AbortSignal is pre-dispatch only; in-flight sync queries cannot release responder capacity until the synchronous store call returns. Use oxigraph-worker or an HTTP SPARQL backend for interruptible long-query cancellation.',
        );
      }
      if (isWorkspace) {
        const cutoff = sharedMemoryTtlMs > 0 ? new Date(Date.now() - sharedMemoryTtlMs).toISOString() : null;
        if (phase === 'snapshot') {
          const snapshotRef = request.snapshotRef?.trim();
          if (!snapshotRef || !publicSnapshotStore) {
            return new TextEncoder().encode('');
          }
          const snapshot = await raceAgainstAbort(publicSnapshotStore.getSnapshot(snapshotRef), signal);
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
          const session = prepareResponderSession(
            'Shared memory meta',
            `${peerId}:swm-meta:${contextGraphId}`,
            request.syncSessionId,
            offset,
          );
          const rows = await readSwmMetaPage({
            store,
            graphList: await graphListMemo.get({ refresh: offset === 0, signal }),
            registeredSubGraphNames: await swmAdmissionMemo.get(
              contextGraphId,
              { refresh: offset === 0, signal },
            ),
            contextGraphId,
            cutoffIso: cutoff,
            offset,
            limit,
            signal,
            rowListMemo: session ? swmRowsMemo : undefined,
            rowListCacheKey: session?.rowListCacheKey,
            refreshRowList: session?.refreshRowList,
          });
          const queryDurationMs = Date.now() - queryStartedAt;
          const serializeStartedAt = Date.now();
          const serialized = serializeResponderRows(rows);
          if (serialized) nquads.push(serialized);
          const serializeDurationMs = Date.now() - serializeStartedAt;
          logDebug(createOperationContext('sync'), `Sync responder SWM meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
        } else {
          const queryStartedAt = Date.now();
          const session = prepareResponderSession(
            'Shared memory data',
            `${peerId}:swm-data:${contextGraphId}`,
            request.syncSessionId,
            offset,
          );
          const rows = await readSwmDataPage({
            store,
            graphList: await graphListMemo.get({ refresh: offset === 0, signal }),
            registeredSubGraphNames: await swmAdmissionMemo.get(
              contextGraphId,
              { refresh: offset === 0, signal },
            ),
            contextGraphId,
            cutoffIso: cutoff,
            offset,
            limit,
            signal,
            rowListMemo: session ? swmRowsMemo : undefined,
            rowListCacheKey: session?.rowListCacheKey,
            refreshRowList: session?.refreshRowList,
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
        const session = prepareResponderSession(
          'Durable meta',
          `${peerId}:durable-meta:${contextGraphId}`,
          request.syncSessionId,
          offset,
        );
        const rows = await readDurableMetaPage({
          store,
          contextGraphId,
          registeredSubGraphNames: await subGraphRegistrationMemo.get(
            contextGraphId,
            { refresh: offset === 0, signal },
          ),
          offset,
          limit,
          signal,
          rowListMemo: session ? durableMetaRowsMemo : undefined,
          rowListCacheKey: session?.rowListCacheKey,
          refreshRowList: session?.refreshRowList,
        });
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        const serialized = serializeResponderRows(rows);
        if (serialized) nquads.push(serialized);
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder durable meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        const queryStartedAt = Date.now();
        const session = prepareResponderSession(
          'Durable data',
          `${peerId}:durable-data:${contextGraphId}:${sinceBatchId == null ? 'full' : sinceBatchId.toString()}`,
          request.syncSessionId,
          offset,
        );
        const rows = await readDurableDataPage({
          store,
          graphList: await graphListMemo.get({ refresh: offset === 0, signal }),
          contextGraphId,
          sinceBatchId,
          offset,
          limit,
          signal,
          rowListMemo: session ? durableDataRowsMemo : undefined,
          rowListCacheScope: session ? peerId : undefined,
          refreshRowList: session?.refreshRowList,
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
    }).catch((err) => {
      if (err instanceof SyncResponderBusyError) {
        logDebug(createOperationContext('sync'), `Sync responder busy for "${contextGraphId}" from peer ${peerId} (phase=${phase}): ${err.message}`);
        throw new QuietRetryableHandlerError(err.message);
      }
      throw err;
    });
  });
}
