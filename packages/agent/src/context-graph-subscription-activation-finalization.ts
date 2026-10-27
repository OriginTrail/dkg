// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import { rehydratedSubscriptionReachedSafeState } from './context-graph-subscription-authority-recovery.js';

export interface PersistedSubscriptionFinalizationPorts {
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  completeActivation(id: string, subscription: ContextGraphSub, finalize: () => void): boolean;
  updateContextGraphSubscriptionRehydrationStatusAfterPersist(id: string, intent: Pick<ContextGraphSubscriptionRecord, 'subscribed' | 'coreHosted'>): void;
}

/** The activation owner calls this once after its transaction and generation fence. */
export function finalizePersistedSubscriptionActivation(
  ports: PersistedSubscriptionFinalizationPorts, contextGraphId: string,
  claimRollingSlot: boolean, publish: (contextGraphId: string) => void,
): void {
  const subscription = ports.subscribedContextGraphs.get(contextGraphId);
  if (!subscription || (!subscription.subscribed && !subscription.coreHosted)) return;
  const completed = ports.completeActivation(contextGraphId, subscription, () => {
    ports.contextGraphSubscriptionRehydrationPendingIds.delete(contextGraphId);
    ports.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, subscription);
    if (claimRollingSlot && !subscription.coreHosted && !rehydratedSubscriptionReachedSafeState(subscription))
      ports.contextGraphSubscriptionRehydrationSlotIds.add(contextGraphId);
  });
  if (completed) publish(contextGraphId);
}
