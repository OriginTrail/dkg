import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionStore } from '../src/dkg-agent-types.js';

const LOCAL = 'bulk-clear-saved-core';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL));
interface State {
  node: unknown;
  gossip: unknown;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) { await agent.stop(); await agent.store.close(); }
  vi.restoreAllMocks();
});
async function fixture(hosted: boolean) {
  const original: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: true, coreHosted: hosted, synced: true,
    sharedMemorySynced: true, metaSynced: true, syncScoped: true,
    onChainId: '582', onChainHash: HASH, lastReconciledOrdinal: 7,
  };
  const rows = new Map([[LOCAL, { ...original }]]);
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => { rows.set(row.id, { ...row }); });
  const remove = vi.fn(async (id: string) => { rows.delete(id); });
  const store: ContextGraphSubscriptionStore = {
    loadAll: async () => [...rows.values()].map(row => ({ ...row })),
    load: async id => { const row = rows.get(id); return row ? { ...row } : null; },
    save, delete: remove,
  };
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
  await chain.createOnChainContextGraph({ nameHash: HASH, accessPolicy: 0, publishPolicy: 1 });
  const agent = await DKGAgent.create({ name: 'BulkClearHostedIntent', nodeRole: 'edge', chainAdapter: chain,
    contextGraphSubscriptionRehydrationEnabled: false, rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: store });
  agents.push(agent);
  const state = agent as unknown as State;
  state.node = { peerId: '12D3KooWBulkClearSavedCore', libp2p: { getPeers: () => [] } };
  state.gossip = { subscribe() {}, unsubscribe() {}, onMessage() {} };
  await agent.rehydrateContextGraphSubscriptions(null);
  const drain = () => state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => undefined);
  return { agent, state, store, original, rows, save, remove, drain };
}

describe('bulk clear preserves independent saved Core hosting', () => {
  it.each([false, true])('retains disabled hosting intent and identity, held unsubscribe=%s', async held => {
    const f = await fixture(true);
    const entered = deferred(); const release = deferred();
    const load = f.store.load!.bind(f.store);
    if (held) {
      vi.spyOn(f.store, 'load').mockImplementation(async id => {
        const row = await load(id); entered.resolve(); await release.promise; return row;
      });
      f.agent.unsubscribeFromContextGraph(LOCAL);
      await entered.promise;
    }
    try {
      const clearing = f.agent.clearContextGraphSubscriptions();
      await Promise.resolve(); release.resolve();
      expect(await clearing).toBe(0);
      await f.drain();
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.rows.get(LOCAL)).toMatchObject({ coreHosted: true, onChainId: '582', onChainHash: HASH });
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ subscribed: false, coreHosted: false, onChainId: '582' });
      expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 1, hostedActivated: 0 });
    } finally { release.resolve(); }
  });

  it('rechecks durable hosting after an earlier native queued write settles', async () => {
    const f = await fixture(false); const entered = deferred(); const release = deferred();
    const earlier = f.state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => {
      entered.resolve(); await release.promise;
      await f.store.save({ ...f.original, subscribed: false, coreHosted: true });
    });
    await entered.promise;
    try {
      const clearing = f.agent.clearContextGraphSubscriptions();
      await Promise.resolve(); release.resolve();
      await earlier;
      expect(await clearing).toBe(0);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.rows.get(LOCAL)).toMatchObject({ coreHosted: true });
    } finally { release.resolve(); }
  });

  it('keeps durable rows when the fresh exact-key read fails', async () => {
    const f = await fixture(false);
    vi.spyOn(f.store, 'load').mockRejectedValue(new Error('fresh hosting read unavailable'));
    expect(await f.agent.clearContextGraphSubscriptions()).toBe(0);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.rows.get(LOCAL)).toEqual(f.original);
  });

  it('still clears a non-hosted pending save in native FIFO order', async () => {
    const f = await fixture(false); const entered = deferred(); const release = deferred();
    const earlier = f.state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => {
      entered.resolve(); await release.promise; await f.store.save(f.original);
    });
    await entered.promise;
    try {
      const clearing = f.agent.clearContextGraphSubscriptions();
      await Promise.resolve(); release.resolve(); await earlier;
      expect(await clearing).toBe(1);
      expect(f.rows.size).toBe(0);
      expect(f.state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    } finally { release.resolve(); }
  });
});
