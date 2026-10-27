// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';

let agent: DKGAgent | undefined;
afterEach(async () => { await agent?.stop(); vi.restoreAllMocks(); });
async function fixture() {
  agent = await DKGAgent.create({ name: 'ActivationCommit', chainAdapter: new MockChainAdapter(),
    syncReconcilerEnabled: false, vmReconcilerEnabled: false });
  const a = agent as any, id = 'commit-before-return';
  a.node = { peerId: '12D3KooWActivationCommit', libp2p: { getConnections: () => [], getPeers: () => [] } };
  a.gossip = { subscribe() {}, unsubscribe() {}, onMessage() {}, async publish() {}, getSubscribers: () => [] };
  a.contextGraphSubscriptionDormancyById.set(id, 'activationCap');
  a.contextGraphSubscriptionRehydrationPendingIds.add(id);
  a.contextGraphSubscriptionRehydrationStatus = { persistedTotal: 1, activated: 0,
    hostedActivated: 0, hostedActivatedIds: [], rehydrationEnabled: true, activationCap: 1 };
  a.contextGraphSubscriptionRehydrationAccountedIds.add(id);
  const events: unknown[] = [];
  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, () => events.push({
    dormant: a.contextGraphSubscriptionDormancyById.has(id), pending: a.contextGraphSubscriptionRehydrationPendingIds.has(id),
    slot: a.contextGraphSubscriptionRehydrationSlotIds.has(id), activated: a.contextGraphSubscriptionRehydrationStatus.activated,
    owner: a.contextGraphSubscriptionActivations.get(id),
  }));
  const row = { id, subscribed: true, synced: false, metaSynced: false, syncScoped: false, onChainId: '7' };
  return { a, id, row, events };
}

it.each([false, true])('returns a completed activation and publishes once with rolling slot policy %s', async claimRollingSlot => {
  const { a, row, events } = await fixture();
  a.contextGraphSubscriptionRehydrationStatus.activationCap = claimRollingSlot ? 1 : 0;
  const result = await a.activatePersistedContextGraphSubscriptionRecord(row, { claimRollingSlot });
  expect(result.subscribed).toBe(true);
  expect(events).toEqual([{ dormant: false, pending: false, slot: claimRollingSlot, activated: 1, owner: undefined }]);
});

it.each(['cancelled', 'prepare', 'subscribe'] as const)('never publishes a %s activation', async failure => {
  const { a, id, row, events } = await fixture();
  if (failure === 'subscribe') vi.spyOn(a, 'subscribeToContextGraph').mockImplementation(() => { throw new Error('subscribe'); });
  await expect(a.activatePersistedContextGraphSubscriptionRecord(row, {
    prepare: async () => { if (failure === 'prepare') throw new Error('prepare'); },
    isCurrent: () => failure !== 'cancelled',
    claimRollingSlot: true,
  })).rejects.toThrow(failure === 'cancelled' ? 'stale' : failure);
  expect(events).toEqual([]);
  expect(a.contextGraphSubscriptionRehydrationSlotIds.has(id)).toBe(false);
  expect(a.getSubscribedContextGraphs().get(id)?.subscribed).not.toBe(true);
});
