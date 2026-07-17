import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  sendSyncRequest,
  type SingleUseSyncSender,
} from '../../p2p/sync-transport.js';
import { markSyncPeerResponded } from '../error-tags.js';
import { appendInPlace } from '../append-in-place.js';
import type { SyncPhase } from '../auth/request-build.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../checkpoint/state.js';
import {
  createDurableDataSyncSessionId,
  createSyncResponderSessionId,
  DURABLE_DATA_SYNC_SESSION_TTL_MS,
} from '../durable-session.js';
import {
  createRequesterPhaseTelemetry,
} from '../memory-telemetry.js';
import {
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../../dkg-agent-constants.js';

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

function getPersistedSyncResponderSession(
  checkpoint: ReturnType<SyncCheckpointStore['get']>,
  now = Date.now(),
): UnfinishedSyncResponderSession | undefined {
  if (
    !checkpoint?.responderSessionId
    || !Number.isSafeInteger(checkpoint.responderSessionExpiresAtMs)
    || (checkpoint.responderSessionExpiresAtMs ?? 0) <= now
  ) return undefined;
  return {
    syncSessionId: checkpoint.responderSessionId,
    expiresAt: checkpoint.responderSessionExpiresAtMs!,
  };
}

function persistUnfinishedSyncResponderSession(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
  session: UnfinishedSyncResponderSession,
  now = Date.now(),
): void {
  rememberUnfinishedSyncResponderSession(checkpointKey, session, now);
  checkpointStore.setResponderSession?.(
    checkpointKey,
    session.syncSessionId,
    session.expiresAt,
    now,
  );
}

function forgetUnfinishedSyncResponderSession(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
): void {
  unfinishedSyncResponderSessions.delete(checkpointKey);
  checkpointStore.clearResponderSession?.(checkpointKey);
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
  timedOut: boolean;
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
  /**
   * Discard both the saved offset and the requester-side responder-session
   * token before this fetch. A caller applying an authoritative snapshot uses
   * this to guarantee that offset zero carries a NEW syncSessionId, which
   * forces the responder to rebuild its cached row list instead of replaying
   * an unfinished session's stale offset-zero view.
   */
  forceFreshSession?: boolean;
  /**
   * R9/R10 — member SWM recovery marker. Forks BOTH the checkpoint namespace
   * (R10: distinct `|recovery` cursor + responder-session scope so it never
   * mutates the shared incremental-sync cursor) AND the request envelope (R9:
   * forwarded to `buildSyncRequest` so the responder gates it via the strict
   * members-only `isMemberRecoveryAuthorized`). Default false ⇒ normal sync.
   */
  recovery?: boolean;
  buildSyncRequest: (contextGraphId: string, offset: number, limit: number, includeSharedMemory: boolean, remotePeerId: string, phase?: SyncPhase, snapshotRef?: string, sinceBatchId?: string, syncSessionId?: string, recovery?: boolean) => Promise<Uint8Array>;
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
   * see jsdoc on `sendSyncRequest` for the full rationale. Production creates
   * this hook with `createSingleUseSyncSender`, which prevents lower layers
   * from replaying an envelope before the outer retry can rebuild it.
   */
  send: SingleUseSyncSender;
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
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
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
    forceFreshSession,
    recovery,
    buildSyncRequest,
    sinceBatchId,
    parseAndFilter,
    send,
    logWarn,
    logInfo,
    logDebug,
  } = params;

  const allQuads: Quad[] = [];
  // Check for a pre-aborted signal BEFORE starting phase telemetry so a caller
  // that passes an already-aborted signal never records a phase_start without a
  // terminal outcome. Every started phase is guaranteed a finish() below.
  throwIfAborted(signal);
  const phaseTelemetry = createRequesterPhaseTelemetry({ includeSharedMemory, phase });
  const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, includeSharedMemory, phase, snapshotRef, sinceBatchId, recovery);
  if (forceFreshSession) {
    checkpointStore.delete(checkpointKey);
    unfinishedSyncResponderSessions.delete(checkpointKey);
  }
  const checkpoint = checkpointStore.get(checkpointKey);
  let offset = checkpoint?.offset ?? 0;
  const usesPageSession = usesResponderSession(includeSharedMemory, phase);
  const sessionStartedAt = Date.now();
  // A successful caller deletes the checkpoint after verification/storage.
  // The process-local cache can outlive that synchronous delete, so never let
  // a cache-only token resurrect a completed snapshot at offset zero.
  if (!checkpoint) unfinishedSyncResponderSessions.delete(checkpointKey);
  const savedResponderSession = usesPageSession
    ? (
        (checkpoint
          ? getUnfinishedSyncResponderSession(checkpointKey, sessionStartedAt)
          : undefined)
        ?? getPersistedSyncResponderSession(checkpoint, sessionStartedAt)
      )
    : undefined;
  if (usesPageSession && offset > 0 && !savedResponderSession) {
    checkpointStore.delete(checkpointKey);
    offset = 0;
  }
  const resumedFromOffset = offset;
  let bytesReceived = 0;
  let responsePages = 0;
  let timedOut = false;
  // Start with the throughput-oriented page size, but reduce it within the
  // existing bounded retry budget if a response cannot traverse the wire.
  // ProtocolRouter may surface an oversized response as a generic stream reset,
  // so the reduction intentionally applies to any retryable transport failure.
  // A transient failure merely makes the remainder of this phase conservative;
  // it never changes offsets or responder-session identity.
  const safePageSize = Math.min(syncPageSize, SYNC_REQUEST_SAFE_PAGE_SIZE);
  const usesByteBudgetPagination = syncPageSize > SYNC_PAGE_SIZE;
  let activePageSize = syncPageSize;
  let successfulPageSize = syncPageSize;
  let consecutiveSuccessfulPages = 0;
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
          successfulPageSize = activePageSize;
          const request = await buildSyncRequest(contextGraphId, curOffset, activePageSize, includeSharedMemory, remotePeerId, phase, snapshotRef, sinceBatchId, syncSessionId, recovery);
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
          const priorPageSize = activePageSize;
          if (activePageSize > safePageSize) {
            // Adapt to the actual path capacity instead of falling all the way
            // from 8192 rows to the 64-row emergency floor. A lossy relay can
            // often carry 1k-4k rows reliably; halving finds that stable point
            // within the existing retry budget without turning the remainder
            // of the phase into hundreds of tiny round trips.
            activePageSize = Math.max(safePageSize, Math.floor(activePageSize / 2));
          }
          consecutiveSuccessfulPages = 0;
          const pageSizeNote = activePageSize < priorPageSize
            ? `; reducing page size ${priorPageSize}->${activePageSize}`
            : '';
          logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms${pageSizeNote}): ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      const transportDurationMs = Date.now() - transportStartedAt;
      throwIfAborted(signal);
      responsePages += 1;
      phaseTelemetry.recordPage();

      let parsed: { quads: Quad[]; totalQuads: number };
      let decodeDurationMs = 0;
      let parseDurationMs = 0;
      try {
        const decodeStartedAt = Date.now();
        const nquadsText = decodeSyncResponse(responseBytes);
        decodeDurationMs = Date.now() - decodeStartedAt;
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
        parsed = await parseAndFilter(nquadsText, graphUri, contextGraphId);
        throwIfAborted(signal);
        parseDurationMs = Date.now() - parseStartedAt;
        phaseTelemetry.recordQuads(parsed.quads);
      } catch (error) {
        markSyncPeerResponded(error);
        throw error;
      }

      const stepDurationMs = transportDurationMs + decodeDurationMs + parseDurationMs;
      if (stepDurationMs > 100) {
        logDebug(
          ctx,
          `Sync page timing for "${contextGraphId}" offset=${curOffset} phase=${phase}: transport=${transportDurationMs}ms decode=${decodeDurationMs}ms parse=${parseDurationMs}ms`,
        );
      }

      if (parsed.totalQuads === 0) {
        if (parsed.quads.length > 0) appendInPlace(allQuads, parsed.quads);
        break;
      }

      appendInPlace(allQuads, parsed.quads);
      offset += parsed.totalQuads;
      // Keep the size that actually crossed the path. Probe upward only after
      // three consecutive successful pages, and at most double at a time.
      // This avoids the old 8192 -> 64 -> 8192 oscillation where every useful
      // page paid for a doomed large request and its timeout first.
      if (usesByteBudgetPagination && activePageSize < syncPageSize) {
        consecutiveSuccessfulPages += 1;
        if (consecutiveSuccessfulPages >= 3) {
          activePageSize = Math.min(syncPageSize, activePageSize * 2);
          consecutiveSuccessfulPages = 0;
        }
      } else {
        consecutiveSuccessfulPages = 0;
      }

      if (debugSyncProgress) {
        logInfo(
          ctx,
          `Sync progress for "${contextGraphId}" ${includeSharedMemory ? 'shared-memory' : 'durable'} ${phase}: transferred=${allQuads.length} bytes=${bytesReceived} offset=${offset}`,
        );
      }
      // A new responder may deliberately return a short prefix to stay inside
      // its byte budget, while an old responder returns at most its legacy
      // 500-row cap. Therefore short pages are not EOF in negotiated mode; an
      // explicit empty response is. Legacy pagination keeps the old shortcut.
      if (!usesByteBudgetPagination && parsed.totalQuads < successfulPageSize) break;
    }
  } catch (err) {
    const denied = (err as Error & { syncDenied?: boolean }).syncDenied === true;
    if (usesPageSession && isSyncResponderSessionSupersededError(err)) {
      // Exact-message match — only fires IN-PROCESS (same-node tests). Over the
      // wire the responder's "superseded" text is destroyed by the router's
      // stream.abort (it becomes a generic reset), which is why the
      // `resumedFromOffset > 0` branch below is the real network-path fix.
      unfinishedSyncResponderSessions.delete(checkpointKey);
      checkpointStore.delete(checkpointKey);
    } else if (usesPageSession && responderSession && !recovery && !denied) {
      if (resumedFromOffset > 0 && responsePages === 0) {
        // R1 fix (2026-07-07 sync storm). This round RESUMED a saved session at
        // offset>0 and then aborted. The responder supersedes any resume whose
        // session token it no longer holds (a concurrent flow to the same
        // peer+CG+phase rotated it), throwing "session superseded" — but that
        // message never survives the router's stream.abort, so from here a
        // supersede is indistinguishable from a plain mid-stream transport
        // drop. Re-saving is a trap in BOTH readings: the retry resumes at
        // offset>0 with a session id the responder won't honour (offset>0 +
        // non-active token => it supersedes AGAIN), looping for the full
        // session TTL (~10 min) while peer backoff compounds. Drop BOTH the
        // session and the checkpoint (exactly as the in-process superseded
        // branch above does) so the retry mints a fresh id and sends offset 0
        // => the responder refreshes its row list and serves from the start —
        // real progress instead of a stuck loop, and the loop-kill stops the
        // backoff from compounding. A FRESH round (resumedFromOffset === 0)
        // that merely advanced then blipped is NOT dropped: its resume is
        // likely valid, and a supersede there just costs one wasted resume
        // attempt before this branch catches it next round. Precise
        // per-supersede handling that never loses resume is the
        // in-band-sentinel follow-up. This inference is valid only when the
        // responder accepted ZERO pages in this round. Once at least one page
        // has succeeded, the responder demonstrably accepted this exact token;
        // a later stream/dial failure is therefore safe to retry from the last
        // previously certified checkpoint. At worst, a concurrent supersession
        // after that accepted page costs one extra retry: its zero-page failure
        // reaches this branch and then rotates the session safely.
        unfinishedSyncResponderSessions.delete(checkpointKey);
        checkpointStore.delete(checkpointKey);
      } else {
        // Fresh round, or a resumed round that demonstrably delivered at least
        // one page with this token: keep the session so a retry can resume from
        // the last certified checkpoint. Recovery never persists a responder
        // session to resume (see the timeout branch below + Codex #1173).
        const refreshedResponderSession = responsePages > 0
          ? {
              ...responderSession,
              // The responder touches both its token and immutable row-list
              // TTL on every successfully served page. Mirror that sliding
              // expiry locally so a long, progressing snapshot is not forced
              // back to offset zero merely because it crossed ten minutes.
              expiresAt: Date.now() + DURABLE_DATA_SYNC_SESSION_TTL_MS,
            }
          : responderSession;
        persistUnfinishedSyncResponderSession(
          checkpointStore,
          checkpointKey,
          refreshedResponderSession,
        );
      }
    }
    phaseTelemetry.finish('error', allQuads.length);
    throw err;
  }

  if (usesPageSession && responderSession) {
    // R10 recovery has its own responder-session scope and MUST rebuild the
    // COMPLETE state from offset 0 on every (re)try (see swm-recovery
    // `fetchPhaseFully`, which deletes the checkpoint on a partial abandon). It
    // must therefore NEVER persist a responder session to resume: reusing the
    // cached pre-timeout row list on a retry converges to a STALE snapshot (up to
    // the session TTL old) instead of current state, because the responder's
    // `refreshRowList` only fires on a NEW syncSessionId (Codex #1173). Drop the
    // session so the retry mints a fresh id and the responder re-reads.
    if (!recovery) {
      // Durable rootless verification may safely reclassify a transport-
      // complete response as an incomplete manifest prefix. Retain the token
      // until that higher layer deletes the checkpoint after a truly complete
      // verified/store commit, otherwise its safe offset cannot be resumed
      // even without a process restart. Persistent stores additionally write
      // the token through setResponderSession(); the process-local path keeps
      // older/custom checkpoint stores correct within one daemon lifetime.
      const refreshedResponderSession = responsePages > 0
        ? {
            ...responderSession,
            expiresAt: Date.now() + DURABLE_DATA_SYNC_SESSION_TTL_MS,
          }
        : responderSession;
      persistUnfinishedSyncResponderSession(
        checkpointStore,
        checkpointKey,
        refreshedResponderSession,
      );
    } else {
      forgetUnfinishedSyncResponderSession(checkpointStore, checkpointKey);
    }
  }

  if (timedOut) {
    const scope = includeSharedMemory ? 'shared-memory' : 'durable';
    logWarn(
      ctx,
      `Sync timeout for ${scope} ${phase} phase of "${contextGraphId}" (${allQuads.length} triples received so far for ${graphUri})`,
    );
  }

  phaseTelemetry.finish(timedOut ? 'timed_out' : 'completed', allQuads.length);

  return {
    quads: allQuads,
    bytesReceived,
    resumedFromOffset,
    nextOffset: offset,
    checkpointKey,
    completed: !timedOut,
    timedOut,
  };
}
