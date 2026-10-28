// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import type { PersistSubscriptionActivationRepair } from '../src/context-graph-subscription-authority-recovery.js';

let agent: DKGAgent | undefined;
afterEach(async () => { await agent?.stop(); vi.restoreAllMocks(); });
async function fixture() {
  agent = await DKGAgent.create({ name: 'ActivationCommit', chainAdapter: new MockChainAdapter(),
    syncReconcilerEnabled: false, vmReconcilerEnabled: false });
  const a = agent as any, id = 'commit-before-return';
  a.node = { peerId: '12D3KooWActivationCommit', libp2p: { getConnections: () => [], getPeers: () => [] } };
  const topics = new Set<string>();
  a.gossip = { subscribe(topic: string) { topics.add(topic); }, unsubscribe(topic: string) { topics.delete(topic); },
    onMessage() {}, async publish() {}, getSubscribers: () => [] };
  a.contextGraphSubscriptionDormancyById.set(id, 'activationCap');
  a.contextGraphSubscriptionRehydrationPendingIds.add(id);
  a.contextGraphSubscriptionRehydrationStatus = { persistedTotal: 1, activated: 0,
    hostedActivated: 0, hostedActivatedIds: [], rehydrationEnabled: true, activationCap: 1 };
  a.contextGraphSubscriptionRehydrationAccountedIds.add(id);
  const events: unknown[] = [], publicationWaits: Promise<unknown>[] = [];
  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, () => {
    publicationWaits.push(a.contextGraphSubscriptionActivations.wait(id, new AbortController().signal).catch((error: Error) => error.message));
    events.push({
    dormant: a.contextGraphSubscriptionDormancyById.has(id), pending: a.contextGraphSubscriptionRehydrationPendingIds.has(id),
    slot: a.contextGraphSubscriptionRehydrationSlotIds.has(id), activated: a.contextGraphSubscriptionRehydrationStatus.activated,
    });
  });
  const row = { id, subscribed: true, synced: false, metaSynced: false, syncScoped: false, onChainId: '7' };
  a.contextGraphSubscriptionActivations.reset([row]);
  a.contextGraphSubscriptionDormancyById.set(id, 'activationCap');
  return { a, id, row, events, topics, publicationWaits };
}

it.each([false, true])('returns a completed activation and publishes once with rolling slot policy %s', async claimRollingSlot => {
  const { a, row, events, publicationWaits } = await fixture();
  a.contextGraphSubscriptionRehydrationStatus.activationCap = claimRollingSlot ? 1 : 0;
  const result = await a.activatePersistedContextGraphSubscriptionRecord(row, { claimRollingSlot });
  expect(result.subscribed).toBe(true);
  expect(await Promise.all(publicationWaits)).toEqual(['Subscription activation ownership changed']);
  expect(events).toEqual([{ dormant: false, pending: false, slot: claimRollingSlot, activated: 1 }]);
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

it.each(['prepare', 'subscribe'] as const)('persists repaired intent and retains waiters across %s failure, retiring the failed retry capability', async failure => {
  const { a, id, row, events } = await fixture();
  const rows = new Map([[id, row]]);
  const save = vi.fn(async (record: typeof row) => { rows.set(record.id, { ...record }); });
  a.config.contextGraphSubscriptionStore = { load: async (key: string) => rows.get(key) ?? null,
    loadAll: async () => [...rows.values()], save, delete: async (key: string) => { rows.delete(key); } };
  const wait = a.contextGraphSubscriptionActivations.wait(id, new AbortController().signal);
  let settled = false, persistRepair!: PersistSubscriptionActivationRepair;
  void wait.then(() => { settled = true; });
  if (failure === 'subscribe') vi.spyOn(a, 'subscribeToContextGraph').mockImplementationOnce(() => { throw new Error('retryable network failure'); });
  await expect(a.activatePersistedContextGraphSubscriptionRecord(row, {
    onChainId: '8',
    prepare: async (_sub: unknown, persist: PersistSubscriptionActivationRepair) => {
      persistRepair = persist;
      await persist();
      if (failure === 'prepare') throw new Error('retryable preparation failure');
    },
  })).rejects.toThrow(failure === 'prepare' ? 'retryable preparation failure' : 'retryable network failure');
  expect(rows.get(id)?.onChainId).toBe('8');
  expect(settled).toBe(false); expect(events).toEqual([]);
  const writes = save.mock.calls.length;
  await expect(persistRepair()).rejects.toThrow('ownership changed');
  expect(save).toHaveBeenCalledTimes(writes);
  await a.activatePersistedContextGraphSubscriptionRecord(rows.get(id)!, {
    prepare: async () => {
      await expect(persistRepair()).rejects.toThrow('ownership changed');
      expect(save).toHaveBeenCalledTimes(writes);
    },
  });
  await expect(wait).resolves.toMatchObject({ kind: 'committed', subscription: { onChainId: '8' } });
  expect(events).toHaveLength(1);
});

it('rejects an overlapping retry without replacing the installing owner', async () => {
  const { a, id, row, events } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = a.activatePersistedContextGraphSubscriptionRecord(row, { prepare: () => gate });
  const wait = a.contextGraphSubscriptionActivations.wait(id, new AbortController().signal);
  try {
    await expect(a.activatePersistedContextGraphSubscriptionRecord(row)).rejects.toThrow('ownership changed');
    expect(events).toEqual([]);
  } finally { release(); }
  const committed = await first;
  await expect(wait).resolves.toEqual({ kind: 'committed', subscription: committed });
  expect(events).toHaveLength(1);
});

it('preserves a replacement subscription and gossip when preparation resumes without an optional fence', async () => {
  const { a, id, row, events, topics } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const activation = a.activatePersistedContextGraphSubscriptionRecord(row, { prepare: () => gate });
  const rejection = expect(activation).rejects.toThrow('ownership changed');
  a.unsubscribeFromContextGraph(id, { persist: false });
  a.subscribeToContextGraph(id, { persist: false, deferSharedMemoryGossipSubscribe: true });
  const replacement = a.subscribedContextGraphs.get(id), replacementTopics = new Set(topics);
  expect(replacement.subscribed).toBe(true); expect(topics.size).toBeGreaterThan(0);
  const subscribe = vi.spyOn(a, 'subscribeToContextGraph'), unsubscribe = vi.spyOn(a, 'unsubscribeFromContextGraph');
  release(); await rejection;
  expect(a.subscribedContextGraphs.get(id)).toBe(replacement);
  expect(topics).toEqual(replacementTopics);
  expect(subscribe).not.toHaveBeenCalled(); expect(unsubscribe).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});


it('rejects a queued replacement after activation before the snapshot reads inventory', async () => {
  const { a, id, row, topics } = await fixture();
  a.started = true;
  a.node.stop = async () => {};
  a.contextGraphSubscriptionDormancyById.set(id, 'authorityUnavailable');
  const send = vi.fn(async () => Buffer.from('{"unavailable":true}'));
  a.router = { send };
  let replacement: unknown, replacementTopics: Set<string>;
  a.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, () => {
    queueMicrotask(() => {
      a.unsubscribeFromContextGraph(id, { persist: false });
      a.subscribeToContextGraph(id, { persist: false, deferSharedMemoryGossipSubscribe: true });
      replacement = a.subscribedContextGraphs.get(id);
      replacementTopics = new Set(topics);
    });
  });
  const pending = a.syncPublicGraphSnapshot({ contextGraphId: id, onChainId: '7',
    mode: 'core-cache', trustedCorePeerIds: ['core'] });
  const rejected = expect(pending).rejects.toThrow('Snapshot job ownership changed');
  await a.activatePersistedContextGraphSubscriptionRecord(row);
  await rejected;
  expect(send).not.toHaveBeenCalled();
  expect(replacement).toBeDefined();
  expect(a.subscribedContextGraphs.get(id)).toBe(replacement);
  expect(topics).toEqual(replacementTopics!);
  expect(a.workLifetime.physicalRuns.size).toBe(0);
});

it.each([false, true])('explicit subscription retires dormant activation before persistence (persist=%s)', async persist => {
  const { a, id } = await fixture();
  a.contextGraphSubscriptionDormancyById.set(id, 'authorityUnavailable');
  const old = a.contextGraphSubscriptionActivations.wait(id, new AbortController().signal);
  const pendingSave = Promise.withResolvers<void>();
  const save = vi.fn(() => pendingSave.promise);
  a.config.contextGraphSubscriptionStore = { save, load: async () => null, loadAll: async () => [], delete: async () => undefined };
  try {
  a.subscribeToContextGraph(id, { persist });
  await expect(old).resolves.toEqual({ kind: 'cancelled' });
  expect(a.contextGraphSubscriptionDormancyById.has(id)).toBe(false);
  expect(a.contextGraphSubscriptionRehydrationPendingIds.has(id)).toBe(false);
  expect(a.waitForContextGraphSubscriptionActivation(id, new AbortController().signal)).toBeUndefined();
  expect(a.getSubscribedContextGraphs().get(id)?.subscribed).toBe(true);
  } finally { pendingSave.resolve(); }
});
