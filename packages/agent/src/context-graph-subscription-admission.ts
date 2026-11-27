import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub } from './dkg-agent-types.js';

/** Admit a complete authenticated binding, or enrich an admitted row without re-arming gossip. */
export function admitAuthenticatedContextGraphSubscription(
  agent: DKGAgent,
  contextGraphId: string,
  binding: { onChainId: string; onChainHash: string },
): ContextGraphSub {
  const existing = agent.getSubscribedContextGraphs().get(contextGraphId);
  if (!existing?.subscribed) {
    return agent.subscribeToContextGraph(contextGraphId, {
      ...binding, syncMode: 'on-demand', trackSyncScope: false, deferSharedMemoryGossipSubscribe: true,
    });
  }
  if (existing.onChainId === binding.onChainId && existing.onChainHash === binding.onChainHash) return existing;
  const next = { ...existing, onChainHash: binding.onChainHash };
  agent.bindSubscriptionOnChainId(contextGraphId, next, binding.onChainId);
  return agent.setContextGraphSubscription(contextGraphId, next);
}
