import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { matchingContextGraphNamePredecessors } from '../src/context-graph-persisted-name-aliases.js';
import type { ContextGraphMembershipRecord, ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord, ContextGraphSubscriptionStore } from '../src/dkg-agent-types.js';

const LOCAL = 'dormant-predecessor-retirement';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  setContextGraphSubscription(id: string, row: ContextGraphSubInput, options?: { persist?: boolean; deferWireAdoption?: boolean }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  enqueueContextGraphMembershipPersistWrite(key: string, write: () => Promise<void>, options?: { strict?: boolean }): Promise<void>;
}
class Gossip {
  subscribe() {} unsubscribe() {} onMessage() {} offMessage() {}
  async publish() {} getSubscribers() { return []; }
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) { await agent.stop(); await agent.store.close(); }
  vi.restoreAllMocks();
});
function predecessor(overrides: Partial<ContextGraphSubscriptionRecord> = {}): ContextGraphSubscriptionRecord {
  return { id: HASH, subscribed: true, coreHosted: false, synced: true, sharedMemorySynced: true,
    metaSynced: true, syncScoped: true, onChainId: SLOT, onChainHash: HASH, ...overrides };
}
async function fixture(initial: ContextGraphSubscriptionRecord[] = [predecessor()], legacyMembers = false) {
  let rows = initial.map(row => ({ ...row }));
  let failDestination = false;
  const events: string[] = [];
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    if (failDestination && row.id === LOCAL) throw new Error('destination save refused');
    rows = [...rows.filter(old => old.id !== row.id), { ...row }]; events.push('save:' + row.id);
  });
  const remove = vi.fn(async (id: string) => { rows = rows.filter(row => row.id !== id); events.push('delete:' + id); });
  const loadAll = vi.fn(async () => rows.map(row => ({ ...row })));
  const members = new Map<string, ContextGraphMembershipRecord & { updatedAt: number }>();
  const memberKey = (id: string, principal: string) => `${id}\0node\0${principal}`;
  const membershipStore = {
    loadAll: async () => [...members.values()].map(row => ({ ...row, metadata: row.metadata && { ...row.metadata } })),
    upsert: async (row: ContextGraphMembershipRecord & { updatedAt: number }) => { members.set(memberKey(row.contextGraphId, row.principalId), { ...row }); },
    delete: vi.fn(async (id: string, _kind: string, principal: string) => { members.delete(memberKey(id, principal)); }),
  };
  const store: ContextGraphSubscriptionStore = { loadAll,
    load: async id => { const row = rows.find(value => value.id === id); return row ? { ...row } : null; }, save, delete: remove };
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  const create = async (enabled: boolean) => {
    const agent = await DKGAgent.create({ name: 'DormantPredecessor', nodeRole: 'edge', chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false }, contextGraphSubscriptionRehydrationEnabled: enabled,
      contextGraphSubscriptionStore: store, contextGraphMembershipStore: legacyMembers ? { upsert: membershipStore.upsert, delete: membershipStore.delete } : membershipStore });
    agents.push(agent);
    (agent as unknown as { node: unknown }).node = { peerId: '12D3KooWDormantPredecessor', libp2p: { getPeers: () => [] } };
    (agent as unknown as { gossip: Gossip }).gossip = new Gossip();
    await agent.rehydrateContextGraphSubscriptions(null);
    return agent;
  };
  const agent = await create(false);
  const state = agent as unknown as Internals;
  const drain = async () => {
    for (const id of [LOCAL, HASH, ...initial.map(row => row.id)]) {
      await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
      await state.enqueueContextGraphMembershipPersistWrite(memberKey(id, agent.peerId), async () => undefined, { strict: true });
    }
  };
  return { agent, state, store, chain, save, remove, loadAll, events, create, drain, members, membershipStore, rows: () => rows.map(row => ({ ...row })), fail: () => { failDestination = true; } };
}

describe('durable dormant name predecessor retirement', () => {
  it.each([false, true])('does not resurrect hash member intent after cleartext unsubscribe, saved host=%s', async host => {
    const f = await fixture([predecessor({ coreHosted: host })]);
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({ subscribed: false, coreHosted: false, onChainId: SLOT });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    expect(f.rows().some(row => row.id.toLowerCase() === HASH && row.subscribed)).toBe(false);
    if (host) expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true, onChainId: SLOT, onChainHash: HASH })]);
    else expect(f.rows()).toEqual([]);
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()?.persistedTotal).toBe(f.rows().length);
    const restarted = await f.create(true);
    expect((restarted as unknown as Internals).subscribedContextGraphs.get(HASH)?.subscribed ?? false).toBe(false);
    expect((restarted as unknown as Internals).subscribedContextGraphs.get(LOCAL)?.subscribed ?? false).toBe(false);
  });

  it('keeps a predecessor when the canonical destination save fails', async () => {
    const saved = predecessor({ coreHosted: true });
    const f = await fixture([saved]); f.fail();
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    expect(f.rows()).toEqual([saved]);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('keeps durable predecessor intent for an explicitly process-local adoption', async () => {
    const saved = predecessor(); const f = await fixture([saved]);
    f.agent.subscribeToContextGraph(LOCAL, { persist: false, deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    expect(f.rows()).toEqual([saved]);
  });

  it('does not retire a deferred adoption before its authoritative commit', async () => {
    const saved = predecessor(); const f = await fixture([saved]);
    f.agent.subscribeToContextGraph(LOCAL, { persist: false, deferWireAdoption: true, deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    expect(f.rows()).toEqual([saved]);
    expect(f.state.subscribedContextGraphs.has(HASH)).toBe(true);
  });

  it('carries saved hosting from an active hash member before durable retirement', async () => {
    const f = await fixture([predecessor({ coreHosted: true })]);
    f.agent.subscribeToContextGraph(HASH, { deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({ subscribed: true, coreHosted: false });
    expect(f.rows()[0]).toMatchObject({ subscribed: true, coreHosted: true });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true })]);
    expect(f.events.indexOf('save:' + LOCAL)).toBeLessThan(f.events.indexOf('delete:' + HASH));
  });

  it('retires a same-slot host-only predecessor while keeping hosting durably inactive', async () => {
    const f = await fixture([predecessor({ subscribed: false, coreHosted: true })]);
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true }); await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted === true).toBe(false);
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true })]);
  });

  it.each([
    { label: 'foreign numeric slot', change: { onChainId: '323' } },
    { label: 'missing numeric slot', change: { onChainId: undefined } },
    { label: 'malformed numeric slot', change: { onChainId: '0582' } },
    { label: 'literal hash-name mismatch', change: { onChainHash: ethers.keccak256(ethers.toUtf8Bytes(HASH)) } },
  ])('refuses a competing case variant with $label', async ({ change }) => {
    const wire = predecessor();
    const competing = predecessor({ id: HASH.toUpperCase().replace('0X', '0x'), ...change });
    const f = await fixture([wire, competing]);
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true }); await f.drain();
    expect(f.rows()).toContainEqual(wire); expect(f.rows()).toContainEqual(competing);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('retires qualified case variants regardless of snapshot order reverse=%s', async reverse => {
    const wire = predecessor(); const variant = predecessor({ id: HASH.toUpperCase().replace('0X', '0x'), coreHosted: true });
    const f = await fixture(reverse ? [variant, wire] : [wire, variant]);
    f.agent.subscribeToContextGraph(LOCAL, { onChainId: SLOT, deferSharedMemoryGossipSubscribe: true }); await f.drain();
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true })]);
  });

  it('keeps a predecessor when binding changes during its saved-host read', async () => {
    const saved = predecessor({ coreHosted: true }); const f = await fixture([saved]);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.loadAll.getMockImplementation()!;
    f.loadAll.mockImplementationOnce(async () => { entered(); await held; return original(); });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await started;
    f.agent.bindSubscriptionOnChainId(LOCAL, f.state.subscribedContextGraphs.get(LOCAL)!, '323');
    release(); await f.drain();
    expect(f.rows()).toEqual([saved]); expect(f.remove).not.toHaveBeenCalled();
  });

  it.each(['rebind', 'source-resubscribe'] as const)('keeps predecessor replacement after destination save: %s', async mutation => {
    const saved = predecessor({ coreHosted: true }); const f = await fixture([saved]);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async row => { await original(row); entered(); await held; });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await started;
    if (mutation === 'rebind') f.agent.bindSubscriptionOnChainId(LOCAL, f.state.subscribedContextGraphs.get(LOCAL)!, '323');
    else f.state.setContextGraphSubscription(HASH, { ...saved, subscribed: true, syncMode: 'always-on' }, { persist: false, deferWireAdoption: true });
    release(); await f.drain();
    expect(f.rows()).toContainEqual(saved); expect(f.remove).not.toHaveBeenCalled();
  });


  it('retires durable predecessor only after successful persisted activation commit', async () => {
    const f = await fixture([predecessor({ coreHosted: true })]);
    const saved: ContextGraphSubscriptionRecord = { ...predecessor(), id: LOCAL };
    await f.agent.activatePersistedContextGraphSubscriptionRecord(saved, {
      prepare: async subscription => f.agent.persistContextGraphSubscriptionStrict(LOCAL, subscription),
    });
    await f.drain();
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true })]);
  });

  it('does not retire durable predecessor when persisted activation preparation fails', async () => {
    const saved = predecessor({ coreHosted: true }); const f = await fixture([saved]);
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord({ ...saved, id: LOCAL }, {
      prepare: async () => { throw new Error('prepare refused'); },
    })).rejects.toThrow('prepare refused');
    await f.drain();
    expect(f.rows()).toEqual([saved]); expect(f.remove).not.toHaveBeenCalled();
  });


  it('retires queued hash membership when same-turn adoption fences the hash subscription save', async () => {
    const f = await fixture([]);
    expect(f.agent.stageOnChainContextGraphBindingFromNameHash(HASH, SLOT)).toBe(HASH);
    f.agent.subscribeToContextGraph(HASH, { deferSharedMemoryGossipSubscribe: true });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await f.drain();
    expect(f.rows().some(row => row.id === HASH)).toBe(false);
    expect([...f.members.values()].some(row => row.contextGraphId === HASH)).toBe(false);
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect([...f.members.values()].some(row => row.contextGraphId === LOCAL)).toBe(false);
    const restarted = await f.create(true);
    expect((restarted as unknown as Internals).subscribedContextGraphs.get(HASH)?.subscribed ?? false).toBe(false);
  });

  it('preserves a later strict membership upsert behind the checked retirement lane', async () => {
    const f = await fixture();
    await f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: SLOT } }, { strict: true });
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.membershipStore.loadAll;
    vi.spyOn(f.membershipStore, 'loadAll').mockImplementationOnce(async () => { const snapshot = await original(); entered(); await held; return snapshot; });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await started;
    const bindings = (f.agent as unknown as { contextGraphBindingState: { capture(id: string): number } }).contextGraphBindingState;
    const pointers = [f.state.subscribedContextGraphs.get(LOCAL), f.state.subscribedContextGraphs.get(HASH)];
    const generations = [bindings.capture(LOCAL), bindings.capture(HASH)];
    let completed = false;
    const update = f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: '323' } }, { strict: true }).then(() => { completed = true; });
    expect(completed).toBe(false);
    expect([f.state.subscribedContextGraphs.get(LOCAL), f.state.subscribedContextGraphs.get(HASH)]).toEqual(pointers);
    expect([bindings.capture(LOCAL), bindings.capture(HASH)]).toEqual(generations);
    release(); await update; await f.drain();
    expect(f.rows().some(row => row.id === HASH)).toBe(false);
    expect([...f.members.values()]).toContainEqual(expect.objectContaining({ contextGraphId: HASH, metadata: { onChainId: '323' } }));
  });

  it('does not coalesce a prior pending background membership upsert with retirement', async () => {
    const saved = predecessor(); const f = await fixture([saved]);
    const key = HASH + '\0node\0' + f.agent.peerId;
    let entered!: () => void; let release!: () => void; let queued!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const retirementQueued = new Promise<void>(resolve => { queued = resolve; });
    const blocker = f.state.enqueueContextGraphMembershipPersistWrite(key, async () => { entered(); await held; }, { strict: true });
    await started;
    const update = f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: '323' } });
    const enqueue = f.state.enqueueContextGraphMembershipPersistWrite.bind(f.state);
    vi.spyOn(f.state, 'enqueueContextGraphMembershipPersistWrite').mockImplementation((id, write, options) => {
      const result = enqueue(id, write, options); if (id === key) queued(); return result;
    });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await retirementQueued; release(); await blocker; await update; await f.drain();
    expect(f.rows()).toContainEqual(saved);
    expect([...f.members.values()]).toContainEqual(expect.objectContaining({ contextGraphId: HASH, metadata: { onChainId: '323' } }));
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('legacy unreadable membership keeps opaque rows but cannot resurrect subscribed intent, saved host=%s', async host => {
    const f = await fixture([predecessor({ coreHosted: host })], true);
    await f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: '323' } }, { strict: true });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true }); await f.drain();
    f.agent.unsubscribeFromContextGraph(LOCAL); await f.drain();
    expect(f.rows().some(row => row.id === HASH)).toBe(false);
    if (host) expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: false, coreHosted: true, onChainId: SLOT, onChainHash: HASH })]);
    else expect(f.rows()).toEqual([]);
    expect(f.membershipStore.delete).not.toHaveBeenCalledWith(HASH, 'node', f.agent.peerId);
    expect([...f.members.values()]).toContainEqual(expect.objectContaining({ contextGraphId: HASH, metadata: { onChainId: '323' } }));
    const restarted = await f.create(true);
    expect((restarted as unknown as Internals).subscribedContextGraphs.get(HASH)?.subscribed ?? false).toBe(false);
    expect((restarted as unknown as Internals).subscribedContextGraphs.get(LOCAL)?.subscribed ?? false).toBe(false);
  });

  it('preserves a newly durable Core predecessor with unchanged runtime ownership', async () => {
    const saved = predecessor(); const f = await fixture([saved]);
    await f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: SLOT } }, { strict: true });
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.membershipStore.loadAll;
    vi.spyOn(f.membershipStore, 'loadAll').mockImplementationOnce(async () => { entered(); await held; return original(); });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    await started;
    const bindings = (f.agent as unknown as { contextGraphBindingState: { capture(id: string): number } }).contextGraphBindingState;
    const pointer = f.state.subscribedContextGraphs.get(LOCAL);
    const sourcePointer = f.state.subscribedContextGraphs.get(HASH);
    const generation = bindings.capture(LOCAL); const sourceGeneration = bindings.capture(HASH);
    const newlyHosted = { ...saved, coreHosted: true };
    await f.store.save(newlyHosted);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(pointer);
    expect(f.state.subscribedContextGraphs.get(HASH)).toBe(sourcePointer);
    expect(bindings.capture(LOCAL)).toBe(generation); expect(bindings.capture(HASH)).toBe(sourceGeneration);
    release(); await f.drain();
    expect(f.rows()).toContainEqual(newlyHosted);
    expect(f.remove).not.toHaveBeenCalled(); expect(f.membershipStore.delete).not.toHaveBeenCalled();
    expect([...f.members.values()]).toContainEqual(expect.objectContaining({ contextGraphId: HASH }));
  });

  it('does not retire a source whose exact node membership now proves a foreign slot', async () => {
    const saved = predecessor(); const f = await fixture([saved]);
    await f.agent.upsertContextGraphMember({ contextGraphId: HASH, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', role: 'subscriber', metadata: { onChainId: '323' } }, { strict: true });
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true }); await f.drain();
    expect(f.rows()).toContainEqual(saved);
    expect([...f.members.values()]).toContainEqual(expect.objectContaining({ contextGraphId: HASH, metadata: { onChainId: '323' } }));
  });

});


describe('legacy missing-hash retirement requires captured native wire identity', () => {
  const destination = { id: LOCAL, onChainId: SLOT, onChainHash: HASH, coreHosted: false };
  const saved = predecessor({ onChainHash: undefined });
  it('accepts exact captured raw-wire identity after the canonical commit', () => {
    expect(matchingContextGraphNamePredecessors([saved], destination, false, predecessor())).toEqual([saved]);
  });
  it('does not infer raw-wire meaning from an unproved saved hash-shaped key', () => {
    expect(matchingContextGraphNamePredecessors([saved], destination, false)).toBeNull();
  });
  it.each([
    { id: HASH.toUpperCase() }, { onChainId: undefined }, { onChainId: '323' },
    { onChainHash: undefined }, { onChainHash: ethers.keccak256(ethers.toUtf8Bytes(HASH)) },
  ])('refuses a different or unproved captured predecessor %j', overrides => {
    expect(matchingContextGraphNamePredecessors([saved], destination, false, predecessor(overrides))).toBeNull();
  });
  it.each([null, '', 'malformed', ethers.keccak256(ethers.toUtf8Bytes(HASH))])('does not repair a known invalid saved commitment %s', onChainHash => {
    const invalid = { ...saved, onChainHash } as unknown as ContextGraphSubscriptionRecord;
    expect(matchingContextGraphNamePredecessors([invalid], destination, false, predecessor())).toBeNull();
  });
  it('refuses a foreign competing case variant or unpreserved saved Core intent', () => {
    expect(matchingContextGraphNamePredecessors([saved, predecessor({ id: HASH.toUpperCase(), onChainId: '323' })], destination, false, predecessor())).toBeNull();
    expect(matchingContextGraphNamePredecessors([{ ...saved, coreHosted: true }], destination, false, predecessor())).toBeNull();
  });
});
