import {
  createOperationContext,
  DEFAULT_MAX_READ_BYTES,
  QuietRetryableHandlerError,
  withSpan,
  getMetrics,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
} from '../../dkg-agent-constants.js';
import {
  serializeWorkspacePublicSnapshotQuads,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../durable-session.js';
import {
  createResponderGraphListMemo,
  createResponderExactGraphPagePlanMemo,
  createResponderFreshSwmDataGraphPlanMemo,
  createResponderFreshSwmMetaPlanMemo,
  createResponderSyncRowListMemo,
  createResponderSubGraphRegistrationMemo,
  createResponderSwmAdmissionMemo,
  DurableMetaPageFrameError,
  readCatalogPage,
  readDurableDataPage,
  readDurableMetaPage,
  readSwmDataPage,
  readSwmMetaPage,
  serializeResponderRows,
  serializeResponderRowsWithinByteBudget,
  SyncRowSnapshotLimitError,
} from './graph-plan.js';
import { exactAssetFilterKey } from '../exact-assets.js';
import {
  createSyncResponderSnapshotBudget,
  SyncRowSnapshotBudgetError,
  type SyncResponderSnapshotBudgetOptions,
} from './snapshot-budget.js';
import {
  contextGraphPriority,
  syncPriorityClass,
  validateSyncResponderSnapshotLimitsConfig,
  type SyncContextGraphPriorityConfig,
  type SyncPriorityClass,
  type SyncSchedulerLane,
  type SyncResponderSnapshotLimitsConfig,
} from '../policy.js';
import {
  PriorityAdmissionQueue,
  type PriorityAdmission,
} from '../priority-admission-queue.js';
import { resolveDurableDataRequestPolicy } from './durable-data-request-policy.js';

const MAX_SYNC_SESSION_TOKENS = 256;

type SyncSessionTokenEntry = {
  token: string;
  expiresAt: number;
};

type PreparedResponderSession = {
  rowListCacheKey: string;
  refreshRowList: boolean;
  refreshGeneration: string;
};

type PreparedResponderStage =
  | { kind: 'respond'; bytes: Uint8Array }
  | { kind: 'authorized'; authDurationMs: number };

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
  /**
   * Injected policy predicate (#1233): return `true` to WITHHOLD the durable
   * `_meta` snapshot for `contextGraphId` — the responder then replies with an
   * empty (completed) meta page instead of materializing/serving it. Kept as an
   * injected dependency so daemon config policy (the `DKG_SERVE_AGENTS_META`
   * kill-switch + the agents-registry-CG check) lives at the wiring site, NOT in
   * the sync responder. Omitted / returns falsy ⇒ serve normally (the pre-#1233
   * behaviour), so callers that don't wire it are unaffected. The production
   * caller reads `process.env` fresh per call, keeping the switch runtime-hot.
   */
  shouldWithholdDurableMeta?: (contextGraphId: string) => boolean;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
  /** Primarily injectable for deterministic tests; production uses the bounded defaults below. */
  snapshotBudget?: SyncResponderSnapshotBudgetOptions;
  /** Local-only policy; consulted only after authorizeSyncRequest accepts the CG. */
  contextGraphPriorities?: Readonly<SyncContextGraphPriorityConfig>;
}

const SYNC_RESPONDER_GLOBAL_CONCURRENCY = 3;
const SYNC_RESPONDER_PER_PEER_CONCURRENCY = 1;
const SYNC_RESPONDER_QUEUE_LIMIT = 64;
export const SYNC_RESPONDER_PER_PEER_QUEUE_LIMIT = 4;
const SYNC_RESPONDER_MAX_QUEUE_WAIT_MS = 10_000;
export const SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT = 128;
export const SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT = 64;
export const SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT = 64;
export const SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT = 250_000;
export const SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT = 128 * 1024 * 1024;
// Keep enough retained capacity for every admitted responder computation. The
// budget pins active page sessions, so this avoids cross-peer eviction/thrash
// while preserving a finite process-wide ceiling.
export const SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT =
  SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT * SYNC_RESPONDER_GLOBAL_CONCURRENCY;
export const SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT =
  SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT * SYNC_RESPONDER_GLOBAL_CONCURRENCY;

const SNAPSHOT_BUDGET_ENV = {
  maxRows: 'DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT',
  maxBytesEstimate: 'DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT',
  maxSnapshotRows: 'DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT',
  maxSnapshotBytesEstimate: 'DKG_SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT',
} as const;

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  warn: (message: string) => void,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  warn(`Ignoring invalid ${name}="${raw}"; expected a positive safe integer`);
  return fallback;
}

export interface ResolvedSyncResponderSnapshotPolicy {
  budget: SyncResponderSnapshotBudgetOptions;
  localRowsClamped: boolean;
  localBytesEstimateClamped: boolean;
}

/** Resolve each leaf independently: environment, then config, then the compatibility default. */
export function resolveSyncResponderSnapshotPolicy(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onWarning: (message: string) => void = () => {},
): ResolvedSyncResponderSnapshotPolicy {
  validateSyncResponderSnapshotLimitsConfig(config);
  const warnings = new Set<string>();
  const warnOnce = (message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    onWarning(message);
  };
  const maxRows = positiveIntegerEnv(
    env,
    SNAPSHOT_BUDGET_ENV.maxRows,
    config?.global?.rows ?? SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
    warnOnce,
  );
  const maxBytesEstimate = positiveIntegerEnv(
    env,
    SNAPSHOT_BUDGET_ENV.maxBytesEstimate,
    config?.global?.bytesEstimate ?? SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    warnOnce,
  );
  const configuredMaxSnapshotRows = positiveIntegerEnv(
    env,
    SNAPSHOT_BUDGET_ENV.maxSnapshotRows,
    config?.local?.rows ?? SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT,
    warnOnce,
  );
  const configuredMaxSnapshotBytesEstimate = positiveIntegerEnv(
    env,
    SNAPSHOT_BUDGET_ENV.maxSnapshotBytesEstimate,
    config?.local?.bytesEstimate ?? SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    warnOnce,
  );
  const maxSnapshotRows = Math.min(configuredMaxSnapshotRows, maxRows);
  const maxSnapshotBytesEstimate = Math.min(configuredMaxSnapshotBytesEstimate, maxBytesEstimate);
  const localRowsClamped = maxSnapshotRows !== configuredMaxSnapshotRows;
  const localBytesEstimateClamped = maxSnapshotBytesEstimate !== configuredMaxSnapshotBytesEstimate;
  if (localRowsClamped) {
    warnOnce(
      `Clamped syncResponderSnapshotLimits.local.rows from ${configuredMaxSnapshotRows} to global.rows ${maxRows}`,
    );
  }
  if (localBytesEstimateClamped) {
    warnOnce(
      `Clamped syncResponderSnapshotLimits.local.bytesEstimate from ${configuredMaxSnapshotBytesEstimate} to global.bytesEstimate ${maxBytesEstimate}`,
    );
  }
  return {
    budget: {
      maxRows,
      maxBytesEstimate,
      maxSnapshotRows,
      maxSnapshotBytesEstimate,
    },
    localRowsClamped,
    localBytesEstimateClamped,
  };
}

/** Production snapshot limits, with explicit config and environment overrides in rows/bytes. */
export function resolveSyncResponderSnapshotBudgetOptions(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onWarning?: (message: string) => void,
): SyncResponderSnapshotBudgetOptions {
  return resolveSyncResponderSnapshotPolicy(config, env, onWarning).budget;
}

class SyncResponderBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncResponderBusyError';
  }
}

interface SyncResponderQueuePayload {
  peerId: string;
  contextGraphId?: string;
}

type SyncResponderScheduling = {
  contextGraphId?: string;
  lane: Extract<SyncSchedulerLane, 'pre_authorization' | 'responder'>;
  priority: number;
  priorityClass: SyncPriorityClass;
};

function createSyncResponderLimiter() {
  let running = 0;
  const runningByPeer = new Map<string, number>();
  const queue = new PriorityAdmissionQueue<SyncResponderQueuePayload>({
    canRun: (entry) => (
      running < SYNC_RESPONDER_GLOBAL_CONCURRENCY
      && (runningByPeer.get(entry.payload.peerId) ?? 0) < SYNC_RESPONDER_PER_PEER_CONCURRENCY
    ),
    onStart: (entry) => {
      const { peerId } = entry.payload;
      running += 1;
      runningByPeer.set(peerId, (runningByPeer.get(peerId) ?? 0) + 1);
      return () => {
        running = Math.max(0, running - 1);
        const peerRunning = (runningByPeer.get(peerId) ?? 1) - 1;
        if (peerRunning <= 0) runningByPeer.delete(peerId);
        else runningByPeer.set(peerId, peerRunning);
      };
    },
  });

  const schedulingOptions = (
    peerId: string,
    scheduling: SyncResponderScheduling,
    signal?: AbortSignal,
  ) => ({
    payload: { peerId, contextGraphId: scheduling.contextGraphId },
    lane: scheduling.lane,
    priority: scheduling.priority,
    priorityClass: scheduling.priorityClass,
    signal,
    timeoutMs: SYNC_RESPONDER_MAX_QUEUE_WAIT_MS,
    agingThresholdMs: SYNC_RESPONDER_MAX_QUEUE_WAIT_MS / 2,
    createBusyError: (reason: 'global_queue_full' | 'owner_queue_full') => new SyncResponderBusyError(
      reason === 'global_queue_full'
        ? 'sync responder queue full'
        : 'sync responder peer queue full',
    ),
    createDisplacedError: () => new SyncResponderBusyError(
      'sync responder queued request displaced',
    ),
    createTimeoutError: () => new SyncResponderBusyError(
      'sync responder queue wait exceeded',
    ),
  });

  const acquire = (
    peerId: string,
    scheduling: SyncResponderScheduling,
    signal?: AbortSignal,
    reserveForHandoff = false,
  ): PriorityAdmission<SyncResponderQueuePayload> => queue.acquire({
    ...schedulingOptions(peerId, scheduling, signal),
    ownerKey: peerId,
    queueLimit: SYNC_RESPONDER_QUEUE_LIMIT,
    ownerQueueLimit: SYNC_RESPONDER_PER_PEER_QUEUE_LIMIT,
    reserveForHandoff,
  });

  return {
    async run<T>(
      peerId: string,
      signal: AbortSignal | undefined,
      scheduling: SyncResponderScheduling,
      fn: () => Promise<T>,
    ): Promise<T> {
      const admission = acquire(peerId, scheduling, signal);
      const release = await admission.release;
      try {
        throwIfAborted(signal);
        return await fn();
      } finally {
        release();
      }
    },

    async runTwoStage<T, U>(
      peerId: string,
      signal: AbortSignal | undefined,
      firstScheduling: SyncResponderScheduling,
      first: () => Promise<T>,
      transition: (value: T) => {
        scheduling: SyncResponderScheduling;
        work: () => Promise<U>;
      } | undefined,
    ): Promise<T | U> {
      const firstAdmission = acquire(peerId, firstScheduling, signal, true);
      const releaseFirst = await firstAdmission.release;
      let value: T;
      try {
        throwIfAborted(signal);
        value = await first();
      } catch (error) {
        releaseFirst();
        throw error;
      }

      const next = transition(value);
      if (!next) {
        releaseFirst();
        return value;
      }

      let secondAdmission: PriorityAdmission<SyncResponderQueuePayload>;
      try {
        // The first stage reserved one bounded global + per-peer queue slot.
        // Consuming it here preserves the original arrival sequence without
        // temporarily or persistently exceeding either queue cap.
        if (!firstAdmission.handoff) {
          throw new Error('sync responder handoff reservation missing');
        }
        secondAdmission = firstAdmission.handoff(
          schedulingOptions(peerId, next.scheduling, signal),
        );
      } catch (error) {
        releaseFirst();
        throw error;
      }
      releaseFirst();

      const releaseSecond = await secondAdmission.release;
      try {
        throwIfAborted(signal);
        return await next.work();
      } finally {
        releaseSecond();
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
    shouldWithholdDurableMeta,
    logWarn,
    logDebug,
    snapshotBudget,
    contextGraphPriorities,
  } = params;
  const graphListMemo = createResponderGraphListMemo(store);
  const responderSnapshotBudget = createSyncResponderSnapshotBudget(snapshotBudget ?? {
    maxRows: SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
    maxBytesEstimate: SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    maxSnapshotRows: SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT,
    maxSnapshotBytesEstimate: SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
  });
  const durableDataRowsMemo = createResponderSyncRowListMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT,
    { phase: 'durable_data', budget: responderSnapshotBudget },
  );
  const durableMetaRowsMemo = createResponderSyncRowListMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT,
    { phase: 'durable_meta', budget: responderSnapshotBudget },
  );
  const swmRowsMemo = createResponderSyncRowListMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
    { phase: 'shared_memory', budget: responderSnapshotBudget },
  );
  const freshSwmDataGraphPlanMemo = createResponderFreshSwmDataGraphPlanMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
  );
  const freshSwmMetaPlanMemo = createResponderFreshSwmMetaPlanMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
    // #1847 review: retained TTL meta session plans are control-plane state and
    // must be charged to the same process-wide budget as retained snapshots —
    // peers cannot stack uncharged plans, and global pressure evicts idle ones.
    responderSnapshotBudget,
  );
  const durableDataExactGraphPlanMemo = createResponderExactGraphPagePlanMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT,
  );
  const swmDataExactGraphPlanMemo = createResponderExactGraphPagePlanMemo(
    DURABLE_DATA_SYNC_SESSION_TTL_MS,
    SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
  );
  const syncSessionTokens = new Map<string, SyncSessionTokenEntry>();
  const subGraphRegistrationMemo = createResponderSubGraphRegistrationMemo(store);
  const swmAdmissionMemo = createResponderSwmAdmissionMemo(store);
  const limiter = createSyncResponderLimiter();
  // Preserve the original one-admission auth+serve path unless an operator
  // actually configures a non-zero priority. An empty/all-zero map is a true
  // compatibility no-op for responder scheduling.
  const prioritySchedulingEnabled = Object.values(contextGraphPriorities ?? {})
    .some((priority) => priority !== 0);
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
      // Include the server-derived row-list scope so two remote peers choosing
      // the same opaque token cannot make global prerequisite memos treat their
      // otherwise-independent sessions as one generation.
      refreshGeneration: `${key}\u0000${token}`,
    };
  };

  register(protocolSync, async (data, peerId, options) => withSpan('sync.response', async (span) => {
    span.setAttribute('dkg.protocol_id', protocolSync);
    const signal = options?.signal;
    const handlerStartedAt = Date.now();
    // Outer guard over ALL pre-limiter work (parse + validation + abort). A
    // synchronous throw here — e.g. parseSyncRequest on malformed peer bytes —
    // escapes BEFORE the limiter promise's ok/error recording, so without this
    // it would be invisible in dkg.sync.response.total. The returned limiter
    // promise is NOT awaited inside this try, so its async outcomes are still
    // recorded by its own .then/.catch (no double counting).
    try {
    const request = parseSyncRequest(data);
    // A durable rootless snapshot can legitimately contain millions of rows.
    // Never clamp a valid cursor: doing so silently replays the row slice at
    // the clamp boundary forever while the requester keeps advancing its local
    // offset. That produces duplicates and makes an otherwise valid manifest
    // fail integrity verification once the snapshot crosses the old 1M cap.
    // Exact-graph paging already rejects offsets beyond the plan with an empty
    // page, so accepting every non-negative safe integer remains bounded.
    const requestedOffset = Number(request.offset);
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
      ? requestedOffset
      : 0;
    const limit = Math.max(1, Math.min(Number.isSafeInteger(Number(request.limit)) ? Number(request.limit) : syncPageSize, syncPageSize));
    const phase = request.phase ?? 'data';
    const isWorkspace = request.includeSharedMemory;
    const contextGraphId = request.contextGraphId;
    const assetUals = request.assetUals;
    const assetSelectionKey = assetUals === undefined
      ? 'full'
      : exactAssetFilterKey(assetUals);
    const durableDataPolicy = resolveDurableDataRequestPolicy({
      legacyLimit: limit,
      includeSharedMemory: isWorkspace,
      phase,
      pageMode: request.pageMode,
      pageRowsHint: request.pageRowsHint,
      hasExactAssetFilter: assetUals !== undefined,
    });
    const usesByteBudgetPage = durableDataPolicy.usesByteBudgetPage;
    // Durable meta negotiated its byte-budget page mode on the wire (#1916 /
    // #1923). The subject-atomic byte-fit in readDurableMetaPage already bounds
    // the page ≤ budget for BOTH modes, so this only selects the belt-and-
    // suspenders response serializer and records the explicit contract.
    const usesMetaByteBudget = !isWorkspace &&
      phase === 'meta' &&
      request.pageMode === SYNC_BYTE_BUDGET_PAGE_MODE;
    // The authenticated `limit` deliberately remains capped at the legacy
    // responder size for rolling-upgrade signature compatibility. Upgraded
    // META requesters carry the larger row target in the additive hint, just
    // like DATA. Honour it here: readDurableMetaPage and the serializer below
    // still enforce the response byte budget and whole-subject boundaries.
    const durableMetaLimit = usesMetaByteBudget &&
      typeof request.pageRowsHint === 'number' &&
      Number.isSafeInteger(request.pageRowsHint)
      ? Math.max(1, Math.min(request.pageRowsHint, SYNC_BYTE_BUDGET_MAX_ROWS))
      : limit;
    if (!contextGraphId || typeof contextGraphId !== 'string') {
      // Count this early return too — it short-circuits before limiter.run, so
      // without this it would never reach the syncResponseTotal{ok}/{error}
      // recording on the limiter promise below.
      getMetrics().syncResponseTotal.add(1, { outcome: 'invalid' });
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
    // A durable/SWM snapshot can span thousands of page requests. Emitting the
    // same successful timing record for every page turned routine catch-up into
    // millions of SQLite dashboard rows on mainnet. Keep the policy at one lazy
    // logging boundary so every phase gets one representative diagnostic per
    // session without constructing strings for skipped pages. Slow total
    // responses are still logged below regardless of offset.
    const logFirstPageDetail = (message: () => string): void => {
      if (offset !== 0) return;
      logDebug(createOperationContext('sync'), message());
    };

    const prepareResponderStage = async (): Promise<PreparedResponderStage> => {
      throwIfAborted(signal);

      // facet open-serve. The public `_catalog` subgraph (a DCAT
      // dataset record) is served to ANYONE, with NO allowlist auth, BEFORE the
      // gate below. Bounded to exactly that one named graph (readCatalogPage), so
      // no gated quad can leak. This is how outsiders discover a private CG.
      if (phase === 'catalog') {
        const rows = await raceAgainstAbort(readCatalogPage({ store, contextGraphId, offset, limit }), signal);
        const serialized = serializeResponderRows(rows);
        logFirstPageDetail(() => `Sync responder catalog facet for "${contextGraphId}": rows=${rows.length}`);
        return { kind: 'respond', bytes: new TextEncoder().encode(serialized ?? '') };
      }

      const authStartedAt = Date.now();
      const authorized = await authorizeSyncRequest(request, peerId, { signal });
      const authDurationMs = Date.now() - authStartedAt;
      throwIfAborted(signal);
      if (!authorized) {
        logWarn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
        return { kind: 'respond', bytes: new TextEncoder().encode(syncDeniedResponse) };
      }
      return { kind: 'authorized', authDurationMs };
    };

    const serveAuthorizedStage = async (authDurationMs: number): Promise<Uint8Array> => {
      throwIfAborted(signal);

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
          const page = publicSnapshotStore.getSnapshotPage
            ? await raceAgainstAbort(
              publicSnapshotStore.getSnapshotPage(snapshotRef, offset, limit, { signal }),
              signal,
            )
            : (await raceAgainstAbort(publicSnapshotStore.getSnapshot(snapshotRef), signal))
              ?.slice(offset, offset + limit);
          if (!page) return new TextEncoder().encode('');
          if (page.length === 0) {
            return new TextEncoder().encode('');
          }
          nquads.push(serializeWorkspacePublicSnapshotQuads(page).trimEnd());
          logFirstPageDetail(() => `Sync responder SWM snapshot for "${contextGraphId}" ref=${snapshotRef}: auth=${authDurationMs}ms quads=${page.length}`);
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
            graphMembership: await graphListMemo.get({
              refresh: session?.refreshRowList ?? offset === 0,
              refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
              signal,
            }),
            registeredSubGraphNames: await swmAdmissionMemo.get(
              contextGraphId,
              {
                refresh: session?.refreshRowList ?? offset === 0,
                refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
                signal,
              },
            ),
            contextGraphId,
            cutoffIso: cutoff,
            offset,
            limit,
            signal,
            rowListMemo: session ? swmRowsMemo : undefined,
            rowListCacheKey: session?.rowListCacheKey,
            refreshRowList: session?.refreshRowList,
            refreshGeneration: session?.refreshGeneration,
            freshMetaPlanMemo: freshSwmMetaPlanMemo,
          });
          const queryDurationMs = Date.now() - queryStartedAt;
          const serializeStartedAt = Date.now();
          const serialized = serializeResponderRows(rows);
          if (serialized) nquads.push(serialized);
          const serializeDurationMs = Date.now() - serializeStartedAt;
          logFirstPageDetail(() => `Sync responder SWM meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
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
            graphMembership: await graphListMemo.get({
              refresh: session?.refreshRowList ?? offset === 0,
              refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
              signal,
            }),
            registeredSubGraphNames: await swmAdmissionMemo.get(
              contextGraphId,
              {
                refresh: session?.refreshRowList ?? offset === 0,
                refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
                signal,
              },
            ),
            contextGraphId,
            cutoffIso: cutoff,
            offset,
            limit,
            signal,
            rowListMemo: session ? swmRowsMemo : undefined,
            rowListCacheKey: session?.rowListCacheKey,
            refreshRowList: session?.refreshRowList,
            refreshGeneration: session?.refreshGeneration,
            freshGraphPlanMemo: freshSwmDataGraphPlanMemo,
            exactGraphPlanMemo: swmDataExactGraphPlanMemo,
          });
          const queryDurationMs = Date.now() - queryStartedAt;
          const serializeStartedAt = Date.now();
          const serialized = serializeResponderRows(rows);
          if (serialized) nquads.push(serialized);
          const serializeDurationMs = Date.now() - serializeStartedAt;
          logFirstPageDetail(() => `Sync responder SWM data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
        }

        if (nquads.length === 0) return new TextEncoder().encode('');
      } else if (phase === 'meta') {
        // Durable-meta serve-skip (#1233). When the injected policy predicate
        // says to withhold this CG's `_meta` (production: the agents registry
        // system CG, whose `_meta` is bloated per-heartbeat KA/KC records with NO
        // cross-node consumer — agent facts are served from the DATA phase — and
        // serving it just re-propagates the bloat across the mesh), skip
        // materializing/serializing it and leave `nquads` empty, which returns an
        // empty (completed) meta page. The requester tolerates this exactly like
        // a legitimately-empty meta graph — it treats an empty body as clean EOF
        // (page-fetch.ts: `if (!nquadsText) break`). Only THIS durable-meta
        // snapshot is withheld: the DATA phase, and any CG the predicate does not
        // flag, are untouched. The predicate reads the `DKG_SERVE_AGENTS_META`
        // kill-switch per call at the wiring site, so it is reversible at runtime.
        if (shouldWithholdDurableMeta?.(contextGraphId)) {
          logDebug(
            createOperationContext('sync'),
            `Sync responder withholding durable meta for "${contextGraphId}" (serve-skip policy)`,
          );
        } else {
          const queryStartedAt = Date.now();
          const session = prepareResponderSession(
            'Durable meta',
            `${peerId}:durable-meta:${contextGraphId}:${assetSelectionKey}`,
            request.syncSessionId,
            offset,
          );
          const rows = await readDurableMetaPage({
            store,
            contextGraphId,
            registeredSubGraphNames: await subGraphRegistrationMemo.get(
              contextGraphId,
              {
                refresh: session?.refreshRowList ?? offset === 0,
                refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
                signal,
              },
            ),
            offset,
            limit: durableMetaLimit,
            signal,
            rowListMemo: session ? durableMetaRowsMemo : undefined,
            rowListCacheKey: session?.rowListCacheKey,
            refreshRowList: session?.refreshRowList,
            refreshGeneration: session?.refreshGeneration,
            assetUals,
            maxResponseBytes: SYNC_BYTE_BUDGET_RESPONSE_BYTES,
            // NON-NEGOTIATED legacy requesters (no wire `pageMode`) must fail
            // loud on an oversized `_meta` subject rather than receive a byte-fit
            // SHORT page they would read as EOF — silent metadata loss + a #1788
            // seal split. Negotiated (testnet-canary+) requesters keep the
            // verified byte-fit behavior (empty=EOF pagination, so short≠EOF).
            oversizedSubjectPolicy: usesMetaByteBudget ? 'byte-fit' : 'fail-loud',
          });
          const queryDurationMs = Date.now() - queryStartedAt;
          const serializeStartedAt = Date.now();
          // Byte-cap the durable-meta response (#1916) exactly like durable data:
          // the subject-atomic extend can return a whole (or oversized) subject,
          // so serialize within the frame budget rather than emitting unbounded
          // N-Quads. The extend keeps every valid seal well under the budget, so
          // this only ever truncates a pathological oversized subject.
          //
          // Pagination contract: durable meta uses byte-budget pagination where a
          // SHORT page is NOT EOF — only an empty page is. The requester's
          // short≠EOF handling is a requester-side default (page-fetch:
          // syncPageSize=8192 > SYNC_PAGE_SIZE), and since #1923 it is ALSO
          // negotiated on the wire via `pageMode` (usesMetaByteBudget). The
          // subject-atomic byte-fit in readDurableMetaPage already bounds every
          // page ≤ budget AND to whole subjects, so both the negotiated
          // (byte-budget serializer) and the non-negotiated (plain serializer)
          // branches are frame-safe and never split a subject; the gate here just
          // honours the explicit contract.
          const serialized = usesMetaByteBudget
            ? serializeResponderRowsWithinByteBudget(rows, SYNC_BYTE_BUDGET_RESPONSE_BYTES)
            : serializeResponderRows(rows);
          if (serialized) nquads.push(serialized);
          const serializeDurationMs = Date.now() - serializeStartedAt;
          logFirstPageDetail(() => `Sync responder durable meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
        }
      } else {
        const queryStartedAt = Date.now();
        const session = prepareResponderSession(
          'Durable data',
          `${peerId}:durable-data:${contextGraphId}:${assetUals === undefined
            ? (sinceBatchId == null ? 'full' : sinceBatchId.toString())
            : assetSelectionKey}`,
          request.syncSessionId,
          offset,
        );
        const rows = await readDurableDataPage({
          store,
          graphMembership: await graphListMemo.get({
            refresh: session?.refreshRowList ?? offset === 0,
            refreshGeneration: offset === 0 ? session?.refreshGeneration : undefined,
            signal,
          }),
          contextGraphId,
          sinceBatchId,
          offset,
          limit: durableDataPolicy.limit,
          signal,
          rowListMemo: session && durableDataPolicy.cacheMode === 'session-snapshot'
            ? durableDataRowsMemo
            : undefined,
          rowListCacheScope: session && durableDataPolicy.cacheMode === 'session-snapshot'
            ? peerId
            : undefined,
          refreshRowList: session?.refreshRowList,
          refreshGeneration: session?.refreshGeneration,
          exactGraphPlanMemo: durableDataExactGraphPlanMemo,
          // A byte-bounded response may contain only a prefix of the row slice
          // loaded above. Do not release the immutable session snapshot merely
          // because that slice was short; the explicit empty request is EOF.
          releaseCacheOnShortPage: !usesByteBudgetPage,
          assetUals,
          exactGraphReadMode: durableDataPolicy.exactGraphReadMode,
        });
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        const serialized = usesByteBudgetPage
          ? serializeResponderRowsWithinByteBudget(rows, SYNC_BYTE_BUDGET_RESPONSE_BYTES)
          : serializeResponderRows(rows);
        if (serialized) nquads.push(serialized);
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logFirstPageDetail(() => `Sync responder durable data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }

      const totalDurationMs = Date.now() - handlerStartedAt;
      if (totalDurationMs > 100) {
        logDebug(createOperationContext('sync'), `Sync responder total for "${contextGraphId}" (phase=${phase}, workspace=${isWorkspace}): ${totalDurationMs}ms`);
      }
      return new TextEncoder().encode(nquads.join('\n'));
    };

    const preAuthorizationScheduling: SyncResponderScheduling = {
      lane: 'pre_authorization',
      priority: 0,
      priorityClass: 'default',
    };
    const response: Promise<Uint8Array> = prioritySchedulingEnabled
      ? limiter.runTwoStage(
          peerId,
          signal,
          preAuthorizationScheduling,
          prepareResponderStage,
          (prepared) => {
            if (prepared.kind === 'respond') return undefined;
            const priority = contextGraphPriority(contextGraphPriorities, contextGraphId);
            return {
              scheduling: {
                contextGraphId,
                lane: 'responder' as const,
                priority,
                priorityClass: syncPriorityClass(priority),
              },
              work: () => serveAuthorizedStage(prepared.authDurationMs),
            };
          },
        ).then((result) => {
          if (result instanceof Uint8Array) return result;
          if (result.kind === 'respond') return result.bytes;
          throw new Error('sync responder authorized stage did not produce response bytes');
        })
      : limiter.run(
          peerId,
          signal,
          { contextGraphId, lane: 'responder', priority: 0, priorityClass: 'default' },
          async () => {
            const prepared = await prepareResponderStage();
            return prepared.kind === 'respond'
              ? prepared.bytes
              : serveAuthorizedStage(prepared.authDurationMs);
          },
        );

    const guardSyncResponseBytes = (bytes: Uint8Array): Uint8Array => {
      if (bytes.byteLength <= DEFAULT_MAX_READ_BYTES) return bytes;
      const message = `Sync responder refused ${bytes.byteLength}-byte response for `
        + `"${contextGraphId}" (phase=${phase}, workspace=${isWorkspace}): exceeds `
        + `${DEFAULT_MAX_READ_BYTES}-byte transport frame cap; response must be paginated below the transport ceiling`;
      logWarn(createOperationContext('sync'), message);
      throw new Error(message);
    };

    return response.then((res) => {
      const guarded = guardSyncResponseBytes(res);
      getMetrics().syncResponseTotal.add(1, { outcome: 'ok' });
      return guarded;
    }).catch((err) => {
      if (err instanceof SyncResponderBusyError) {
        getMetrics().syncResponseTotal.add(1, { outcome: 'busy' });
        span.setAttribute('dkg.sync_response_outcome', 'busy');
        logDebug(createOperationContext('sync'), `Sync responder busy for "${contextGraphId}" from peer ${peerId} (phase=${phase}): ${err.message}`);
        throw new QuietRetryableHandlerError(err.message);
      }
      if (err instanceof SyncRowSnapshotLimitError) {
        getMetrics().syncResponseTotal.add(1, { outcome: 'limit' });
        span.setAttribute('dkg.sync_response_outcome', 'limit');
        logWarn(
          createOperationContext('sync'),
          `Sync responder snapshot limit for "${contextGraphId}" from peer ${peerId} (phase=${phase}, workspace=${isWorkspace}): active=${err.activeEntries}/${err.maxEntries} cached=${err.cachedEntries} inflight=${err.inflightEntries} key=${err.key}`,
        );
        throw new QuietRetryableHandlerError(
          `sync responder snapshot limit exceeded (active=${err.activeEntries}/${err.maxEntries})`,
        );
      }
      if (err instanceof SyncRowSnapshotBudgetError) {
        getMetrics().syncResponseTotal.add(1, { outcome: 'limit' });
        span.setAttribute('dkg.sync_response_outcome', 'limit');
        logWarn(
          createOperationContext('sync'),
          `Sync responder snapshot memory budget for "${contextGraphId}" from peer ${peerId} ` +
          `(phase=${phase}, workspace=${isWorkspace}, reason=${err.reason}, rows=${err.rows}, ` +
          `bytesEstimate=${err.bytesEstimate}, key=${err.key})`,
        );
        throw new QuietRetryableHandlerError(err.message);
      }
      if (err instanceof DurableMetaPageFrameError) {
        // Loud, non-retryable failure (#1788/#1916): an oversized `_meta` subject
        // cannot be served frame-safe to a non-negotiated legacy requester, and
        // byte-fitting it would be a silent short=EOF metadata loss. Retrying
        // cannot help — surface it as a hard error so the round fails visibly
        // rather than completing with partial metadata. Root fix: #1921.
        getMetrics().syncResponseTotal.add(1, { outcome: 'error' });
        span.setAttribute('dkg.sync_response_outcome', 'error');
        logWarn(
          createOperationContext('sync'),
          `Sync responder cannot serve durable meta frame-safe to a non-negotiated (legacy) `
          + `requester for "${contextGraphId}" from peer ${peerId}: ${err.message}`,
        );
        throw err;
      }
      getMetrics().syncResponseTotal.add(1, { outcome: 'error' });
      throw err;
    });
    } catch (preLimiterErr) {
      // Malformed/unparseable request or a pre-limiter validation/abort throw —
      // count it as an invalid outcome before preserving the throw (withSpan
      // still records the span ERROR + the stream reset behaviour is unchanged).
      getMetrics().syncResponseTotal.add(1, { outcome: 'invalid' });
      throw preLimiterErr;
    }
  }));
}
