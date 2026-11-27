import { subscriptionRecoveryCoordinatorOf } from './subscription-recovery-owner.js';
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { PersistedSubscriptionNameBindingRetry, persistedSubscriptionNameBindingRetryOf } from './context-graph-subscription-name-binding-retry.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import { unavailableContextGraphReadAuthorityDecision, contextGraphReadAuthorityDependencyOf } from './context-graph-read-authority.js';
import type { SubscriptionRecoverySchedulingPorts } from './context-graph-subscription-recover-row.js';
import { activateRollingSubscriptionPromotion } from './context-graph-subscription-authority-recovery.js';
import { requestStorageAckDemandActivation } from './storage-ack-demand-activation.js';
import { storageAckRecentGraphsOf, STORAGE_ACK_RECENT_GRAPHS_FILE, type StorageAckRecentGraphs } from './storage-ack-recent-graphs.js';

/** Compiler-checked integration of subscription recovery with the composed agent. */
export class SubscriptionRecoveryMethods extends DKGAgentBase {
  subscriptionRecoveryRowPorts(this: DKGAgent, isCurrent: () => boolean): SubscriptionRecoverySchedulingPorts | undefined {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return undefined;
    const touch = (): void => {
      const status = this.contextGraphSubscriptionRehydrationStatus;
      if (status) this.contextGraphSubscriptionRehydrationStatus = { ...status, updatedAt: Date.now() };
    };
    return {
      recovery: subscriptionRecoveryCoordinatorOf(this),
      isCurrent,
      dormancy: id => this.contextGraphSubscriptionDormancyById.get(id),
      revision: id => this.contextGraphSubscriptionPersistRevisions.get(id) ?? 0,
      subscription: id => this.subscribedContextGraphs.get(id),
      load: id => store.load ? store.load(id) : store.loadAll().then(rows => rows.find(row => row.id === id) ?? null),
      resolveAuthority: (row, signal) => this.resolveContextGraphSubscriptionBootstrapAuthority(row.id, {
        allowSubscriptionFallback: false, signal,
        durableSubscriptionBinding: { contextGraphId: row.id, onChainId: row.onChainId, onChainHash: row.onChainHash },
      }).catch((error: unknown) => unavailableContextGraphReadAuthorityDecision(
        'legacy-local', 'unexpected-authority-error', contextGraphReadAuthorityDependencyOf(error))),
      clear: (id, revoked) => revoked ? this.recordContextGraphSubscriptionClear([], [id]) : this.recordContextGraphSubscriptionClear([id]),
      retire: (id, reason) => { this.transitionContextGraphSubscriptionDormancy(id, reason); touch(); },
      capped: id => {
        this.transitionContextGraphSubscriptionDormancy(id, 'activationCap');
        this.requestContextGraphSubscriptionPromotion(id); touch();
      },
      activate: (row, onChainId, current) => this.activateUnavailablePersistedContextGraphSubscription(row, onChainId, current),
    };
  }

  /**
   * Activate a saved row left dormant as `authorityUnavailable` once its read
   * authority answered allowed. Cold registration discovery is the binding
   * proof: RFC-64 responsibility and the healed durable row become visible
   * atomically before any sync or gossip side effect is restored. Background
   * authority recovery and the name-binding retry both activate through it.
   */
  async activateUnavailablePersistedContextGraphSubscription(
    this: DKGAgent,
    row: ContextGraphSubscriptionRecord,
    onChainId: string | undefined,
    isOwnerCurrent: () => boolean,
  ): Promise<void> {
    const isCurrent = (subscription: ContextGraphSub): boolean => (
      isOwnerCurrent()
      && this.subscribedContextGraphs.get(row.id) === subscription
    );
    await this.activatePersistedContextGraphSubscriptionRecord(row, {
      onChainId, respectActivationCap: true,
      updateRehydrationStatus: false,
      prepare: async (subscription, persistRepair) => {
        await this.reconcileRfc64CatalogResponsibilityV1(row.id);
        if (!isOwnerCurrent()) throw new Error('Persisted subscription activation owner retired');
        await persistRepair(() => isCurrent(subscription));
      },
      isCurrent,
    });
  }

  storageAckRecentGraphs(this: DKGAgent): StorageAckRecentGraphs {
    return storageAckRecentGraphsOf(this, {
      ...(this.config.dataDir ? { path: join(this.config.dataDir, STORAGE_ACK_RECENT_GRAPHS_FILE) } : {}),
      warn: message => this.log.warn(createOperationContext('system'), message),
    });
  }

  /**
   * Hand the rows the startup pass left dormant because their chain name
   * binding could not be read to the retry that asks them again within
   * seconds (context-graph-subscription-name-binding-retry.ts).
   */
  retryPersistedSubscriptionNameBindings(this: DKGAgent): void {
    const ids = [...this.contextGraphSubscriptionNameBindingRetryIds];
    this.contextGraphSubscriptionNameBindingRetryIds.clear();
    const store = this.config.contextGraphSubscriptionStore;
    if (ids.length === 0 || !store || !this.started) return;
    const lifetime = this.workLifetime;
    const signal = lifetime.signal;
    const ctx = createOperationContext('init');
    const row = this.subscriptionRecoveryRowPorts(() => this.started && this.workLifetime.signal === signal
      && this.contextGraphSubscriptionRehydrationStatus?.rehydrationEnabled === true);
    if (!row) return;
    const retry = persistedSubscriptionNameBindingRetryOf(this, signal, () => new PersistedSubscriptionNameBindingRetry({
      ...row, signal,
      resolveAuthority: (record, checkSignal) => withOwnedRpcRequestContext(
        { requestClass: 'foreground', admissionPriority: 'authority', signal: checkSignal },
        () => row.resolveAuthority(record, checkSignal)),
      activate: (...args) => withOwnedRpcRequestContext({ requestClass: 'foreground', signal }, () => row.activate(...args)),
      track: run => { lifetime.track(run); },
      log: { info: message => this.log.info(ctx, message), warn: message => this.log.warn(ctx, message) },
    }));
    const taken = retry.take(ids);
    if (taken.length === 0) return;
    this.log.info(
      ctx,
      `Asking again within seconds for ${taken.length} persisted context-graph subscription(s) ` +
        `whose chain name binding could not be read at start: ${taken.map((id) => `"${id}"`).join(', ')}`,
    );
  }

  requestStorageAckDemandActivation(this: DKGAgent, id: string, onChainId: string): boolean {
    const store = this.config.contextGraphSubscriptionStore;
    const lifetime = this.workLifetime, signal = lifetime.signal;
    if (!store || lifetime.closed) return false;
    const ctx = createOperationContext('init');
    const owned = <T>(work: () => Promise<T>): Promise<T> => withOwnedRpcRequestContext(
      { requestClass: 'foreground', admissionPriority: 'authority', signal }, work);
    const shared = this.subscriptionRecoveryRowPorts(() => this.workLifetime.signal === signal
      && !this.coreHostRecordingsClosed && this.contextGraphSubscriptionRehydrationStatus !== null);
    if (!shared) return false;
    return requestStorageAckDemandActivation(this, {
      ...shared, signal,
      resolveAuthority: (row, checkSignal) => owned(() => shared.resolveAuthority(row, checkSignal)),
      capped: () => {}, // Current publisher demand bypasses ordinary startup pacing.
      activate: (row, binding, current) => {
        if (!binding) throw new Error('StorageACK demand activation requires a verified binding');
        return owned(() => activateRollingSubscriptionPromotion({
          activate: this.activatePersistedContextGraphSubscriptionRecord.bind(this),
          reconcile: this.reconcileRfc64CatalogResponsibilityV1.bind(this),
        }, row, binding, subscription => current() && shared.subscription(row.id) === subscription));
      },
      track: run => { lifetime.track(run); },
      log: { info: message => this.log.info(ctx, message), warn: message => this.log.warn(ctx, message),
        debug: message => this.log.debug(ctx, message) },
    }, id, onChainId);
  }

}
