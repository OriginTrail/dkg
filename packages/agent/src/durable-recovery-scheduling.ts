// SPDX-License-Identifier: Apache-2.0
import { createAbortError as asSyncFetchAbortError } from './bounded-operation.js';
import type { ExactRecoveryTransportMode } from './sync/requester/exact-recovery-transport.js';
import { DURABLE_SYNC_SETTLEMENT_HEADROOM_MS, EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { SYNC_MIN_GRAPH_BUDGET_MS } from './dkg-agent-constants.js';
import { syncSingleFlightKey } from './sync-single-flight.js';
const durableContextGraphSyncChains = new WeakMap<object, Map<string, Promise<void>>>();

export async function runSerializedDurableContextGraphSync<T>(
  agent: object,
  remotePeerId: string,
  contextGraphId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let chains = durableContextGraphSyncChains.get(agent);
  if (!chains) {
    chains = new Map<string, Promise<void>>();
    durableContextGraphSyncChains.set(agent, chains);
  }
  const key = JSON.stringify([remotePeerId, contextGraphId]);
  const previous = chains.get(key) ?? Promise.resolve();
  let started = false;
  const run = previous.catch(() => undefined).then(() => {
    if (signal?.aborted) throw asSyncFetchAbortError(signal.reason);
    started = true;
    return operation();
  });
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });
  if (!signal) return run;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // Once the operation owns the serialization turn, its admission and
      // durable phase boundaries own cancellation and atomic settlement.
      if (!started) reject(asSyncFetchAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
    void run.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

const DURABLE_SYNC_SETTLEMENT_HEADROOM_FRACTION = 0.2;

const DURABLE_SYNC_SETTLEMENT_HEADROOM_MAX_MS = 60_000;

function durableSyncFetchDeadline(startedAt: number, timeoutMs: number): number {
  const settlementHeadroomMs = Math.min(
    DURABLE_SYNC_SETTLEMENT_HEADROOM_MAX_MS,
    Math.floor(timeoutMs * DURABLE_SYNC_SETTLEMENT_HEADROOM_FRACTION),
    Math.max(0, timeoutMs - SYNC_MIN_GRAPH_BUDGET_MS),
  );
  return startedAt + timeoutMs - settlementHeadroomMs;
}

export function createDurableSyncOperationBoundary(options: {
  totalTimeoutMs?: number;
  maximumTimeoutMs?: number;
  signal?: AbortSignal;
}): {
  deadline?: number;
  fetchDeadline?: number;
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (options.totalTimeoutMs === undefined) {
    return {
      signal: options.signal,
      dispose: () => {},
    };
  }

  const timeoutMs = normalizeDurableSyncTimeoutMs(
    options.totalTimeoutMs,
    options.maximumTimeoutMs,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const fetchDeadline = durableSyncFetchDeadline(startedAt, timeoutMs);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    asSyncFetchAbortError(options.signal?.reason),
  );
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(
      asSyncFetchAbortError(new Error(
        `Durable sync exceeded totalTimeoutMs=${timeoutMs}`,
      )),
    ),
    timeoutMs,
  );
  timeout.unref?.();

  return {
    deadline,
    fetchDeadline,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export function durableSyncSingleFlightKey(params: {
  remotePeerId: string;
  contextGraphIds: readonly string[];
  stopOnBackoffWorthyFailure?: boolean;
  fetchTimeoutMs: number;
  authenticationTimeoutMs: number;
  syncAgentsMeta: boolean;
  hasPhaseCallback: boolean;
  hasAtomicCommitCallback: boolean;
  hasWorkStartedCallback: boolean;
  hasAccessDeniedCallback: boolean;
  hasSinceBatchIdResolver: boolean;
  hasSignal: boolean;
  hasCurrentFence: boolean;
  hasChallengePinnedSelection: boolean;
  hasForcedFreshExactSession: boolean;
  hasRecoveryAuthorityOwner: boolean;
  exactAssetUals?: readonly string[];
  settlementSliceTimeoutMs?: number;
  priority?: number;
  exactRecoveryTransportMode?: ExactRecoveryTransportMode;
}): string | null {
  if (
    params.hasPhaseCallback
    || params.hasAtomicCommitCallback
    || params.hasWorkStartedCallback
    || params.hasAccessDeniedCallback
    || params.hasSinceBatchIdResolver
    || params.hasSignal
    || params.hasCurrentFence
    || params.hasChallengePinnedSelection
    || params.hasForcedFreshExactSession
    || params.hasRecoveryAuthorityOwner
  ) {
    return null;
  }
  return syncSingleFlightKey('durable-sync', {
    remotePeerId: params.remotePeerId,
    contextGraphIds: params.contextGraphIds,
    stopOnBackoffWorthyFailure: params.stopOnBackoffWorthyFailure === true,
    fetchTimeoutMs: params.fetchTimeoutMs,
    authenticationTimeoutMs: params.authenticationTimeoutMs,
    syncAgentsMeta: params.syncAgentsMeta,
    exactAssetUals: params.exactAssetUals ?? null,
    settlementSliceTimeoutMs: params.settlementSliceTimeoutMs ?? null,
    exactRecoveryTransportMode: params.exactRecoveryTransportMode ?? 'stream-preferred',
    priority: params.priority ?? null,
  });
}

export const DURABLE_RECOVERY_HARD_TIMEOUT_MS =
  EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS + DURABLE_SYNC_SETTLEMENT_HEADROOM_MS;
