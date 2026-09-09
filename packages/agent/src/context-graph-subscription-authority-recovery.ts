// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionRehydrationInternalStatus,
  ContextGraphSubscriptionStore,
} from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';

const AUTHORITY_RETRY_INTERVAL_MS = 30_000;

export interface ContextGraphSubscriptionAuthorityRecoveryRuntimePorts {
  shouldRun(): boolean;
  run(signal: AbortSignal): Promise<void>;
  onFailure(error: unknown): void;
}

/** Owns the timer, cancellation, recurring run, and physical drain boundary. */
export class ContextGraphSubscriptionAuthorityRecoveryRuntime {
  readonly #ports: ContextGraphSubscriptionAuthorityRecoveryRuntimePorts;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #completion: Promise<void> | null = null;

  constructor(ports: ContextGraphSubscriptionAuthorityRecoveryRuntimePorts) {
    this.#ports = ports;
  }

  start(): void {
    if (this.#controller !== null) return;
    this.#controller = new AbortController();
    this.#schedule(0);
  }

  owns(signal: AbortSignal): boolean {
    return this.#controller?.signal === signal && !signal.aborted;
  }

  closeAndDrain(): Promise<void> | null {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#controller?.abort();
    this.#controller = null;
    return this.#completion;
  }

  #schedule(delayMs: number): void {
    const controller = this.#controller;
    if (
      controller === null
      || controller.signal.aborted
      || this.#timer !== null
      || this.#completion !== null
      || !this.#ports.shouldRun()
    ) return;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#controller !== controller || controller.signal.aborted) return;
      const completion = this.#ports.run(controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.#ports.onFailure(error);
        })
        .finally(() => {
          if (this.#completion === completion) this.#completion = null;
          if (this.#controller !== controller || controller.signal.aborted) return;
          this.#schedule(AUTHORITY_RETRY_INTERVAL_MS);
        });
      this.#completion = completion;
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
  }
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
  const rollback = (): void => {
    if (ports.current(row.id) === subscription) ports.remove(row.id);
  };

  try {
    await options.prepare?.(subscription);
    if (options.isCurrent && !options.isCurrent(subscription)) {
      throw new Error(`Persisted subscription activation for "${row.id}" became stale`);
    }
  } catch (error) {
    rollback();
    throw error;
  }

  if (!restorePendingMeta) {
    if (row.syncScoped) ports.trackSync(row.id);
    if (row.subscribed) {
      ports.subscribe(row.id);
      ports.persistMembership(row.id);
    }
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
  const loadRow = async (contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null> => (
    ports.store.load
      ? ports.store.load(contextGraphId)
      : ports.store.loadAll().then((rows) => rows.find((row) => row.id === contextGraphId) ?? null)
  );

  for (const contextGraphId of candidates) {
    if (!ports.isCurrent()) return;
    if (ports.dormancyById.get(contextGraphId) !== 'authorityUnavailable') continue;
    const revision = ports.persistRevisions.get(contextGraphId) ?? 0;
    const candidate = await loadRow(contextGraphId);
    if (!ports.isCurrent()) return;
    if (candidate === null) {
      ports.clearStatus(contextGraphId);
      continue;
    }

    const authority = await ports.resolveAuthority(contextGraphId, signal);
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

    const currentRow = await loadRow(contextGraphId);
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
