// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';
import { rehydratedSubscriptionReachedSafeState } from './context-graph-subscription-authority-recovery.js';

export interface PersistedSubscriptionFinalizationPorts {
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  readonly contextGraphSubscriptionDormancyById: Map<string, ContextGraphDormancyReason>;
  updateContextGraphSubscriptionRehydrationStatusAfterPersist(id: string, intent: Pick<ContextGraphSubscriptionRecord, 'subscribed' | 'coreHosted'>): void;
}

/** The activation owner calls this once after its transaction and generation fence. */
export function finalizePersistedSubscriptionActivation(
  ports: PersistedSubscriptionFinalizationPorts, contextGraphId: string,
  claimRollingSlot: boolean, publish: (contextGraphId: string) => void,
): void {
  const subscription = ports.subscribedContextGraphs.get(contextGraphId);
  if (!subscription || (!subscription.subscribed && !subscription.coreHosted)) return;
  ports.contextGraphSubscriptionRehydrationPendingIds.delete(contextGraphId);
  // Count the dormant-to-active transition before removing any remaining marker.
  ports.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, subscription);
  ports.contextGraphSubscriptionDormancyById.delete(contextGraphId);
  if (claimRollingSlot && !subscription.coreHosted && !rehydratedSubscriptionReachedSafeState(subscription))
    ports.contextGraphSubscriptionRehydrationSlotIds.add(contextGraphId);
  publish(contextGraphId);
}
