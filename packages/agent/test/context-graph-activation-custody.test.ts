import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { CursorState } from '../src/reconcile-cursor.js';
import type { ContextGraphMembershipRecord, ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const LOCAL = 'activation-custody';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  reconcileCursors: Map<string, CursorState>;
  config: { syncContextGraphs?: string[] };
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options: { persist: false }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  enqueueContextGraphMembershipPersistWrite(key: string, write: () => Promise<void>): Promise<void>;
}
class Gossip {
  readonly subscribed = new Set<string>();
  readonly handlers = new Map<string, unknown[]>();
  subscribe(topic: string) { this.subscribed.add(topic); }
  unsubscribe(topic: string) { this.subscribed.delete(topic); this.handlers.delete(topic); }
  onMessage(topic: string, handler: unknown) { this.handlers.set(topic, [...(this.handlers.get(topic) ?? []), handler]); }
  offMessage(topic: string, handler: unknown) { this.handlers.set(topic, (this.handlers.get(topic) ?? []).filter(value => value !== handler)); }
  async publish() {}
  getSubscribers() { return []; }
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(role: 'member' | 'host', options: { target?: 'member' | 'host'; foreign?: boolean; reverse?: boolean } = {}) {
  const saved: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: options.target !== 'host', coreHosted: options.target === 'host' ? true : undefined, synced: true, sharedMemorySynced: true,
    metaSynced: true, syncScoped: true, onChainId: SLOT, onChainHash: HASH,
    lastReconciledOrdinal: 77,
  };
  const wire = { ...saved, id: HASH, subscribed: role === 'member', coreHosted: role === 'host', onChainId: options.foreign ? '323' : SLOT, lastReconciledOrdinal: 17 };
  let retained: ContextGraphSubscriptionRecord[] = options.reverse ? [saved, wire] : [wire, saved];
  const originalRetained = retained.map(row => ({ ...row }));
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => { retained = [...retained.filter(old => old.id !== row.id), { ...row }]; });
  const remove = vi.fn(async (id: string) => { retained = retained.filter(row => row.id !== id); });
  const members = new Map<string, ContextGraphMembershipRecord & { updatedAt: number }>();
  const key = (cg: string, kind: string, principal: string) => [cg, kind, principal].join('\0');
  const memberSave = vi.fn(async (row: ContextGraphMembershipRecord & { updatedAt: number }) => { members.set(key(row.contextGraphId, row.principalType, row.principalId), { ...row }); });
  const memberRemove = vi.fn(async (cg: string, kind: string, principal: string) => { members.delete(key(cg, kind, principal)); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: options.foreign ? 323n : 582n });
  for (let id = options.foreign ? 323n : 582n; id <= 582n; id++) {
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: id === 323n || id === 582n ? HASH : ethers.ZeroHash });
  }
  if (options.foreign) await chain.__transferContextGraphOwnership(582n, '0x2222222222222222222222222222222222222222');
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
  if (options.reverse) await agent.rehydrateContextGraphSubscriptions(null);
  state.setContextGraphSubscription(HASH, { ...wire, syncMode: 'always-on' }, { persist: false });
  if (role === 'member') agent.subscribeToContextGraph(HASH, { persist: false, trackSyncScope: options.foreign === true });
  if (!options.reverse) await agent.rehydrateContextGraphSubscriptions(null);
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
  const originalHandlers = new Map([...gossip.handlers].map(([topic, handlers]) => [topic, [...handlers]]));
  save.mockClear(); remove.mockClear(); memberSave.mockClear(); memberRemove.mockClear();
  const unchanged = () => {
    expect(state.subscribedContextGraphs.get(HASH)).toBe(originalWire);
    expect(originalWire).toEqual(originalWireSnapshot);
    expect(state.subscribedContextGraphs.get(LOCAL)).toEqual(originalLocal);
    expect(state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    expect(retained).toEqual(originalRetained);
    expect([...members.values()]).toEqual(originalMembers);
    expect(gossip.subscribed).toEqual(originalTopics);
    expect(save).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(memberSave).not.toHaveBeenCalled(); expect(memberRemove).not.toHaveBeenCalled();
  };
  const retainedRows = () => retained.map(row => ({ ...row }));
  const retainedMembers = () => [...members.values()].map(row => ({ ...row }));
  return { agent, state, saved, originalWire, originalWireSnapshot, originalRetained, originalMembers, originalTopics, originalHandlers, gossip, retainedRows, retainedMembers, drain, unchanged, remove, memberRemove, chain };
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


const foreignCases = (['member', 'host'] as const).flatMap(target => (
  (['member', 'host'] as const).flatMap(wire => [false, true].map(reverse => ({ target, wire, reverse })))
));
describe('activation commit preserves a different numeric slot with the same commitment', () => {
  it.each(foreignCases)('preserves wire $wire slot323 while activating $target slot582 reverse=$reverse', async ({ target, wire, reverse }) => {
    const f = await fixture(wire, { target, foreign: true, reverse });
    const cursor: CursorState = { watermark: 17, ahead: new Map([[20, 123]]), scanOrdinal: 23 };
    f.state.reconcileCursors.set(HASH, cursor);
    const scopeBefore = [...(f.state.config.syncContextGraphs ?? [])];
    if (wire === 'member') { expect(scopeBefore).toContain(HASH); expect(f.originalHandlers.size).toBeGreaterThan(0); }
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({ kind: 'resolved', contextGraphId: HASH, onChainId: '323', nameHash: HASH });
    expect(f.chain.getContextGraph(323n)!.manager).not.toBe(f.chain.getContextGraph(582n)!.manager);

    await f.agent.activatePersistedContextGraphSubscriptionRecord(f.saved);
    await f.drain();

    expect(f.state.subscribedContextGraphs.get(HASH)).toBe(f.originalWire);
    expect(f.originalWire).toEqual(f.originalWireSnapshot);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    expect(f.retainedRows()).toEqual(f.originalRetained);
    expect(f.retainedMembers().filter(row => row.contextGraphId === HASH)).toEqual(f.originalMembers.filter(row => row.contextGraphId === HASH));
    expect(f.remove).not.toHaveBeenCalledWith(HASH);
    expect(f.memberRemove.mock.calls.filter(([id]) => id === HASH)).toEqual([]);
    for (const topic of f.originalTopics) expect(f.gossip.subscribed.has(topic)).toBe(true);
    for (const [topic, handlers] of f.originalHandlers) expect(f.gossip.handlers.get(topic)).toEqual(handlers);
    for (const id of scopeBefore) expect(f.state.config.syncContextGraphs).toContain(id);
    expect(f.state.reconcileCursors.get(HASH)).toBe(cursor);
    expect(cursor).toEqual({ watermark: 17, ahead: new Map([[20, 123]]), scanOrdinal: 23 });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ subscribed: target === 'member', onChainId: SLOT, lastReconciledOrdinal: 77 });
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted === true).toBe(target === 'host');
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({ kind: 'resolved', contextGraphId: HASH, onChainId: '323' });
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({ kind: 'resolved', contextGraphId: LOCAL, onChainId: SLOT });
  });
});
