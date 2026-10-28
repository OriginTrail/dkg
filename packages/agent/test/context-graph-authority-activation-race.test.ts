// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';

let agent: DKGAgent | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await agent?.stop();
  vi.restoreAllMocks();
});

it.each([
  { name: undefined, action: 'discovery' },
  { name: 'discovered name', action: 'discovery' },
  { name: undefined, action: 'unsubscribe' },
  { name: undefined, action: 'replacement' },
])('preserves the activation owner during $action name=$name', async ({ name, action }) => {
  const id = 'deferred-activation-readiness';
  const rows = new Map<string, ContextGraphSubscriptionRecord>([[id, {
    id, subscribed: true, synced: false, metaSynced: false,
    sharedMemorySynced: false, syncScoped: true, onChainId: '7',
  }]]);
  agent = await DKGAgent.create({
    name: 'AuthorityActivationReadiness', chainAdapter: new MockChainAdapter(),
    contextGraphSubscriptionRehydrationEnabled: true,
    syncReconcilerEnabled: false, vmReconcilerEnabled: false,
    contextGraphSubscriptionStore: {
      loadAll: async () => [...rows.values()],
      load: async key => rows.get(key) ?? null,
      save: async row => { rows.set(row.id, { ...row }); },
      delete: async key => { rows.delete(key); },
    },
  });
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWAuthorityActivation',
    libp2p: { getConnections: () => [], getPeers: () => [] },
  };
  (agent as unknown as { gossip: unknown }).gossip = {
    subscribe() {}, unsubscribe() {}, onMessage() {}, async publish() {},
    getSubscribers: () => [],
  };
  let available = false;
  const activations: unknown[] = [];
  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, event => activations.push(event));
  const subscribe = vi.spyOn(agent, 'installContextGraphSubscription');
  let discoveryObservation: { sameRow: boolean; stillDormant: boolean } | undefined;
  vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockImplementation(async () => available
    ? { outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 7n }
    : { outcome: 'unavailable', source: 'registered-chain', reason: 'temporary-authority-outage', metadataBootstrap: 'eligible' });
  const reconcile = vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1');
  reconcile.mockImplementation(async contextGraphId => {
    if (contextGraphId === id && available) {
      // Store discovery sees the provisional row while authority/bootstrap is
      // awaited. Even unchanged metadata must not persist activation as done.
      const provisional = agent!.getSubscribedContextGraphs().get(id);
      if (action === 'unsubscribe') agent!.unsubscribeFromContextGraph(id);
      if (action === 'replacement') {
        agent!.deleteContextGraphSubscription(id);
        agent!.subscribeToContextGraph(id, { onChainId: '8', syncMode: 'always-on' });
      }
      agent!.recordDiscoveredContextGraph(id, { name, onChainId: '7' });
      await agent!.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
      discoveryObservation = {
        sameRow: agent!.getSubscribedContextGraphs().get(id) === provisional,
        stillDormant: agent!.getContextGraphSubscriptionRehydrationStatus()?.dormantReasons.authorityUnavailable.includes(id) === true,
      };
    }
    return {
      active: false, mode: 'catalog', contextGraphId, responsible: false,
      responsibilityReason: null, selectionSource: 'default',
    };
  });
  await agent.rehydrateContextGraphSubscriptions(null);
  const signal = new AbortController().signal;
  const runtime = new CoalescingRecurringTask({
    retryIntervalMs: 30_000, runPass: async () => 'idle',
    onError: error => { throw error; }, closingMessage: 'test closed',
  });
  vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
  const internal = agent as unknown as { started: boolean; contextGraphSubscriptionAuthorityRecoveryRuntime: CoalescingRecurringTask };
  internal.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
  internal.started = true;
  available = true;
  try { await agent.retryUnavailableContextGraphSubscriptionAuthorities(signal); }
  finally { internal.started = false; }
  await agent.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
  if (action === 'unsubscribe') {
    expect(activations).toEqual([]);
    expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).not.toBe(true);
    expect(rows.has(id)).toBe(false);
    return;
  }
  if (action === 'replacement') {
    expect(activations).toEqual([]);
    expect(agent.getSubscribedContextGraphs().get(id)).toMatchObject({ subscribed: true, onChainId: '8' });
    expect(rows.get(id)).toMatchObject({ subscribed: true, onChainId: '8' });
    return;
  }
  // Recovery catches callback failures. Assertions belong outside that shell,
  // and active flags alone cannot prove the network activation committed.
  expect(discoveryObservation).toEqual({ sameRow: true, stillDormant: true });
  expect(activations).toEqual([{ contextGraphId: id }]);
  expect(subscribe).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledWith(id, expect.objectContaining({ persist: false, syncMode: 'always-on' }));
  expect(rows.get(id)?.subscribed).toBe(true);
  expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).toBe(true);
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ activated: 1, dormant: 0 });
  agent.recordDiscoveredContextGraph(id, { name: 'enrichment after commit', onChainId: '7' });
  await agent.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
  expect(rows.get(id)).toMatchObject({ name: 'enrichment after commit', subscribed: true });
});
