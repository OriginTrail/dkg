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

const MAX_CONCURRENT_DEFERRED_AUTHORITY_DISCOVERIES = 4;

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
    contextGraphId: string,
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
  const candidates = [...ports.dormancyById]
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

  // Remote authority reads are independent. Discover them with a finite pool,
  // then serialize activation so cap accounting and durable commits remain
  // deterministic. A loadAll-only compatibility store is scanned once here,
  // rather than once per candidate.
  const discoveries = await mapWithConcurrency(
    candidates,
    MAX_CONCURRENT_DEFERRED_AUTHORITY_DISCOVERIES,
    async (contextGraphId) => {
      if (
        !ports.isCurrent()
        || ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      ) return null;
      const revision = ports.persistRevisions.get(contextGraphId) ?? 0;
      const candidate = ports.store.load === undefined
        ? discoverySnapshot!.get(contextGraphId) ?? null
        : await ports.store.load(contextGraphId);
      if (!ports.isCurrent()) return null;
      if (candidate === null) {
        return Object.freeze({ contextGraphId, revision, candidate, authority: null });
      }
      const authority = await ports.resolveAuthority(contextGraphId, signal);
      return Object.freeze({ contextGraphId, revision, candidate, authority });
    },
  );
  if (!ports.isCurrent()) return;

  const needsCommitSnapshot = ports.store.load === undefined
    && discoveries.some((discovery) => discovery?.authority?.outcome === 'allowed');
  const commitSnapshot = needsCommitSnapshot ? await snapshotRows() : null;
  if (!ports.isCurrent()) return;

  for (const discovery of discoveries) {
    if (discovery === null) continue;
    const { contextGraphId, revision, candidate, authority } = discovery;
    if (candidate === null) {
      ports.clearStatus(contextGraphId);
      continue;
    }
    if (
      ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
    ) continue;
    if (authority === null) continue;
    if (authority.outcome !== 'allowed') {
      if (authority.outcome === 'denied') {
        ports.dormancyById.set(contextGraphId, 'authorityDenied');
        ports.touchStatus();
      }
      continue;
    }

    const currentRow = ports.store.load === undefined
      ? commitSnapshot!.get(contextGraphId) ?? null
      : await ports.store.load(contextGraphId);
    if (!ports.isCurrent()) return;
    if (
      currentRow === null
      || ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable'
      || (ports.persistRevisions.get(contextGraphId) ?? 0) !== revision
      || ports.subscriptions.has(contextGraphId)
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
