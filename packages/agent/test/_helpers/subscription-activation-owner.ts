// SPDX-License-Identifier: Apache-2.0
import { DKGEvent } from '@origintrail-official/dkg-core';
import { ContextGraphSubscriptionActivations } from '../../src/context-graph-subscription-activation-state.js';

/** Supply the actual owner to fixtures that bypass DKGAgentBase initializers. */
export function createTestSubscriptionActivations(host: any): ContextGraphSubscriptionActivations {
  host.contextGraphSubscriptionRehydrationPendingIds ??= new Set();
  host.contextGraphSubscriptionRehydrationSlotIds ??= new Set();
  host.contextGraphSubscriptionRehydrationAccountedIds ??= new Set();
  return new ContextGraphSubscriptionActivations({
    subscribedContextGraphs: host.subscribedContextGraphs,
    contextGraphSubscriptionDormancyById: host.contextGraphSubscriptionDormancyById,
    contextGraphSubscriptionRehydrationPendingIds: host.contextGraphSubscriptionRehydrationPendingIds,
    contextGraphSubscriptionRehydrationSlotIds: host.contextGraphSubscriptionRehydrationSlotIds,
    contextGraphSubscriptionRehydrationAccountedIds: host.contextGraphSubscriptionRehydrationAccountedIds,
    getStatus: () => host.contextGraphSubscriptionRehydrationStatus ?? null,
    setStatus: status => { host.contextGraphSubscriptionRehydrationStatus = status; },
    publish: id => { host.eventBus?.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: id }); host.activated?.(id); },
  });
}
