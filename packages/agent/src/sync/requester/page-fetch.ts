import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { sendSyncRequest } from '../../p2p/sync-transport.js';
import type { SyncPhase } from '../auth/request-build.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../checkpoint/state.js';
import {
  createDurableDataSyncSessionId,
  createSyncResponderSessionId,
  DURABLE_DATA_SYNC_SESSION_TTL_MS,
} from '../durable-session.js';

const MAX_UNFINISHED_SYNC_RESPONDER_SESSIONS = 4096;
type UnfinishedSyncResponderSession = {
  syncSessionId: string;
  expiresAt: number;
};

const unfinishedSyncResponderSessions = new Map<string, UnfinishedSyncResponderSession>();

function getUnfinishedSyncResponderSession(checkpointKey: string, now = Date.now()): UnfinishedSyncResponderSession | undefined {
  const session = unfinishedSyncResponderSessions.get(checkpointKey);
  if (!session) return undefined;
  if (session.expiresAt > now) return session;
  unfinishedSyncResponderSessions.delete(checkpointKey);
  return undefined;
}

function rememberUnfinishedSyncResponderSession(checkpointKey: string, session: UnfinishedSyncResponderSession, now = Date.now()): void {
  if (session.expiresAt <= now) {
    unfinishedSyncResponderSessions.delete(checkpointKey);
    return;
  }
  if (!unfinishedSyncResponderSessions.has(checkpointKey) && unfinishedSyncResponderSessions.size >= MAX_UNFINISHED_SYNC_RESPONDER_SESSIONS) {
    const oldest = unfinishedSyncResponderSessions.keys().next().value;
    if (oldest) unfinishedSyncResponderSessions.delete(oldest);
  }
  unfinishedSyncResponderSessions.set(checkpointKey, session);
}

function isSyncResponderSessionSupersededError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('sync session was superseded');
}

function usesResponderSession(includeSharedMemory: boolean, phase: SyncPhase): boolean {
  void includeSharedMemory;
  return phase !== 'snapshot';
}

function createResponderSessionId(includeSharedMemory: boolean, phase: SyncPhase): string {
  if (!includeSharedMemory && phase === 'data') return createDurableDataSyncSessionId();
  return createSyncResponderSessionId(`${includeSharedMemory ? 'swm' : 'durable'}-${phase}`);
}

export interface SyncPageResult {
  quads: Quad[];
  bytesReceived: number;
  resumedFromOffset: number;
  nextOffset: number;
  checkpointKey: string;
  completed: boolean;
}

interface FetchSyncPagesParams {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  graphUri: string;
  snapshotRef?: string;
  deadline: number;
  syncPageTimeoutMs: number;
  syncRouterAttempts: number;
  syncPageRetryAttempts: number;
  syncPageSize: number;
  syncDeniedResponse: string;
  signal?: AbortSignal;
  /**
   * Additional response-body sentinels that also mean "ACL denied". Exists so
   * this requester keeps recognising the legacy `#DKG-SYNC-ACCESS-DENIED`
   * marker emitted by older (pre-sync-refactor) responders while they are
   * still around during a rolling upgrade. Without this, a legacy denial
   * would be parsed as N-quads, yield 0 triples, and silently get classified
   * as "peer had nothing to send" instead of flipping `deniedPhases`. Empty
   * / unset means only `syncDeniedResponse` is treated as a denial. Callers
   * that don't care about legacy compatibility can omit this. (tier-4 G1)
   */
  extraDeniedResponses?: readonly string[];
  debugSyncProgress: boolean;
  protocolSync: string;
  checkpointStore: SyncCheckpointStore;
  buildSyncRequest: (contextGraphId: string, offset: number, limit: number, includeSharedMemory: boolean, remotePeerId: string, phase?: SyncPhase, snapshotRef?: string, sinceBatchId?: string, syncSessionId?: string) => Promise<Uint8Array>;
  /**
   * Phase C — optional, gap-safe delta-sync high-water mark. Forwarded to the
   * responder for the durable DATA phase so it returns only KAs with
   * `dkg:batchId > sinceBatchId`. MUST originate from a CONTIGUOUS watermark
   * (never local MAX, which would skip gaps). Omitted ⇒ full scan.
   */
  sinceBatchId?: string;
  parseAndFilter: (nquadsText: string, graphUri: string, contextGraphId: string) => Promise<{ quads: Quad[]; totalQuads: number }>;
  /**
   * Per-attempt send hook. `DKGAgent`'s production adapter sends raw
   * via `messenger.sendToPeer` (ProtocolRouter pass-through), not
   * `messenger.sendReliable`, because sync is intentionally off the
   * Universal Messenger substrate. `sendSyncRequest` still mints a
   * fresh `messageId` per retry attempt for transport-surface
   * stability and older test adapters that record it. Stable IDs were
   * explored on this PR (codex review #569 follow-ups #1, #4, #5,
   * #6, #7, #8) but every variant either defeated sender-side dedup OR
   * enabled silent replay of stale cached responses past sync's
   * app-layer freshness gate (`SYNC_AUTH_MAX_AGE_MS`). Fresh-per-
   * attempt is the only design that holds under all timing scenarios —
   * see jsdoc on `sendSyncRequest` for the full rationale.
   */
  send: (
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs: number,
    messageId: string,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

function decodeSyncResponse(responseBytes: Uint8Array): string {
  return new TextDecoder().decode(responseBytes).trim();
}

// Compatibility-only: current responders must not emit this body on the
// unchanged sync protocol, but requesters may still meet A2 pre-fix peers
// during local/integration rolling tests. Treat it as retryable, not EOF.
const LEGACY_SYNC_BUSY_RESPONSE = '__DKG_SYNC_BUSY__';

function makeLegacySyncBusyError(remotePeerId: string, contextGraphId: string, phase: SyncPhase): Error {
  return new Error(`Legacy sync responder busy at ${remotePeerId} for "${contextGraphId}" (${phase})`);
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    reason.name = 'AbortError';
    return reason;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

export async function fetchSyncPages(params: FetchSyncPagesParams): Promise<SyncPageResult> {
  const {
    ctx,
    remotePeerId,
    contextGraphId,
    includeSharedMemory,
    phase,
    graphUri,
    snapshotRef,
    deadline,
    syncPageTimeoutMs,
    syncRouterAttempts,
    syncPageRetryAttempts,
    syncPageSize,
    syncDeniedResponse,
    signal,
    extraDeniedResponses,
    debugSyncProgress,
    protocolSync,
    checkpointStore,
    buildSyncRequest,
    sinceBatchId,
    parseAndFilter,
    send,
    logWarn,
    logInfo,
    logDebug,
  } = params;

  const allQuads: Quad[] = [];
  throwIfAborted(signal);
  const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, includeSharedMemory, phase, snapshotRef, sinceBatchId);
  let offset = checkpointStore.get(checkpointKey) ?? 0;
  const usesPageSession = usesResponderSession(includeSharedMemory, phase);
  const sessionStartedAt = Date.now();
  const savedResponderSession = usesPageSession
    ? getUnfinishedSyncResponderSession(checkpointKey, sessionStartedAt)
    : undefined;
  if (usesPageSession && offset > 0 && !savedResponderSession) {
    checkpointStore.delete(checkpointKey);
    offset = 0;
  }
  const resumedFromOffset = offset;
  let bytesReceived = 0;
  let timedOut = false;
  const syncSessionId = usesPageSession
    ? (savedResponderSession?.syncSessionId ?? createResponderSessionId(includeSharedMemory, phase))
    : undefined;
  const responderSession = usesPageSession && syncSessionId
    ? {
      syncSessionId,
      expiresAt: savedResponderSession?.expiresAt ?? sessionStartedAt + DURABLE_DATA_SYNC_SESSION_TTL_MS,
    }
    : undefined;

  try {
    while (true) {
      throwIfAborted(signal);
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      const remainingMs = Math.max(0, deadline - Date.now());
      const timeoutMs = Math.min(
        syncPageTimeoutMs,
        Math.max(2000, Math.floor(remainingMs / syncRouterAttempts)),
      );

      const curOffset = offset;
      const transportStartedAt = Date.now();
      const responseBytes = await sendSyncRequest({
        remotePeerId,
        timeoutMs,
        retryAttempts: syncPageRetryAttempts,
        signal,
        contextGraphId,
        offset,
        protocolId: protocolSync,
        // `requestFactory` runs per-attempt so each retry carries a
        // fresh `issuedAtMs`/`requestId`. Required for sync's auth
        // gate (`SYNC_AUTH_MAX_AGE_MS` freshness TTL +
        // `seenRequestIds` replay protection). The matching
        // fresh-messageId-per-attempt is generated inside
        // `sendSyncRequest`. See `sendSyncRequest`'s jsdoc for the
        // full rationale (codex review on #569 follow-ups #1, #4-#8).
        requestFactory: async () => {
          throwIfAborted(signal);
          const request = await buildSyncRequest(contextGraphId, curOffset, syncPageSize, includeSharedMemory, remotePeerId, phase, snapshotRef, sinceBatchId, syncSessionId);
          throwIfAborted(signal);
          return request;
        },
        send,
        validateResponse: (responseBytes) => {
          if (decodeSyncResponse(responseBytes) === LEGACY_SYNC_BUSY_RESPONSE) {
            throw makeLegacySyncBusyError(remotePeerId, contextGraphId, phase);
          }
        },
        onRetry: (attempt, delay, err) => {
          logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      const transportDurationMs = Date.now() - transportStartedAt;
      throwIfAborted(signal);

      const decodeStartedAt = Date.now();
      const nquadsText = decodeSyncResponse(responseBytes);
      const decodeDurationMs = Date.now() - decodeStartedAt;
      bytesReceived += responseBytes.byteLength;
      if (
        nquadsText === syncDeniedResponse ||
        (extraDeniedResponses && extraDeniedResponses.includes(nquadsText))
      ) {
        const error = new Error(`Sync denied by ${remotePeerId} for "${contextGraphId}" (${phase})`);
        (error as Error & { syncDenied?: boolean }).syncDenied = true;
        throw error;
      }
      if (!nquadsText) break;

      const parseStartedAt = Date.now();
      const parsed = await parseAndFilter(nquadsText, graphUri, contextGraphId);
      throwIfAborted(signal);
      const parseDurationMs = Date.now() - parseStartedAt;

      const stepDurationMs = transportDurationMs + decodeDurationMs + parseDurationMs;
      if (stepDurationMs > 100) {
        logDebug(
          ctx,
          `Sync page timing for "${contextGraphId}" offset=${curOffset} phase=${phase}: transport=${transportDurationMs}ms decode=${decodeDurationMs}ms parse=${parseDurationMs}ms`,
        );
      }

      if (parsed.totalQuads === 0) {
        if (parsed.quads.length > 0) allQuads.push(...parsed.quads);
        break;
      }

      allQuads.push(...parsed.quads);
      offset += parsed.totalQuads;

      if (debugSyncProgress) {
        logInfo(
          ctx,
          `Sync progress for "${contextGraphId}" ${includeSharedMemory ? 'shared-memory' : 'durable'} ${phase}: transferred=${allQuads.length} bytes=${bytesReceived} offset=${offset}`,
        );
      }
      if (parsed.totalQuads < syncPageSize) break;
    }
  } catch (err) {
    if (usesPageSession && isSyncResponderSessionSupersededError(err)) {
      unfinishedSyncResponderSessions.delete(checkpointKey);
      checkpointStore.delete(checkpointKey);
    } else if (usesPageSession && responderSession && !(err as Error & { syncDenied?: boolean }).syncDenied) {
      rememberUnfinishedSyncResponderSession(checkpointKey, responderSession);
    }
    throw err;
  }

  if (usesPageSession && responderSession) {
    if (timedOut) rememberUnfinishedSyncResponderSession(checkpointKey, responderSession);
    else unfinishedSyncResponderSessions.delete(checkpointKey);
  }

  if (timedOut) {
    const scope = includeSharedMemory ? 'shared-memory' : 'durable';
    logWarn(
      ctx,
      `Sync timeout for ${scope} ${phase} phase of "${contextGraphId}" (${allQuads.length} triples received so far for ${graphUri})`,
    );
  }

  return {
    quads: allQuads,
    bytesReceived,
    resumedFromOffset,
    nextOffset: offset,
    checkpointKey,
    completed: !timedOut,
  };
}
