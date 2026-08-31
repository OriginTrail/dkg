import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  sendSyncRequest,
  type SingleUseSyncSender,
} from '../../p2p/sync-transport.js';
import {
  isKnownRetryableSyncTransportInterruption,
  isSyncBackoffWorthyError,
  isSyncTransportFailure,
  isSyncValidationRejection,
  toSyncPeerRespondedError,
} from '../error-tags.js';
import { syncPlaneFor } from '../attempt-telemetry.js';
import { appendInPlace } from '../append-in-place.js';
import type { SyncPhase } from '../auth/request-build.js';
import { exactAssetFilterKey } from '../exact-assets.js';
import {
  getSyncCheckpointKey,
  type DurableManifestDigest,
  type DurableManifestPrefixDigest,
  type SyncCheckpointScope,
  type SyncCheckpointStore,
} from '../checkpoint/state.js';
import {
  resolveManifestCheckpointDecision,
  resolveResponderResumeDecision,
  resolveResponderSessionLossCleanup,
} from './manifest-resume-policy.js';
import {
  createDurableDataSyncSessionId,
  createSyncResponderSessionId,
  DURABLE_DATA_SYNC_SESSION_TTL_MS,
} from '../durable-session.js';
import {
  createRequesterPhaseTelemetry,
  estimateQuadHeapBytes,
} from '../memory-telemetry.js';
import {
  SYNC_PAGE_SIZE,
  SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD,
  SYNC_REQUEST_INITIAL_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../../dkg-agent-constants.js';

const MAX_UNFINISHED_SYNC_RESPONDER_SESSIONS = 4096;
type UnfinishedSyncResponderSession = {
  syncSessionId: string;
  expiresAt: number;
  manifestDigest?: DurableManifestDigest;
  responderSessionOffset?: number;
};

const unfinishedSyncResponderSessions = new Map<string, UnfinishedSyncResponderSession>();

function getUnfinishedSyncResponderSession(
  checkpointKey: string,
  manifestDigest: DurableManifestDigest | undefined,
  now = Date.now(),
): UnfinishedSyncResponderSession | undefined {
  const session = unfinishedSyncResponderSessions.get(checkpointKey);
  if (!session) return undefined;
  if (session.expiresAt > now && session.manifestDigest === manifestDigest) return session;
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
  manifestDigest: DurableManifestDigest | undefined,
  now = Date.now(),
): UnfinishedSyncResponderSession | undefined {
  if (
    !checkpoint?.responderSessionId
    || checkpoint.manifestDigest !== manifestDigest
    || !Number.isSafeInteger(checkpoint.responderSessionExpiresAtMs)
    || (checkpoint.responderSessionExpiresAtMs ?? 0) <= now
  ) return undefined;
  return {
    syncSessionId: checkpoint.responderSessionId,
    expiresAt: checkpoint.responderSessionExpiresAtMs!,
    ...(checkpoint.responderSessionOffset !== undefined
      ? { responderSessionOffset: checkpoint.responderSessionOffset }
      : {}),
    ...(checkpoint.manifestDigest ? { manifestDigest: checkpoint.manifestDigest } : {}),
  };
}

function persistUnfinishedSyncResponderSession(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
  session: UnfinishedSyncResponderSession,
  manifestDigest: DurableManifestDigest | undefined,
  manifestPrefixDigest: DurableManifestPrefixDigest | undefined,
  responderSessionOffset: number,
  now = Date.now(),
): void {
  rememberUnfinishedSyncResponderSession(checkpointKey, {
    ...session,
    responderSessionOffset,
    ...(manifestDigest ? { manifestDigest } : {}),
  }, now);
  checkpointStore.setResponderSession?.(
    checkpointKey,
    session.syncSessionId,
    session.expiresAt,
    now,
    manifestDigest,
    manifestPrefixDigest,
    responderSessionOffset,
  );
}

function forgetUnfinishedSyncResponderSession(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
): void {
  unfinishedSyncResponderSessions.delete(checkpointKey);
  checkpointStore.clearResponderSession?.(checkpointKey);
}

/**
 * Delete both halves of a requester checkpoint.
 *
 * The responder token has a process-local compatibility cache in addition to
 * the injected store. Callers that own final verification/storage therefore
 * use this helper when the paired offset is no longer resumable; deleting only
 * the store entry would strand a never-reused scoped token in that cache.
 */
export function deleteSyncPageCheckpoint(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
): void {
  unfinishedSyncResponderSessions.delete(checkpointKey);
  checkpointStore.delete(checkpointKey);
}

/**
 * Re-align the process-local responder-session cache after an owner rewrites a
 * durable checkpoint coordinate (notably rollback after a failed atomic
 * materialization). The opaque responder session remains unchanged; only its
 * verified/raw requester coordinate is restored.
 */
export function alignSyncPageResponderSessionWithCheckpoint(
  checkpointStore: SyncCheckpointStore,
  checkpointKey: string,
  now = Date.now(),
): void {
  const checkpoint = checkpointStore.get(checkpointKey, now);
  if (
    !checkpoint?.responderSessionId
    || checkpoint.responderSessionExpiresAtMs === undefined
    || checkpoint.responderSessionExpiresAtMs <= now
  ) {
    unfinishedSyncResponderSessions.delete(checkpointKey);
    return;
  }
  rememberUnfinishedSyncResponderSession(checkpointKey, {
    syncSessionId: checkpoint.responderSessionId,
    expiresAt: checkpoint.responderSessionExpiresAtMs,
    responderSessionOffset: checkpoint.responderSessionOffset ?? checkpoint.offset,
    ...(checkpoint.manifestDigest ? { manifestDigest: checkpoint.manifestDigest } : {}),
  }, now);
}

function isSyncResponderSessionInvalidError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('sync session') && (
    message.includes('superseded')
    || message.includes('expired')
  );
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
  /** Absolute raw responder row coordinate for every retained quad. */
  quadRawOffsets?: number[];
  bytesReceived: number;
  /** Verified manifest coordinate used by checkpoint/materialization logic. */
  resumedFromOffset: number;
  /** Raw responder-session coordinate used on the wire for this invocation. */
  rawResumedFromOffset?: number;
  /**
   * True only when this phase started without reusing a requester-side
   * responder snapshot token. Optional for rolling deep-import compatibility;
   * proof-sensitive callers must treat an omitted value as unknown.
   */
  responderSessionStartedFresh?: boolean;
  /** META generation actually used to authorize this DATA continuation. */
  manifestDigest?: DurableManifestDigest;
  nextOffset: number;
  /** Raw responder-session coordinate after the last accepted page. */
  rawNextOffset?: number;
  checkpointKey: string;
  completed: boolean;
  timedOut: boolean;
}

export interface SyncPageProgress {
  readonly resumedFromOffset: number;
  readonly nextOffset: number;
}

function acceptedIncompletePrefixResult(
  result: Omit<SyncPageResult, 'completed' | 'timedOut'>,
): SyncPageResult {
  return {
    ...result,
    completed: false,
    timedOut: true,
  };
}

/** Canonical transport path identity for learned requester page sizing. */
export interface SyncPageSizeProfileScope {
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
}

const DEFAULT_SYNC_PAGE_SIZE_PROFILE_TTL_MS = 10 * 60_000;
const DEFAULT_SYNC_PAGE_SIZE_PROFILE_MAX_ENTRIES = 4_096;

/** Bounded agent-local memory for path/CG/phase page-size learning. */
export class SyncPageSizeProfileCache {
  private readonly entries = new Map<
    string,
    { preferredPageSize: number; touchedAt: number }
  >();

  constructor(
    private readonly maxEntries = DEFAULT_SYNC_PAGE_SIZE_PROFILE_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_SYNC_PAGE_SIZE_PROFILE_TTL_MS,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Sync page-size profile maxEntries must be a positive integer');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError('Sync page-size profile ttlMs must be a positive integer');
    }
  }

  preferred(scope: SyncPageSizeProfileScope, now = Date.now()): number | undefined {
    const key = this.key(scope);
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    if (now - existing.touchedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order as a small LRU; this also avoids scanning the
    // whole map on each access.
    this.entries.delete(key);
    existing.touchedAt = now;
    this.entries.set(key, existing);
    return existing.preferredPageSize;
  }

  remember(
    scope: SyncPageSizeProfileScope,
    preferredPageSize: number,
    now = Date.now(),
  ): void {
    if (!Number.isSafeInteger(preferredPageSize) || preferredPageSize < 1) {
      throw new RangeError('Sync page-size preference must be a positive integer');
    }
    const key = this.key(scope);
    // Writes are touches too: refresh TTL/LRU metadata at the same boundary
    // that validates and stores the learned preference.
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { preferredPageSize, touchedAt: now });
  }

  private key(scope: SyncPageSizeProfileScope): string {
    // Keep this identity beside the requester policy it controls. This is
    // transport-capacity memory, so transfer identity (graph URI, snapshot,
    // delta watermark, recovery, exact assets, scope, and limits) is
    // intentionally excluded. The lifecycle wrapper owns only the bounded
    // agent-local cache, not these grouping rules.
    return JSON.stringify([
      scope.remotePeerId,
      scope.contextGraphId,
      scope.includeSharedMemory ? 'swm' : 'vm',
      scope.phase,
    ]);
  }
}

type PageSizeAdjustment = {
  previousPageSize: number;
  currentPageSize: number;
};

/** Owns the adaptive requester page-size state machine for one fetch. */
class AdaptiveSyncPageSizer {
  private readonly safePageSize: number;

  private activePageSize: number;

  private consecutiveSuccessfulPages = 0;

  constructor(
    private readonly syncPageSize: number,
    private readonly usesByteBudgetPagination: boolean,
    preferredPageSize?: number,
    private readonly rememberPreferredPageSize?: (pageSize: number) => void,
  ) {
    this.safePageSize = Math.min(syncPageSize, SYNC_REQUEST_SAFE_PAGE_SIZE);
    const initialPageSize = Math.min(syncPageSize, SYNC_REQUEST_INITIAL_PAGE_SIZE);
    this.activePageSize = Number.isSafeInteger(preferredPageSize)
      ? Math.max(this.safePageSize, Math.min(syncPageSize, preferredPageSize!))
      : Math.max(this.safePageSize, initialPageSize);
  }

  current(): number {
    return this.activePageSize;
  }

  onRetryFailure(error: unknown, signal?: AbortSignal): PageSizeAdjustment {
    const previousPageSize = this.activePageSize;
    if (this.canLearnFromFailure(error, signal)) {
      if (this.activePageSize > this.safePageSize) {
        // The transport has only three total attempts. Jump to the proven
        // frame-safe floor immediately; sustained success probes upward again.
        this.activePageSize = this.safePageSize;
      }
      this.rememberCurrentPageSize();
    }
    // Every failed retry breaks a success streak, even when it originated
    // locally and therefore cannot teach us anything about path capacity.
    this.consecutiveSuccessfulPages = 0;
    return { previousPageSize, currentPageSize: this.activePageSize };
  }

  onTerminalFailure(error: unknown, signal?: AbortSignal): PageSizeAdjustment {
    const previousPageSize = this.activePageSize;
    if (
      this.canLearnFromFailure(error, signal)
      && this.activePageSize > this.safePageSize
    ) {
      this.activePageSize = this.safePageSize;
      this.rememberCurrentPageSize();
    }
    return { previousPageSize, currentPageSize: this.activePageSize };
  }

  onPageSuccess(): void {
    this.rememberCurrentPageSize();
    if (this.usesByteBudgetPagination && this.activePageSize < this.syncPageSize) {
      this.consecutiveSuccessfulPages += 1;
      if (this.consecutiveSuccessfulPages >= SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD) {
        this.activePageSize = Math.min(
          this.syncPageSize,
          this.activePageSize * 2,
        );
        this.rememberCurrentPageSize();
        this.consecutiveSuccessfulPages = 0;
      }
    } else {
      this.consecutiveSuccessfulPages = 0;
    }
  }

  private canLearnFromFailure(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted !== true && shouldReducePageSize(error);
  }

  private rememberCurrentPageSize(): void {
    this.rememberPreferredPageSize?.(this.activePageSize);
  }
}

/**
 * Optional modifiers for one Agent-owned page fetch.
 *
 * Keep these named: checkpoint identity, cancellation, recovery semantics and
 * accumulation ceilings are independent concerns. A positional tail made it
 * too easy for a new modifier to occupy an older modifier's slot.
 */
export interface SyncPageFetchOptions {
  readonly snapshotRef?: string;
  readonly sinceBatchId?: string;
  readonly signal?: AbortSignal;
  readonly recovery?: boolean;
  readonly forceFreshSession?: boolean;
  /** Completed canonical META generation that defines a durable DATA plan. */
  readonly manifestDigest?: DurableManifestDigest;
  /** Canonical prefix proof for any candidate checkpoint offset. */
  readonly manifestPrefixDigestAtOffset?: (
    offset: number,
  ) => DurableManifestPrefixDigest | undefined;
  readonly assetUals?: string[];
  /**
   * Permit the selected-SWM transfer owner to retain a validated metadata
   * prefix after a retryable transport interruption. Checkpoint identity is
   * intentionally independent of this transfer policy.
   */
  readonly returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  readonly requesterScope?: SyncCheckpointScope;
  /** Override used by proof-only callers that own a private in-memory store. */
  readonly checkpointStore?: SyncCheckpointStore;
  /** Proof-only requester state is invocation-local and must not survive this call. */
  readonly ephemeralRequesterState?: boolean;
  readonly maxAcceptedQuads?: number;
  readonly maxAcceptedHeapBytesEstimate?: number;
  /**
   * Soft owner boundary evaluated only after a page made forward progress.
   * Returning true yields an incomplete prefix without classifying the peer as
   * timed out; callers must still verify and checkpoint a safe graph boundary.
   */
  readonly shouldStopAfterPage?: (progress: SyncPageProgress) => boolean;
}

export class SyncPageAccumulationLimitError extends Error {
  readonly code = 'SYNC_PAGE_ACCUMULATION_LIMIT' as const;

  responderSessionStartedFresh?: boolean;

  constructor(
    readonly dimension: 'bytes' | 'quads' | 'heap-bytes',
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`Sync phase ${dimension} accumulation ${actual} exceeds limit ${limit}`);
    this.name = 'SyncPageAccumulationLimitError';
  }
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
  /** Enforces generation identity for durable DATA continuation state. */
  manifestDigest?: DurableManifestDigest;
  /** Allows a changed generation to retain a cryptographically identical prefix. */
  manifestPrefixDigestAtOffset?: (
    offset: number,
  ) => DurableManifestPrefixDigest | undefined;
  /**
   * R9/R10 — member SWM recovery marker. Forks BOTH the checkpoint namespace
   * (R10: distinct `|recovery` cursor + responder-session scope so it never
   * mutates the shared incremental-sync cursor) AND the request envelope (R9:
   * forwarded to `buildSyncRequest` so the responder gates it via the strict
   * members-only `isMemberRecoveryAuthorized`). Default false ⇒ normal sync.
   */
  recovery?: boolean;
  buildSyncRequest: (contextGraphId: string, offset: number, limit: number, includeSharedMemory: boolean, remotePeerId: string, phase?: SyncPhase, snapshotRef?: string, sinceBatchId?: string, syncSessionId?: string, recovery?: boolean, assetUals?: string[]) => Promise<Uint8Array>;
  /**
   * Phase C — optional, gap-safe delta-sync high-water mark. Forwarded to the
   * responder for the durable DATA phase so it returns only KAs with
   * `dkg:batchId > sinceBatchId`. MUST originate from a CONTIGUOUS watermark
   * (never local MAX, which would skip gaps). Omitted ⇒ full scan.
   */
  sinceBatchId?: string;
  /** Exact KAs requested by VM recovery. Undefined retains ordinary full sync. */
  assetUals?: string[];
  /** Selected-SWM-only policy for returning a validated incomplete prefix. */
  returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  /** Isolates an internal requester whose retained prefix is not shareable. */
  requesterScope?: SyncCheckpointScope;
  /** Delete both offset and responder-session state on every terminal path. */
  ephemeralRequesterState?: boolean;
  /** Optional cumulative ceilings for proof-sensitive narrow fetches. */
  maxAcceptedBytes?: number;
  maxAcceptedQuads?: number;
  /** Retained V8 heap estimate; checked before each parsed page is appended. */
  maxAcceptedHeapBytesEstimate?: number;
  /** Soft, progress-only page boundary; never interrupts an in-flight request. */
  shouldStopAfterPage?: (progress: SyncPageProgress) => boolean;
  /** Optional bounded agent-local profiles keyed inside the requester. */
  pageSizeProfileCache?: SyncPageSizeProfileCache;
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

function shouldReducePageSize(error: unknown): boolean {
  // Request construction can fail before a byte leaves this node (wallet,
  // chain RPC, signing). Only a send failure or an explicit responder-capacity
  // rejection is evidence that a smaller page could help.
  return isSyncTransportFailure(error) || (
    isSyncValidationRejection(error) && isSyncBackoffWorthyError(error)
  );
}

function checkpointKeyForFetch(params: FetchSyncPagesParams): string {
  return getSyncCheckpointKey(
    params.remotePeerId,
    params.contextGraphId,
    params.includeSharedMemory,
    params.phase,
    params.snapshotRef,
    params.sinceBatchId,
    params.recovery,
    params.assetUals ? exactAssetFilterKey(params.assetUals) : undefined,
    params.requesterScope,
  );
}

export async function fetchSyncPages(params: FetchSyncPagesParams): Promise<SyncPageResult> {
  if (params.ephemeralRequesterState !== true) return fetchSyncPagesWithState(params);
  try {
    return await fetchSyncPagesWithState(params);
  } finally {
    deleteSyncPageCheckpoint(params.checkpointStore, checkpointKeyForFetch(params));
  }
}

async function fetchSyncPagesWithState(params: FetchSyncPagesParams): Promise<SyncPageResult> {
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
    manifestDigest,
    manifestPrefixDigestAtOffset,
    recovery,
    buildSyncRequest,
    sinceBatchId,
    assetUals,
    returnAcceptedPrefixOnRetryableTransportFailure,
    maxAcceptedBytes,
    maxAcceptedQuads,
    maxAcceptedHeapBytesEstimate,
    shouldStopAfterPage,
    pageSizeProfileCache,
    parseAndFilter,
    send,
    logWarn,
    logInfo,
    logDebug,
  } = params;

  const allQuads: Quad[] = [];
  const allQuadRawOffsets: number[] = [];
  let hasCompleteQuadRawOffsetMapping = true;
  // Check for a pre-aborted signal BEFORE starting phase telemetry so a caller
  // that passes an already-aborted signal never records a phase_start without a
  // terminal outcome. Every started phase is guaranteed a finish() below.
  throwIfAborted(signal);
  const phaseTelemetry = createRequesterPhaseTelemetry({ includeSharedMemory, phase });
  const checkpointKey = checkpointKeyForFetch(params);
  if (forceFreshSession) {
    checkpointStore.delete(checkpointKey);
    unfinishedSyncResponderSessions.delete(checkpointKey);
  }
  let checkpoint = checkpointStore.get(checkpointKey);
  const savedPrefixDigest = checkpoint && manifestDigest
    ? manifestPrefixDigestAtOffset?.(checkpoint.offset)
    : undefined;
  const manifestCheckpointDecision = resolveManifestCheckpointDecision({
    checkpoint,
    manifestDigest,
    prefixDigestAtOffset: savedPrefixDigest,
    hasExactAssetFilter: assetUals !== undefined,
  });
  if (manifestCheckpointDecision.kind === 'reset') {
    // OFFSET has meaning only inside the exact META generation that produced
    // it. A missing/changed prefix or a store that cannot persist the binding
    // restarts both the verified and raw responder coordinates.
    deleteSyncPageCheckpoint(checkpointStore, checkpointKey);
    checkpoint = undefined;
  } else if (manifestCheckpointDecision.kind === 'rebind-and-prime') {
    checkpointStore.setManifestBoundOffset(
      checkpointKey,
      checkpoint!.offset,
      manifestDigest!,
      Date.now(),
      manifestCheckpointDecision.prefixDigest,
    );
    unfinishedSyncResponderSessions.delete(checkpointKey);
    checkpoint = checkpointStore.get(checkpointKey);
    logInfo(
      ctx,
      `Reusing verified durable prefix for "${contextGraphId}" through offset ${checkpoint?.offset ?? 0} after META generation change`,
    );
  } else if (manifestCheckpointDecision.prefixUpgrade) {
    // Upgrade an otherwise generation-bound checkpoint so a later suffix
    // change or responder restart can reuse its verified prefix safely.
    checkpointStore.setManifestBoundOffset(
      checkpointKey,
      checkpoint!.offset,
      manifestDigest!,
      Date.now(),
      manifestCheckpointDecision.prefixUpgrade,
    );
    checkpoint = checkpointStore.get(checkpointKey);
  }
  const usesPageSession = usesResponderSession(includeSharedMemory, phase);
  const sessionStartedAt = Date.now();
  // A successful caller deletes the checkpoint after verification/storage.
  // The process-local cache can outlive that synchronous delete, so never let
  // a cache-only token resurrect a completed snapshot at offset zero.
  if (!checkpoint) unfinishedSyncResponderSessions.delete(checkpointKey);
  const savedResponderSession = usesPageSession
    ? (
        getPersistedSyncResponderSession(checkpoint, manifestDigest, sessionStartedAt)
        ?? (checkpoint
          ? getUnfinishedSyncResponderSession(checkpointKey, manifestDigest, sessionStartedAt)
          : undefined)
      )
    : undefined;
  const responderSessionStartedFresh = savedResponderSession === undefined;
  const responderResumeDecision = resolveResponderResumeDecision({
    checkpoint,
    usesPageSession,
    savedResponderSessionOffset: savedResponderSession?.responderSessionOffset,
    manifestRebindNeedsPriming: manifestCheckpointDecision.kind === 'rebind-and-prime',
  });
  if (responderResumeDecision.kind === 'reset-unmappable') {
    // A verified manifest coordinate is not necessarily a raw responder
    // coordinate. Once the immutable token is gone, restart instead of
    // guessing that both coordinate spaces match.
    deleteSyncPageCheckpoint(checkpointStore, checkpointKey);
    checkpoint = undefined;
  }
  const verifiedOffset = responderResumeDecision.verifiedOffset;
  let offset = responderResumeDecision.rawOffset;
  const responderSessionNeedsPriming = responderResumeDecision.kind === 'prime';
  const resumedFromOffset = verifiedOffset;
  const rawResumedFromOffset = offset;
  const verifiedResumePrefixDigest = resumedFromOffset > 0
    ? manifestPrefixDigestAtOffset?.(resumedFromOffset)
    : undefined;
  const responderSessionLossCleanup = resolveResponderSessionLossCleanup({
    usesPageSession,
    hasExactAssetFilter: assetUals !== undefined,
    checkpoint,
    manifestDigest,
    verifiedOffset: resumedFromOffset,
    rawOffset: rawResumedFromOffset,
    prefixDigestAtOffset: verifiedResumePrefixDigest,
    supportsSessionClear: checkpointStore.clearResponderSession !== undefined,
  });
  let bytesReceived = 0;
  let acceptedHeapBytesEstimate = 0;
  let responsePages = 0;
  let timedOut = false;
  let yielded = false;
  // Start an unknown peer/path at the conservative initial page size, then
  // grow toward the throughput ceiling only after sustained success. Reduce
  // within the existing bounded retry budget if a response cannot traverse
  // the wire.
  // ProtocolRouter may surface an oversized response as a generic stream reset,
  // so the reduction intentionally applies to any retryable transport failure.
  // A transient failure merely makes the remainder of this phase conservative;
  // it never changes offsets or responder-session identity.
  // Byte-budget pagination: a SHORT page is NOT EOF — only an empty response is
  // (see the loop's EOF checks). This is a REQUESTER-SIDE default derived from
  // `syncPageSize > SYNC_PAGE_SIZE` (the fetch wrapper passes
  // a ceiling above SYNC_PAGE_SIZE for every phase), NOT a wire-negotiated
  // capability. Durable meta relies on it: since #1916 the responder byte-caps
  // durable-meta pages, so a page can be short for byte reasons; a requester
  // that treated "short = EOF" for meta could end the phase early. Every
  // testnet-canary+ requester uses a byte-budget ceiling here, so short≠EOF holds for meta and
  // data alike; a pre-canary requester using the 500-row cap is the only one
  // that would regress, and only on an oversized (>4 MiB) meta subject.
  const usesByteBudgetPagination = syncPageSize > SYNC_PAGE_SIZE;
  const pageSizeProfileScope = {
    remotePeerId,
    contextGraphId,
    includeSharedMemory,
    phase,
  } satisfies SyncPageSizeProfileScope;
  const adaptivePageSizer = new AdaptiveSyncPageSizer(
    syncPageSize,
    usesByteBudgetPagination,
    pageSizeProfileCache?.preferred(pageSizeProfileScope),
    pageSizeProfileCache
      ? (pageSize) => pageSizeProfileCache.remember(pageSizeProfileScope, pageSize)
      : undefined,
  );
  let successfulPageSize = adaptivePageSizer.current();
  const syncSessionId = usesPageSession
    ? (savedResponderSession?.syncSessionId ?? createResponderSessionId(includeSharedMemory, phase))
    : undefined;
  const responderSession = usesPageSession && syncSessionId
    ? {
      syncSessionId,
      expiresAt: savedResponderSession?.expiresAt ?? sessionStartedAt + DURABLE_DATA_SYNC_SESSION_TTL_MS,
      responderSessionOffset: savedResponderSession?.responderSessionOffset ?? rawResumedFromOffset,
      ...(manifestDigest ? { manifestDigest } : {}),
    }
    : undefined;

  const requestPage = async (
    requestOffset: number,
    selectPageSize: () => number,
    onRetry: (attempt: number, delay: number, error: unknown) => void,
  ): Promise<Uint8Array> => sendSyncRequest({
    remotePeerId,
    timeoutMs: Math.min(
      syncPageTimeoutMs,
      Math.max(2000, Math.floor(Math.max(0, deadline - Date.now()) / syncRouterAttempts)),
    ),
    retryAttempts: syncPageRetryAttempts,
    signal,
    contextGraphId,
    offset: requestOffset,
    protocolId: protocolSync,
    plane: syncPlaneFor(includeSharedMemory),
    phase,
    requestFactory: async () => {
      throwIfAborted(signal);
      successfulPageSize = selectPageSize();
      const request = await buildSyncRequest(
        contextGraphId,
        requestOffset,
        successfulPageSize,
        includeSharedMemory,
        remotePeerId,
        phase,
        snapshotRef,
        sinceBatchId,
        syncSessionId,
        recovery,
        assetUals,
      );
      throwIfAborted(signal);
      return request;
    },
    send,
    validateResponse: (responseBytes) => {
      if (decodeSyncResponse(responseBytes) === LEGACY_SYNC_BUSY_RESPONSE) {
        throw makeLegacySyncBusyError(remotePeerId, contextGraphId, phase);
      }
    },
    onRetry,
  });

  try {
    if (
      responderSessionNeedsPriming
      && responderSession
      && resumedFromOffset > 0
    ) {
      // A responder session owns an immutable raw-row coordinate system and
      // refuses an unseen token at offset>0. Seed the new generation with one
      // ordinary offset-zero page, discard those already-verified rows, then
      // jump to the cryptographically identical manifest boundary. This costs
      // one bounded page instead of replaying the entire verified prefix.
      const primePageSize = Math.min(
        syncPageSize,
        Math.max(adaptivePageSizer.current(), SYNC_PAGE_SIZE + 1),
      );
      const primeBytes = await requestPage(
        0,
        () => primePageSize,
        (attempt, delay, err) => {
          logWarn(
            ctx,
            `Sync generation-prime retry ${attempt}/${syncPageRetryAttempts} for offset 0 `
            + `(delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      throwIfAborted(signal);
      const primeBody = decodeSyncResponse(primeBytes);
      if (
        primeBody === syncDeniedResponse
        || (extraDeniedResponses && extraDeniedResponses.includes(primeBody))
      ) {
        const error = new Error(
          `Sync denied by ${remotePeerId} while priming the new responder generation for "${contextGraphId}" (${phase})`,
        );
        (error as Error & { syncDenied?: boolean }).syncDenied = true;
        throw error;
      }
      if (!primeBody) {
        throw new Error(
          `Durable sync session returned an empty generation-prime page for nonzero offset ${resumedFromOffset}`,
        );
      }
      const nextBytesReceived = bytesReceived + primeBytes.byteLength;
      if (maxAcceptedBytes !== undefined && nextBytesReceived > maxAcceptedBytes) {
        throw toSyncPeerRespondedError(new SyncPageAccumulationLimitError(
          'bytes',
          nextBytesReceived,
          maxAcceptedBytes,
        ));
      }
      bytesReceived = nextBytesReceived;
      responsePages += 1;
      phaseTelemetry.recordPage();
      adaptivePageSizer.onPageSuccess();
      logInfo(
        ctx,
        `Primed fresh durable responder generation for "${contextGraphId}" before reusing verified offset ${resumedFromOffset}`,
      );
    }

    while (true) {
      throwIfAborted(signal);
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      const curOffset = offset;
      const transportStartedAt = Date.now();
      // The shared request helper rebuilds auth material on every attempt and
      // is also used by generation priming, so both modes keep identical
      // transport/replay semantics.
      const responseBytes = await requestPage(
        curOffset,
        () => adaptivePageSizer.current(),
        (attempt, delay, err) => {
          const adjustment = adaptivePageSizer.onRetryFailure(err, signal);
          const pageSizeNote = adjustment.currentPageSize < adjustment.previousPageSize
            ? `; reducing page size ${adjustment.previousPageSize}->${adjustment.currentPageSize}`
            : '';
          logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms${pageSizeNote}): ${err instanceof Error ? err.message : String(err)}`);
        },
      );
      const transportDurationMs = Date.now() - transportStartedAt;
      throwIfAborted(signal);
      responsePages += 1;
      phaseTelemetry.recordPage();

      const nextBytesReceived = bytesReceived + responseBytes.byteLength;
      if (maxAcceptedBytes !== undefined && nextBytesReceived > maxAcceptedBytes) {
        const error = new SyncPageAccumulationLimitError(
          'bytes',
          nextBytesReceived,
          maxAcceptedBytes,
        );
        throw toSyncPeerRespondedError(error);
      }

      let parsed: { quads: Quad[]; totalQuads: number; sourceIndexes?: number[] };
      let decodeDurationMs = 0;
      let parseDurationMs = 0;
      try {
        const decodeStartedAt = Date.now();
        const nquadsText = decodeSyncResponse(responseBytes);
        decodeDurationMs = Date.now() - decodeStartedAt;
        bytesReceived = nextBytesReceived;
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
        const nextAcceptedQuads = allQuads.length + parsed.quads.length;
        if (maxAcceptedQuads !== undefined && nextAcceptedQuads > maxAcceptedQuads) {
          throw new SyncPageAccumulationLimitError(
            'quads',
            nextAcceptedQuads,
            maxAcceptedQuads,
          );
        }
        const parsedHeapBytesEstimate = parsed.quads.reduce(
          (total, quad) => total + estimateQuadHeapBytes(quad),
          0,
        );
        const nextAcceptedHeapBytesEstimate =
          acceptedHeapBytesEstimate + parsedHeapBytesEstimate;
        if (
          maxAcceptedHeapBytesEstimate !== undefined
          && nextAcceptedHeapBytesEstimate > maxAcceptedHeapBytesEstimate
        ) {
          throw new SyncPageAccumulationLimitError(
            'heap-bytes',
            nextAcceptedHeapBytesEstimate,
            maxAcceptedHeapBytesEstimate,
          );
        }
        acceptedHeapBytesEstimate = nextAcceptedHeapBytesEstimate;
        const sourceIndexes = parsed.sourceIndexes;
        if (
          sourceIndexes !== undefined
          && sourceIndexes.length === parsed.quads.length
          && sourceIndexes.every(
            (index, position) => Number.isSafeInteger(index)
              && index >= 0
              && index < parsed.totalQuads
              && (position === 0 || index > sourceIndexes[position - 1]!),
          )
        ) {
          allQuadRawOffsets.push(...sourceIndexes.map((index) => curOffset + index));
        } else if (parsed.totalQuads === parsed.quads.length) {
          allQuadRawOffsets.push(...parsed.quads.map((_, index) => curOffset + index));
        } else if (parsed.quads.length > 0) {
          hasCompleteQuadRawOffsetMapping = false;
        }
      } catch (error) {
        throw toSyncPeerRespondedError(error);
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
      // Keep the size that actually crossed the path. The requester policy
      // probes upward only after sustained success, at most doubling each time.
      adaptivePageSizer.onPageSuccess();

      if (shouldStopAfterPage?.({ resumedFromOffset, nextOffset: offset })) {
        yielded = true;
        break;
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
    // The transport retry helper has no onRetry callback after its terminal
    // attempt. Persist one final backoff step so the next bounded continuation
    // does not repeat the same known-failing page size from scratch.
    adaptivePageSizer.onTerminalFailure(err, signal);
    if (err instanceof SyncPageAccumulationLimitError) {
      err.responderSessionStartedFresh = responderSessionStartedFresh;
    }
    const denied = (err as Error & { syncDenied?: boolean }).syncDenied === true;
    if (usesPageSession && err instanceof SyncPageAccumulationLimitError) {
      // The exact response proved that this responder ignored (or violated)
      // the requested narrow scope. Never resume that incompatible row list:
      // a later retry must mint a fresh session and start from offset zero.
      unfinishedSyncResponderSessions.delete(checkpointKey);
      checkpointStore.delete(checkpointKey);
    } else if (usesPageSession && isSyncResponderSessionInvalidError(err)) {
      // A responder-declared superseded/expired token can never make progress.
      // Rotate it immediately even at offset zero instead of re-saving the
      // terminal token until its requester-side TTL elapses. Some transports
      // still destroy a responder's text and expose a generic reset, which is
      // why the zero-accepted-page fallback below remains necessary.
      if (responderSessionLossCleanup === 'clear-session') {
        // The token is invalid, not the already verified local graph prefix.
        // Keep its generation-bound boundary, forget only the token, and let
        // the next bounded round prime a fresh responder generation at zero
        // before jumping back to this cryptographically proven offset.
        forgetUnfinishedSyncResponderSession(checkpointStore, checkpointKey);
      } else {
        unfinishedSyncResponderSessions.delete(checkpointKey);
        checkpointStore.delete(checkpointKey);
      }
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
        // session TTL (~10 min) while peer backoff compounds. When the offset
        // is bound to a canonical verified-prefix digest, drop only the token:
        // the next retry mints a fresh id, primes it at offset zero, then jumps
        // back to the proven boundary. Legacy/custom stores without that proof
        // still drop both halves and restart at zero. A FRESH round
        // (resumedFromOffset === 0)
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
        if (responderSessionLossCleanup === 'clear-session') {
          forgetUnfinishedSyncResponderSession(checkpointStore, checkpointKey);
        } else {
          unfinishedSyncResponderSessions.delete(checkpointKey);
          checkpointStore.delete(checkpointKey);
        }
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
          manifestDigest,
          manifestPrefixDigestAtOffset?.(resumedFromOffset),
          offset,
        );
      }
    }
    if (
      returnAcceptedPrefixOnRetryableTransportFailure === true
      && signal?.aborted === true
    ) {
      // Cancellation is authoritative even when the transport reports a
      // separately retryable failure while unwinding. The selected owner must
      // receive an AbortError and discard both halves of its private prefix,
      // never mistake the accepted rows for a successful partial transfer.
      deleteSyncPageCheckpoint(checkpointStore, checkpointKey);
      phaseTelemetry.finish('error', allQuads.length);
      throw asAbortError(signal.reason);
    }

    // A durable data prefix that already crossed the wire is still useful when
    // a later page loses its stream. Return it through the same bounded,
    // incomplete-result contract as a deadline so the caller can verify whole
    // graph boundaries, materialize only exact KAs, and advance to the last
    // certified offset. Throwing here discarded every accepted page and made
    // an unstable relay replay the entire round forever. Keep this narrowly on
    // durable DATA transport failures: denials, parse/integrity failures,
    // responder-session invalidation, metadata, and recovery retain their
    // existing fail-closed error semantics.
    if (
      !includeSharedMemory
      && phase === 'data'
      && !recovery
      && responsePages > 0
      && allQuads.length > 0
      && signal?.aborted !== true
      && isSyncBackoffWorthyError(err)
    ) {
      logWarn(
        ctx,
        `Durable data transport interrupted after ${allQuads.length} accepted triples for "${contextGraphId}"; returning a verifiable prefix at raw offset ${offset}`,
      );
      phaseTelemetry.finish('timed_out', allQuads.length);
      return acceptedIncompletePrefixResult({
        quads: allQuads,
        ...(hasCompleteQuadRawOffsetMapping
          ? { quadRawOffsets: allQuadRawOffsets }
          : {}),
        bytesReceived,
        resumedFromOffset,
        rawResumedFromOffset,
        responderSessionStartedFresh,
        ...(manifestDigest ? { manifestDigest } : {}),
        nextOffset: offset,
        rawNextOffset: offset,
        checkpointKey,
      });
    }

    // Selected RFC-64 SWM metadata has a stricter all-or-nothing activation
    // boundary than its transfer boundary. Once at least one page from this
    // exact scoped responder session has passed decode/parse/accumulation
    // checks, a later retryable TRANSPORT exhaustion may return that validated
    // prefix to its single in-memory owner. The owner retains it with this
    // checkpoint/session and never exposes it to Blazegraph until the metadata
    // response completes and the ordinary SWM verification path runs.
    //
    // Keep this narrower than `isSyncBackoffWorthyError`: responder denials,
    // validation/integrity rejection, local request construction/signing, and
    // caller/node aborts all throw and force the owner to discard its prefix.
    if (
      phase === 'meta'
      && returnAcceptedPrefixOnRetryableTransportFailure === true
      && responsePages > 0
      && allQuads.length > 0
      && signal?.aborted !== true
      && isKnownRetryableSyncTransportInterruption(err)
    ) {
      logWarn(
        ctx,
        `Metadata transport interrupted after ${allQuads.length} accepted triples for "${contextGraphId}"; retaining an owner-private prefix at raw offset ${offset}`,
      );
      phaseTelemetry.finish('timed_out', allQuads.length);
      return acceptedIncompletePrefixResult({
        quads: allQuads,
        ...(hasCompleteQuadRawOffsetMapping
          ? { quadRawOffsets: allQuadRawOffsets }
          : {}),
        bytesReceived,
        resumedFromOffset,
        rawResumedFromOffset,
        responderSessionStartedFresh,
        ...(manifestDigest ? { manifestDigest } : {}),
        nextOffset: offset,
        rawNextOffset: offset,
        checkpointKey,
      });
    }

    if (returnAcceptedPrefixOnRetryableTransportFailure === true) {
      // The selected transfer owner can retain only an explicitly returned
      // validated prefix. Every thrown boundary invalidates both pieces of its
      // resume tuple so aborts, denials and local/validation/integrity failures
      // cannot strand a session without its byte-identical in-memory prefix.
      deleteSyncPageCheckpoint(checkpointStore, checkpointKey);
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
        manifestDigest,
        manifestPrefixDigestAtOffset?.(resumedFromOffset),
        offset,
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
    ...(hasCompleteQuadRawOffsetMapping
      ? { quadRawOffsets: allQuadRawOffsets }
      : {}),
    bytesReceived,
    resumedFromOffset,
    rawResumedFromOffset,
    responderSessionStartedFresh,
    ...(manifestDigest ? { manifestDigest } : {}),
    nextOffset: offset,
    rawNextOffset: offset,
    checkpointKey,
    completed: !timedOut && !yielded,
    timedOut,
  };
}
