// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import { unavailableContextGraphReadAuthorityDecision, contextGraphReadAuthorityDependencyOf } from './context-graph-read-authority.js';
import type { SubscriptionRecoveryRowPorts } from './context-graph-subscription-recover-row.js';
import { activateRollingSubscriptionPromotion } from './context-graph-subscription-authority-recovery.js';
import { requestStorageAckDemandActivation } from './storage-ack-demand-activation.js';
import { storageAckRecentGraphsOf, STORAGE_ACK_RECENT_GRAPHS_FILE, type StorageAckRecentGraphs } from './storage-ack-recent-graphs.js';

/** Compiler-checked integration of subscription recovery with the composed agent. */
export class SubscriptionRecoveryMethods extends DKGAgentBase {
  subscriptionRecoveryRowPorts(this: DKGAgent, isCurrent: () => boolean): SubscriptionRecoveryRowPorts | undefined {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return undefined;
    const touch = (): void => {
      const status = this.contextGraphSubscriptionRehydrationStatus;
      if (status) this.contextGraphSubscriptionRehydrationStatus = { ...status, updatedAt: Date.now() };
    };
    return {
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
      clear: (id, revoked) => this.recordContextGraphSubscriptionClear(revoked ? [] : [id], revoked ? [id] : []),
      retire: (id, reason) => { this.transitionContextGraphSubscriptionDormancy(id, reason); touch(); },
      capped: id => {
        this.transitionContextGraphSubscriptionDormancy(id, 'activationCap');
        this.requestContextGraphSubscriptionPromotion(id); touch();
      },
      activate: (row, onChainId, revision, current) => this.activateUnavailablePersistedContextGraphSubscription(row, onChainId, revision, current),
    };
  }

  async activateUnavailablePersistedContextGraphSubscription(
    this: DKGAgent,
    row: ContextGraphSubscriptionRecord,
    onChainId: string | undefined,
    revision: number,
    isOwnerCurrent: () => boolean,
  ): Promise<void> {
    const isCurrent = (subscription: ContextGraphSub): boolean => (
      isOwnerCurrent()
      && this.subscribedContextGraphs.get(row.id) === subscription
      && this.contextGraphSubscriptionDormancyById.get(row.id) === 'authorityUnavailable'
      && (this.contextGraphSubscriptionPersistRevisions.get(row.id) ?? 0) === revision
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

  requestStorageAckDemandActivation(this: DKGAgent, id: string, onChainId: string): boolean {
    const store = this.config.contextGraphSubscriptionStore;
    const lifetime = this.workLifetime, signal = lifetime.signal;
    if (!store || lifetime.closed) return false;
    const ctx = createOperationContext('init');
    const owned = <T>(work: () => Promise<T>): Promise<T> => withOwnedRpcRequestContext(
      { requestClass: 'foreground', admissionPriority: 'authority', signal }, work);
    return requestStorageAckDemandActivation(this, {
      signal,
      isCurrent: () => this.workLifetime.signal === signal && !this.coreHostRecordingsClosed
        && this.contextGraphSubscriptionRehydrationStatus !== null,
      dormancy: key => this.contextGraphSubscriptionDormancyById.get(key),
      revision: key => this.contextGraphSubscriptionPersistRevisions.get(key) ?? 0,
      subscription: key => this.subscribedContextGraphs.get(key),
      load: key => store.load ? store.load(key) : store.loadAll().then(rows => rows.find(row => row.id === key) ?? null),
      resolveAuthority: (binding, checkSignal) => owned(() => this.resolveContextGraphSubscriptionBootstrapAuthority(
        binding.contextGraphId, { allowSubscriptionFallback: false, signal: checkSignal, durableSubscriptionBinding: binding })),
      activate: (row, binding, current) => owned(() => activateRollingSubscriptionPromotion({
        activate: this.activatePersistedContextGraphSubscriptionRecord.bind(this),
        reconcile: this.reconcileRfc64CatalogResponsibilityV1.bind(this),
      }, row, binding, current)),
      clear: (key, revoked) => this.recordContextGraphSubscriptionClear(revoked ? [] : [key], revoked ? [key] : []),
      retire: (key, reason) => {
        this.transitionContextGraphSubscriptionDormancy(key, reason);
        const status = this.contextGraphSubscriptionRehydrationStatus;
        if (status) this.contextGraphSubscriptionRehydrationStatus = { ...status, updatedAt: Date.now() };
      },
      track: run => { lifetime.track(run); },
      log: { info: message => this.log.info(ctx, message), warn: message => this.log.warn(ctx, message),
        debug: message => this.log.debug(ctx, message) },
    }, id, onChainId);
  }

}
