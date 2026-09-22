// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionRehydrationInternalStatus,
  ContextGraphSubscriptionStore,
} from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { isCanonicalPositiveContextGraphId } from './context-graph-binding-state.js';

const MAX_CONCURRENT_DEFERRED_ROW_LOADS = 4;
const MAX_UINT256 = (1n << 256n) - 1n;

function hasCanonicalDurableBinding(
  row: ContextGraphSubscriptionRecord | null,
): boolean {
  return isCanonicalPositiveContextGraphId(row?.onChainId)
    && BigInt(row.onChainId) <= MAX_UINT256;
}

export interface PersistedContextGraphSubscriptionActivationPorts {
  install(
    row: ContextGraphSubscriptionRecord,
    input: Readonly<{
      onChainId?: string;
      restorePendingMeta: boolean;
      updateRehydrationStatus: boolean;
    }>,
  ): ContextGraphSub;
  current(contextGraphId: string): ContextGraphSub | undefined;
  remove(contextGraphId: string): void;
  /** Compensate sync scope and every partially installed network handler. */
  rollbackNetworkEffects(contextGraphId: string): void;
  trackSync(contextGraphId: string): void;
  subscribe(contextGraphId: string): void;
  persistMembership(contextGraphId: string): void;
}

export interface PersistedContextGraphSubscriptionActivationOptions {
  readonly onChainId?: string;
  readonly restorePendingMeta?: boolean;
  readonly updateRehydrationStatus?: boolean;
  readonly prepare?: (subscription: ContextGraphSub) => Promise<void>;
  readonly isCurrent?: (subscription: ContextGraphSub) => boolean;
}

/** Canonical install/prepare/network-side-effect transaction for durable rows. */
export async function activatePersistedContextGraphSubscription(
  row: ContextGraphSubscriptionRecord,
  ports: PersistedContextGraphSubscriptionActivationPorts,
  options: PersistedContextGraphSubscriptionActivationOptions = {},
): Promise<ContextGraphSub> {
  const restorePendingMeta = options.restorePendingMeta === true;
  const subscription = ports.install(row, {
    onChainId: options.onChainId,
    restorePendingMeta,
    updateRehydrationStatus: options.updateRehydrationStatus !== false,
  });
  let networkEffectsStarted = false;
  const rollback = (): void => {
    // Before network activation, preserve a concurrently replaced generation.
    // After it begins, every port is synchronous: any changed object is the
    // activation's own transition and must be compensated as part of this call.
    if (!networkEffectsStarted && ports.current(row.id) !== subscription) return;
    try {
      ports.rollbackNetworkEffects(row.id);
    } finally {
      ports.remove(row.id);
    }
  };

  try {
    await options.prepare?.(subscription);
    if (options.isCurrent && !options.isCurrent(subscription)) {
      throw new Error(`Persisted subscription activation for "${row.id}" became stale`);
    }
    if (!restorePendingMeta) {
      networkEffectsStarted = true;
      if (row.syncScoped) ports.trackSync(row.id);
      if (row.subscribed) {
        ports.subscribe(row.id);
        ports.persistMembership(row.id);
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return subscription;
}

export interface DeferredContextGraphSubscriptionAuthorityRecoveryPorts {
  readonly store: ContextGraphSubscriptionStore;
  readonly dormancyById: Map<string, ContextGraphDormancyReason>;
  readonly persistRevisions: ReadonlyMap<string, number>;
  readonly subscriptions: ReadonlyMap<string, ContextGraphSub>;
  getStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  isCurrent(): boolean;
  touchStatus(): void;
  clearStatus(contextGraphId: string): void;
  resolveAuthority(
    row: ContextGraphSubscriptionRecord,
    signal: AbortSignal,
  ): Promise<ContextGraphReadAuthorityDecision>;
  activate(
    row: ContextGraphSubscriptionRecord,
    onChainId: string | undefined,
    revision: number,
  ): Promise<void>;
  warn(contextGraphId: string, error: unknown): void;
  activated(contextGraphId: string): void;
}

/** Executes one fenced pass over only the authority-unavailable durable rows. */
export async function recoverDeferredContextGraphSubscriptionAuthorities(
  signal: AbortSignal,
  ports: DeferredContextGraphSubscriptionAuthorityRecoveryPorts,
): Promise<void> {
  const status = ports.getStatus();
  if (!status?.rehydrationEnabled || !ports.isCurrent()) return;
  const candidateIds = [...ports.dormancyById]
    .filter(([, reason]) => reason === 'authorityUnavailable')
    .map(([id]) => id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const snapshotRows = async (): Promise<ReadonlyMap<string, ContextGraphSubscriptionRecord>> => (
    new Map((await ports.store.loadAll()).map((row) => [row.id, row]))
  );
  const discoverySnapshot = ports.store.load === undefined
    ? await snapshotRows()
    : null;
  if (!ports.isCurrent()) return;

  // Snapshot every durable row before issuing authority reads. A persisted
  // canonical on-chain id owns the same authoritative zero-RPC binding that it
  // will own after activation, so resolve those rows first. Cold/unbound rows
  // may need the 120s finalized-name discovery budget; allowing them to sort
  // ahead of an already-bound row would turn safe serialization into
  // head-of-line blocking. Revision/current-row fences below still decide
  // whether a snapshot may commit.
  const candidates = (await mapWithConcurrency(
    candidateIds,
    MAX_CONCURRENT_DEFERRED_ROW_LOADS,
    async (contextGraphId) => ({
      contextGraphId,
      revision: ports.persistRevisions.get(contextGraphId) ?? 0,
      candidate: ports.store.load === undefined
        ? discoverySnapshot!.get(contextGraphId) ?? null
        : await ports.store.load(contextGraphId),
    }),
  )).sort((left, right) => {
    const leftBound = hasCanonicalDurableBinding(left.candidate);
    const rightBound = hasCanonicalDurableBinding(right.candidate);
    if (leftBound !== rightBound) return leftBound ? -1 : 1;
    return left.contextGraphId < right.contextGraphId
      ? -1
      : left.contextGraphId > right.contextGraphId ? 1 : 0;
  });
  if (!ports.isCurrent()) return;

  // Every discovery performs a fail-closed live-authority read whose 1s
  // per-endpoint budget includes process-wide RPC governor admission. Resolve
  // and commit one candidate at a time: distinct graphs cannot share a flight,
  // and collecting every result before activation would make a ready bound row
  // wait behind later cold rows for up to 120s each.
  for (const { contextGraphId, revision, candidate } of candidates) {
    if (
      !ports.isCurrent()
      || ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
    ) continue;
    if (candidate === null) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    if (!candidate.subscribed && candidate.coreHosted !== true) continue;

    const authority = await ports.resolveAuthority(candidate, signal);
    if (!ports.isCurrent()) return;
    if (
      ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
    ) continue;
    if (authority.outcome !== 'allowed') {
      if (authority.outcome === 'denied') {
        ports.dormancyById.set(contextGraphId, 'authorityDenied');
        ports.touchStatus();
      }
      continue;
    }

    const currentRow = ports.store.load === undefined
      ? (await snapshotRows()).get(contextGraphId) ?? null
      : await ports.store.load(contextGraphId);
    if (!ports.isCurrent()) return;
    if (
      currentRow === null
      || ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
      || ports.subscriptions.has(contextGraphId)
      || currentRow.id !== candidate.id
      || currentRow.onChainId !== candidate.onChainId
      || currentRow.onChainHash !== candidate.onChainHash
      || (!currentRow.subscribed && currentRow.coreHosted !== true)
    ) {
      if (currentRow === null) ports.clearStatus(contextGraphId);
      continue;
    }

    const currentStatus = ports.getStatus();
    const activatedUserRows = currentStatus === null
      ? 0
      : Math.max(0, currentStatus.activated - currentStatus.hostedActivated);
    if (
      currentRow.coreHosted !== true
      && currentStatus !== null
      && currentStatus.activationCap > 0
      && activatedUserRows >= currentStatus.activationCap
    ) {
      ports.dormancyById.set(contextGraphId, 'activationCap');
      ports.touchStatus();
      continue;
    }

    try {
      await ports.activate(
        currentRow,
        authority.onChainId?.toString() ?? currentRow.onChainId,
        revision,
      );
    } catch (error) {
      if (ports.isCurrent()) ports.warn(contextGraphId, error);
      continue;
    }
    if (!ports.isCurrent()) return;
    ports.activated(contextGraphId);
  }
}
