// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub } from './dkg-agent-types.js';
import type { SubscriptionDormancyTransition } from './context-graph-subscription-activation-state.js';
import type { SubscriptionAccountingChange } from './context-graph-subscription-accounting.js';
import { rehydratedSubscriptionReachedSafeState } from './context-graph-subscription-authority-recovery.js';

export interface PersistedSubscriptionFinalizationPorts {
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  readonly contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  completeActivation(id: string, subscription: ContextGraphSub, account: (transition: SubscriptionDormancyTransition) => void): boolean;
  accountContextGraphSubscriptionTransitions(changes: readonly SubscriptionAccountingChange[]): void;
}

/** The activation owner calls this once after its transaction and generation fence. */
export function finalizePersistedSubscriptionActivation(
  ports: PersistedSubscriptionFinalizationPorts, contextGraphId: string,
  claimRollingSlot: boolean, publish: (contextGraphId: string) => void,
): void {
  const subscription = ports.subscribedContextGraphs.get(contextGraphId);
  if (!subscription || (!subscription.subscribed && !subscription.coreHosted)) return;
  const completed = ports.completeActivation(contextGraphId, subscription, dormancy => {
    ports.contextGraphSubscriptionRehydrationPendingIds.delete(contextGraphId);
    if (claimRollingSlot && !subscription.coreHosted && !rehydratedSubscriptionReachedSafeState(subscription))
      ports.contextGraphSubscriptionRehydrationSlotIds.add(contextGraphId);
    ports.accountContextGraphSubscriptionTransitions([{ dormancy, kind: 'saved', persisted: true,
      active: true, hosted: subscription.coreHosted === true }]);
  });
  if (completed) publish(contextGraphId);
}
