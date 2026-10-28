import { afterEach, expect, it, vi } from 'vitest';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { startActivationCatchups } from '../src/daemon/context-graph-activation-catchup.js';
import { daemonState } from '../src/daemon/state.js';
import { cancelContextGraphReadinessRepeats } from '../src/daemon/context-graph-readiness-repeat.js';
import { CG, cleanEmptyRound, memberEdge, waitUntil } from './_helpers/readiness-member-edge.js';

const previousRunner = daemonState.catchupRunner;
afterEach(() => { cancelContextGraphReadinessRepeats(); daemonState.catchupRunner = previousRunner; vi.restoreAllMocks(); });

it.each(['authorityUnavailable', 'activationCap'] as const)('catches up a real committed %s activation with an idle runner', async reason => {
  const row = { id: CG, subscribed: true, synced: false, metaSynced: false, sharedMemorySynced: false, syncScoped: true, onChainId: '7' };
  const agent = await DKGAgent.create({ name: 'CommittedActivation', chainAdapter: new MockChainAdapter(),
    contextGraphSubscriptionRehydrationEnabled: true, syncReconcilerEnabled: false, vmReconcilerEnabled: false,
    contextGraphSubscriptionStore: { loadAll: async () => [row], load: async () => row, save: async () => {}, delete: async () => {} } });
  // Exercise the actual recovery, transaction and event sequence; only network
  // side effects and the eventual transfer are isolated from this unit test.
  const host = agent as any;
  host.node = { peerId: '12D3KooWCommittedActivation', libp2p: { getConnections: () => [], getPeers: () => [] } };
  host.gossip = { subscribe() {}, unsubscribe() {}, onMessage() {}, async publish() {}, getSubscribers: () => [] };
  host.started = true;
  host.contextGraphSubscriptionRehydrationStatus = { rehydrationEnabled: true, activationCap: 1, activated: 0, hostedActivated: 0 };
  host.contextGraphSubscriptionRehydrationAccountedIds.add(CG);
  host.contextGraphSubscriptionDormancyById.set(CG, reason);
  if (reason === 'activationCap') host.contextGraphSubscriptionRehydrationPendingIds.add(CG);
  const signal = new AbortController().signal;
  const owner = { owns: (candidate: AbortSignal) => candidate === signal };
  host[reason === 'activationCap' ? 'contextGraphSubscriptionRehydrationPromotionRuntime' : 'contextGraphSubscriptionAuthorityRecoveryRuntime'] = owner;
  vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockResolvedValue({
    outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 7n });
  const runs: string[] = [], provisional: boolean[] = [], events: boolean[] = [];
  vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockImplementation(async () => {
    provisional.push(agent.getContextGraphSubscriptionRehydrationStatus()!.dormantIds.includes(CG));
    expect(runs).toEqual([]);
    return { active: false, mode: 'catalog', contextGraphId: CG, responsible: false, responsibilityReason: null, selectionSource: 'default' };
  });
  const member = memberEdge();
  const bridge = Object.assign(member.agent, {
    eventBus: agent.eventBus, subscribedContextGraphs: agent.getSubscribedContextGraphs(),
    getSubscribedContextGraphs: agent.getSubscribedContextGraphs.bind(agent),
    getContextGraphSubscriptionRehydrationStatus: agent.getContextGraphSubscriptionRehydrationStatus.bind(agent),
    markContextGraphSubscriptionState: agent.markContextGraphSubscriptionState.bind(agent),
  });
  daemonState.catchupRunner = { run: async request => { runs.push(request.contextGraphId); return cleanEmptyRound(); }, close: async () => {} };
  const stop = startActivationCatchups({ agent: bridge, store: member.store,
    catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() }, log: () => {} });
  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, () => events.push(
    agent.getContextGraphSubscriptionRehydrationStatus()!.dormantIds.includes(CG)));
  try {
    expect(runs).toEqual([]);
    if (reason === 'activationCap') await agent.promoteDormantContextGraphSubscriptions(signal);
    else await agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
    expect(provisional).toEqual([true]);
    expect(events).toEqual([false]);
    await waitUntil(() => runs.length === 1 ? true : undefined, 'committed activation catch-up');
    await waitUntil(() => agent.getSubscribedContextGraphs().get(CG)?.synced === true ? true : undefined, 'catch-up readiness');
    expect(runs).toEqual([CG]);
    expect(host.contextGraphSubscriptionRehydrationSlotIds.has(CG)).toBe(false);
  } finally {
    stop(); host.started = false;
    host.contextGraphSubscriptionAuthorityRecoveryRuntime = undefined;
    host.contextGraphSubscriptionRehydrationPromotionRuntime = undefined;
    await agent.stop();
  }
});
