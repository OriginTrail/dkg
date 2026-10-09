import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord, ContextGraphSubscriptionStore } from '../src/dkg-agent-types.js';

const LOCAL = 'queued-unsubscribe-discovery';
const ID = '585';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL));
type Window = 'before-lane' | 'hosting-read';
interface State {
  node: unknown;
  gossip: unknown;
  config: { syncContextGraphs?: string[] };
  contextGraphSubscriptionPersistPendingRevisions: Map<string, Set<number>>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  setContextGraphSubscription(id: string, sub: ContextGraphSubInput, opts?: { persist?: boolean }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  persistContextGraphSubscription(id: string): Promise<void>;
  cancelContextGraphSubscriptionPersistRevisions(id: string): void;
  updateContextGraphSubscriptionRehydrationStatusAfterPersist(id: string, next?: ContextGraphSubscriptionRecord): void;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});
async function fixture(hosted = false) {
  const original: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: true, coreHosted: hosted, synced: true,
    sharedMemorySynced: true, metaSynced: true, syncScoped: false,
    onChainId: ID, onChainHash: HASH, lastReconciledOrdinal: 7,
  };
  let rows = [{ ...original }];
  const save = vi.fn(async (record: ContextGraphSubscriptionRecord) => {
    rows = [...rows.filter((row) => row.id !== record.id), { ...record }];
  });
  const remove = vi.fn(async (id: string) => { rows = rows.filter((row) => row.id !== id); });
  const store: ContextGraphSubscriptionStore = {
    loadAll: async () => rows.map((row) => ({ ...row })),
    load: async (id) => rows.find((row) => row.id === id) ?? null,
    save, delete: remove,
  };
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 585n });
  await chain.createOnChainContextGraph({ nameHash: HASH, accessPolicy: 0, publishPolicy: 1 });
  const agent = await DKGAgent.create({
    name: 'UnsubscribeDiscovery', nodeRole: 'edge', chainAdapter: chain,
    contextGraphSubscriptionRehydrationEnabled: false,
    rfc64CatalogActivation: { enabled: false }, contextGraphSubscriptionStore: store,
  });
  agents.push(agent);
  const state = agent as unknown as State;
  state.node = { peerId: '12D3KooWUnsubscribeDiscoveryFixture', libp2p: { getPeers: () => [] } };
  // Inert transport only: native subscribe/unsubscribe, discovery, binding,
  // projection, serial queue and all durable store decisions remain real.
  state.gossip = { subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn() };
  vi.spyOn(agent, 'queueSharedMemoryGossipSubscription').mockImplementation(() => undefined);
  vi.spyOn(agent, 'reconcileSwmHostModeSubscription').mockResolvedValue(undefined);
  await agent.rehydrateContextGraphSubscriptions(null);
  save.mockClear(); remove.mockClear();
  const drain = () => state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => undefined);
  const discover = () => agent.recordDiscoveredContextGraph(LOCAL, {
    name: 'passively enriched name', onChainId: ID, onChainHash: HASH,
    participantAgents: ['0x1111111111111111111111111111111111111111'],
  });
  return { agent, state, store, original, save, remove, drain, discover, rows: () => rows };
}
async function hold(f: Awaited<ReturnType<typeof fixture>>, window: Window) {
  const entered = deferred(); const release = deferred();
  if (window === 'before-lane') {
    void f.state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => {
      entered.resolve(); await release.promise;
    });
    await entered.promise;
  } else {
    const load = f.store.load!.bind(f.store);
    vi.spyOn(f.store, 'load').mockImplementation(async (id) => {
      const row = await load(id); entered.resolve(); await release.promise; return row;
    });
  }
  return { entered, release };
}

const windows: Window[] = ['before-lane', 'hosting-read'];
describe('passive discovery while explicit unsubscribe is queued', () => {

  const readinessChanges: { field: string; patch: Partial<ContextGraphSub> }[] = [
    { field: 'synced', patch: { synced: true } },
    { field: 'sharedMemorySynced', patch: { sharedMemorySynced: true } },
    { field: 'metaSynced', patch: { metaSynced: true } },
    { field: 'lastReconciledOrdinal', patch: { lastReconciledOrdinal: 19 } },
  ];
  const readinessCases = windows.flatMap((window) => [false, true].flatMap((hosted) => (
    readinessChanges.map((change) => ({ window, hosted, ...change }))
  )));
  it.each(readinessCases)('finishes unsubscribe through late inactive $field $window savedHosting=$hosted', async ({ window, hosted, patch }) => {
    const f = await fixture(hosted); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    const captured = { ...f.state.subscribedContextGraphs.get(LOCAL)! };
    try {
      if (window === 'hosting-read') await gate.entered.promise;
      const pointer = f.state.subscribedContextGraphs.get(LOCAL)!;
      expect(pointer).toEqual(captured);
      const pending = [...f.state.contextGraphSubscriptionPersistPendingRevisions.get(LOCAL)!];
      expect(pending).toHaveLength(1);
      f.agent.markContextGraphSubscriptionState(LOCAL, patch);
      expect(f.state.subscribedContextGraphs.get(LOCAL)).not.toBe(pointer);
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject(patch);
      expect([...f.state.contextGraphSubscriptionPersistPendingRevisions.get(LOCAL)!]).toEqual(pending);
    } finally { gate.release.resolve(); }
    await f.drain();
    if (hosted) {
      expect(f.rows()).toEqual([expect.objectContaining({
        subscribed: false, coreHosted: true, onChainId: ID, onChainHash: HASH,
        synced: captured.synced, sharedMemorySynced: captured.sharedMemorySynced,
        metaSynced: captured.metaSynced, lastReconciledOrdinal: captured.lastReconciledOrdinal,
      })]);
      expect(f.save).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled();
    } else {
      expect(f.rows()).toEqual([]);
      expect(f.remove).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
    }
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, onChainId: ID, onChainHash: HASH, ...patch,
    });
  });
  const intentCases = windows.flatMap((window) => (['sync-mode', 'sync-scope'] as const).map((intent) => ({ window, intent })));
  it.each(intentCases)('fences unqueued changed $intent intent during unsubscribe $window', async ({ window, intent }) => {
    const f = await fixture(); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    try {
      if (window === 'hosting-read') await gate.entered.promise;
      if (intent === 'sync-mode') f.agent.markContextGraphSubscriptionState(LOCAL, { syncMode: 'on-demand' });
      else {
        f.state.config.syncContextGraphs = [LOCAL];
        f.agent.markContextGraphSubscriptionState(LOCAL, { synced: true });
      }
    } finally { gate.release.resolve(); }
    await f.drain();
    expect(f.rows()).toEqual([f.original]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(windows)('finishes a member-only unsubscribe through same-slot discovery %s', async (window) => {
    const f = await fixture(); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    try {
      if (window === 'hosting-read') await gate.entered.promise;
      const captured = f.state.subscribedContextGraphs.get(LOCAL)!;
      f.discover();
      expect(f.state.subscribedContextGraphs.get(LOCAL)).not.toBe(captured);
    } finally { gate.release.resolve(); }
    await f.drain();
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, onChainId: ID, onChainHash: HASH,
      lastReconciledOrdinal: 7, name: 'passively enriched name',
    });
  });
  it.each(windows)('persists only genuine saved Core hosting after member unsubscribe %s', async (window) => {
    const f = await fixture(true); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    try { if (window === 'hosting-read') await gate.entered.promise; f.discover(); }
    finally { gate.release.resolve(); }
    await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({
      subscribed: false, coreHosted: true, synced: false, metaSynced: false,
      onChainId: ID, onChainHash: HASH, lastReconciledOrdinal: 7,
    })]);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ subscribed: false, coreHosted: false });
  });
  it.each(windows)('fences an in-place genuine numeric rebind %s', async (window) => {
    const f = await fixture(true); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    try {
      if (window === 'hosting-read') await gate.entered.promise;
      const current = f.state.subscribedContextGraphs.get(LOCAL)!;
      f.agent.bindSubscriptionOnChainId(LOCAL, current, '586');
    } finally { gate.release.resolve(); }
    await f.drain();
    expect(f.rows()).toEqual([f.original]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(windows)('retains a newer native resubscription %s', async (window) => {
    const f = await fixture(); const gate = await hold(f, window);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    try {
      if (window === 'hosting-read') await gate.entered.promise;
      f.agent.subscribeToContextGraph(LOCAL, { persist: false, deferSharedMemoryGossipSubscribe: true });
    } finally { gate.release.resolve(); }
    await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ subscribed: true, onChainId: ID })]);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('keeps active pointer ownership for a queued member snapshot', async () => {
    const f = await fixture(); const gate = await hold(f, 'before-lane');
    const active = f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true, metaSynced: true,
    }, { persist: false });
    const write = f.state.persistContextGraphSubscription(LOCAL);
    try {
      f.agent.recordDiscoveredContextGraph(LOCAL, { name: 'new metadata' }, { persist: false });
      expect(f.state.subscribedContextGraphs.get(LOCAL)).not.toBe(active);
    } finally { gate.release.resolve(); }
    await write; await f.drain();
    expect(f.rows()).toEqual([f.original]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it('serializes queued member/readiness intents before the final unsubscribe', async () => {
    const f = await fixture(); const gate = await hold(f, 'before-lane');
    f.agent.unsubscribeFromContextGraph(LOCAL);
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    f.agent.markContextGraphSubscriptionState(LOCAL, { metaSynced: true });
    f.agent.unsubscribeFromContextGraph(LOCAL);
    f.discover();
    gate.release.resolve(); await f.drain();
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledTimes(2);
  });
  it('lets a queued native resubscription win after the earlier unsubscribe', async () => {
    const f = await fixture(); const gate = await hold(f, 'before-lane');
    f.agent.unsubscribeFromContextGraph(LOCAL);
    f.agent.subscribeToContextGraph(LOCAL, { deferSharedMemoryGossipSubscribe: true });
    gate.release.resolve(); await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ subscribed: true, onChainId: ID })]);
    expect(f.remove).toHaveBeenCalledTimes(1); expect(f.save).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('preserves ordered immutable snapshots when newer save failure is %s', async (failLatest) => {
    const f = await fixture();
    const entered = deferred(); const release = deferred();
    const write = f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async (record) => {
      entered.resolve(); await release.promise; await write(record);
    }).mockImplementationOnce(async (record) => {
      if (failLatest) throw new Error('owned newest save failed');
      await write(record);
    });
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true, synced: false,
    });
    f.agent.markContextGraphSubscriptionState(LOCAL, { synced: true });
    try {
      await entered.promise;
      expect(f.save.mock.calls[0][0].synced).toBe(false);
    } finally { release.resolve(); }
    await f.drain();
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.save.mock.calls.map(([row]) => row.synced)).toEqual([false, true]);
    expect(f.rows()).toEqual([expect.objectContaining({ subscribed: true, synced: !failLatest })]);
  });
  it('keeps both queued durable snapshots when only their status callbacks are canceled', async () => {
    const f = await fixture(); const gate = await hold(f, 'before-lane');
    const status = vi.spyOn(f.state, 'updateContextGraphSubscriptionRehydrationStatusAfterPersist');
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true, synced: false,
    });
    f.agent.markContextGraphSubscriptionState(LOCAL, { synced: true });
    f.state.cancelContextGraphSubscriptionPersistRevisions(LOCAL);
    gate.release.resolve(); await f.drain();
    expect(f.save.mock.calls.map(([row]) => row.synced)).toEqual([false, true]);
    expect(f.rows()).toEqual([expect.objectContaining({ subscribed: true, synced: true })]);
    expect(status).not.toHaveBeenCalled();
  });
});
