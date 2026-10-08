import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphMembershipRecord, ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const LOCAL = 'activation-custody';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options: { persist: false }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  enqueueContextGraphMembershipPersistWrite(key: string, write: () => Promise<void>): Promise<void>;
}
class Gossip {
  readonly subscribed = new Set<string>();
  subscribe(topic: string) { this.subscribed.add(topic); }
  unsubscribe(topic: string) { this.subscribed.delete(topic); }
  onMessage() {}
  offMessage() {}
  async publish() {}
  getSubscribers() { return []; }
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(role: 'member' | 'host') {
  const saved: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: true, synced: true, sharedMemorySynced: true,
    metaSynced: true, syncScoped: true, onChainId: SLOT, onChainHash: HASH,
    lastReconciledOrdinal: 77,
  };
  const wire = { ...saved, id: HASH, subscribed: role === 'member', coreHosted: role === 'host', lastReconciledOrdinal: 17 };
  let retained: ContextGraphSubscriptionRecord[] = [wire, saved];
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => { retained = [...retained.filter(old => old.id !== row.id), { ...row }]; });
  const remove = vi.fn(async (id: string) => { retained = retained.filter(row => row.id !== id); });
  const members = new Map<string, ContextGraphMembershipRecord & { updatedAt: number }>();
  const key = (cg: string, kind: string, principal: string) => [cg, kind, principal].join('\0');
  const memberSave = vi.fn(async (row: ContextGraphMembershipRecord & { updatedAt: number }) => { members.set(key(row.contextGraphId, row.principalType, row.principalId), { ...row }); });
  const memberRemove = vi.fn(async (cg: string, kind: string, principal: string) => { members.delete(key(cg, kind, principal)); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  const agent = await DKGAgent.create({
    name: 'ActivationCustody', chainAdapter: chain, nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false }, contextGraphSubscriptionRehydrationEnabled: false,
    contextGraphSubscriptionStore: { loadAll: async () => retained.map(row => ({ ...row })), save, delete: remove },
    contextGraphMembershipStore: { loadAll: async () => [...members.values()], upsert: memberSave, delete: memberRemove },
  });
  agents.push(agent);
  (agent as unknown as { node: unknown }).node = { peerId: '12D3KooWActivationCustody', libp2p: { getPeers: () => [] } };
  const gossip = new Gossip();
  (agent as unknown as { gossip: Gossip }).gossip = gossip;
  const state = agent as unknown as Internals;
  state.setContextGraphSubscription(HASH, { ...wire, syncMode: 'always-on' }, { persist: false });
  if (role === 'member') agent.subscribeToContextGraph(HASH, { persist: false, trackSyncScope: false });
  await agent.rehydrateContextGraphSubscriptions(null);
  const drain = async () => {
    for (const id of [LOCAL, HASH]) {
      await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
      await state.enqueueContextGraphMembershipPersistWrite(key(id, 'node', agent.peerId), async () => undefined);
    }
  };
  for (const id of [LOCAL, HASH]) await agent.upsertContextGraphMember({
    contextGraphId: id, principalType: 'node', principalId: agent.peerId,
    role: 'subscriber', status: 'active', source: 'subscription', metadata: { onChainId: SLOT },
  }, { strict: true });
  await drain();
  const originalWire = state.subscribedContextGraphs.get(HASH)!;
  const originalWireSnapshot = { ...originalWire };
  const originalLocal = { ...state.subscribedContextGraphs.get(LOCAL)! };
  const originalMembers = [...members.values()].map(row => ({ ...row }));
  const originalTopics = new Set(gossip.subscribed);
  save.mockClear(); remove.mockClear(); memberSave.mockClear(); memberRemove.mockClear();
  const unchanged = () => {
    expect(state.subscribedContextGraphs.get(HASH)).toBe(originalWire);
    expect(originalWire).toEqual(originalWireSnapshot);
    expect(state.subscribedContextGraphs.get(LOCAL)).toEqual(originalLocal);
    expect(state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    expect(retained).toEqual([wire, saved]);
    expect([...members.values()]).toEqual(originalMembers);
    expect(gossip.subscribed).toEqual(originalTopics);
    expect(save).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(memberSave).not.toHaveBeenCalled(); expect(memberRemove).not.toHaveBeenCalled();
  };
  return { agent, state, saved, originalWire, originalWireSnapshot, drain, unchanged, remove, memberRemove };
}

describe('persisted activation commits admitted wire adoption after successful effects', () => {
  it.each(['member', 'host'] as const)('keeps admitted %s runtime and durable custody when prepare fails', async role => {
    const f = await fixture(role);
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord(f.saved, {
      prepare: async () => { throw new Error('owned prepare failure'); },
    })).rejects.toThrow('owned prepare failure');
    await f.drain(); f.unchanged();
  });

  it.each(['member', 'host'] as const)('keeps admitted %s custody after a post-subscribe failure', async role => {
    const f = await fixture(role);
    vi.spyOn(f.agent, 'persistLocalNodeMembership').mockImplementation(() => { throw new Error('owned membership boundary failure'); });
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord(f.saved)).rejects.toThrow('owned membership boundary failure');
    await f.drain(); f.unchanged();
  });

  it.each(['member', 'host'] as const)('still commits verified %s adoption after successful preparation', async role => {
    const f = await fixture(role);
    await f.agent.activatePersistedContextGraphSubscriptionRecord(f.saved);
    await f.drain();
    expect(f.state.subscribedContextGraphs.has(HASH)).toBe(false);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(LOCAL);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: true, onChainId: SLOT, onChainHash: HASH, lastReconciledOrdinal: 77,
    });
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted === true).toBe(role === 'host');
    expect(f.remove).toHaveBeenCalledWith(HASH);
  });

  it.each(['unsubscribe', 'replacement'] as const)('does not restore old inactive intent over a concurrent %s', async action => {
    const f = await fixture('member');
    let current: ContextGraphSub | undefined;
    let currentWireOwner: string | undefined;
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord(f.saved, {
      prepare: async () => {
        if (action === 'unsubscribe') f.agent.unsubscribeFromContextGraph(LOCAL);
        else f.state.setContextGraphSubscription(LOCAL, { subscribed: false, synced: false, onChainId: '777', onChainHash: HASH }, { persist: false });
        current = f.state.subscribedContextGraphs.get(LOCAL);
        currentWireOwner = f.state.wireIdToLocalCgId.get(HASH);
        throw new Error('owned activation superseded');
      },
    })).rejects.toThrow('owned activation superseded');
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(current);
    expect(f.state.subscribedContextGraphs.get(HASH)).toBe(f.originalWire);
    expect(f.originalWire).toEqual(f.originalWireSnapshot);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(currentWireOwner);
  });
});
