// SPDX-License-Identifier: Apache-2.0
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import { unavailableContextGraphReadAuthorityDecision, contextGraphReadAuthorityDependencyOf } from './context-graph-read-authority.js';
import type { SubscriptionRecoveryRowPorts } from './context-graph-subscription-recover-row.js';

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
      clear: id => this.recordContextGraphSubscriptionClear([id]),
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

}
