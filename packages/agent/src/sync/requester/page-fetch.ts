import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { sendSyncRequest } from '../../p2p/sync-transport.js';
import type { SyncPhase } from '../auth/request-build.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../checkpoint/state.js';

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
  buildSyncRequest: (contextGraphId: string, offset: number, limit: number, includeSharedMemory: boolean, remotePeerId: string, phase?: SyncPhase, snapshotRef?: string) => Promise<Uint8Array>;
  parseAndFilter: (nquadsText: string, graphUri: string, contextGraphId: string) => Promise<{ quads: Quad[]; totalQuads: number }>;
  /**
   * Per-attempt send hook. The substrate-backed implementation
   * (`DKGAgent`'s adapter routing through `messenger.sendReliable`)
   * receives a fresh `messageId` on EVERY retry attempt. Stable
   * messageIds were explored on this PR (codex review #569
   * follow-ups #1, #4, #5, #6, #7, #8) but every variant either
   * defeated sender-side dedup OR enabled silent replay of stale
   * cached responses past sync's app-layer freshness gate
   * (`SYNC_AUTH_MAX_AGE_MS`). Fresh-per-attempt is the only design
   * that holds under all timing scenarios — see jsdoc on
   * `sendSyncRequest` for the full rationale.
   */
  send: (
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs: number,
    messageId: string,
  ) => Promise<Uint8Array>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
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
    extraDeniedResponses,
    debugSyncProgress,
    protocolSync,
    checkpointStore,
    buildSyncRequest,
    parseAndFilter,
    send,
    logWarn,
    logInfo,
    logDebug,
  } = params;

  const allQuads: Quad[] = [];
  const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, includeSharedMemory, phase, snapshotRef);
  let offset = checkpointStore.get(checkpointKey) ?? 0;
  const resumedFromOffset = offset;
  let bytesReceived = 0;
  let timedOut = false;

  while (true) {
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
      requestFactory: () => buildSyncRequest(contextGraphId, curOffset, syncPageSize, includeSharedMemory, remotePeerId, phase, snapshotRef),
      send,
      onRetry: (attempt, delay, err) => {
        logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    const transportDurationMs = Date.now() - transportStartedAt;

    const decodeStartedAt = Date.now();
    const nquadsText = new TextDecoder().decode(responseBytes).trim();
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
    const parseDurationMs = Date.now() - parseStartedAt;
    if (parsed.totalQuads === 0) break;

    const stepDurationMs = transportDurationMs + decodeDurationMs + parseDurationMs;
    if (stepDurationMs > 100) {
      logDebug(
        ctx,
        `Sync page timing for "${contextGraphId}" offset=${curOffset} phase=${phase}: transport=${transportDurationMs}ms decode=${decodeDurationMs}ms parse=${parseDurationMs}ms`,
      );
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
