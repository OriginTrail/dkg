import { DKGEvent } from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(hosted: boolean, unbound = false) {
  const original: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: true, coreHosted: hosted, synced: true,
    sharedMemorySynced: true, metaSynced: true, syncScoped: true,
    ...(unbound ? {} : { onChainId: '582', onChainHash: HASH }), lastReconciledOrdinal: 7,
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
    contextGraphSubscriptionRehydrationEnabled: unbound, rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: store });
  agents.push(agent);
  const state = agent as unknown as State;
  state.node = { peerId: '12D3KooWBulkClearSavedCore', libp2p: { getPeers: () => [] } };
  state.gossip = { subscribe() {}, unsubscribe() {}, onMessage() {} };
  if (unbound) vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockResolvedValue({
    outcome: 'unavailable', source: 'registered-chain', reason: 'temporary-authority-outage', metadataBootstrap: 'eligible',
  });
  await agent.rehydrateContextGraphSubscriptions(null);
  const drain = () => state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => undefined);
  return { agent, state, store, original, rows, save, remove, drain };
}

describe('bulk clear preserves independent saved Core hosting', () => {
  it('settles owned binding repair without issuing or releasing a waiter-owned durable load', async () => {
    const f = await fixture(false, true), state = f.agent as any;
    const delayed = deferred(); let recoveryMayRead = false;
    const load = f.store.load!.bind(f.store);
    const loadSpy = vi.spyOn(f.store, 'load').mockImplementation(async id => {
      if (!recoveryMayRead) await delayed.promise;
      return load(id);
    });
    const signal = new AbortController().signal;
    const runtime = new CoalescingRecurringTask({ retryIntervalMs: 30_000, runPass: async () => 'idle',
      onError: error => { throw error; }, closingMessage: 'test closed' });
    vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
    state.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
    state.started = true; vi.useFakeTimers();
    let settled = false;
    const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, signal)
      .then(() => { settled = true; return 'activated'; }, (error: Error) => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(loadSpy).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      recoveryMayRead = true;
      vi.mocked(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).mockResolvedValue({
        outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 582n,
      });
      await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      expect(f.rows.get(LOCAL)?.onChainId).toBe('582');
      expect(f.agent.isContextGraphSubscriptionCommitted(LOCAL)).toBe(true);
      // Only lifecycle recovery may read. A hypothetical waiter read remains blocked.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await outcome).toBe('activated');
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { delayed.resolve(); state.started = false; vi.useRealTimers(); }
  });

  it('retains the owned durable binding repair when network activation rolls back before a later retry', async () => {
    const f = await fixture(false, true), state = f.agent as any;
    const signal = new AbortController().signal;
    const runtime = new CoalescingRecurringTask({ retryIntervalMs: 30_000, runPass: async () => 'idle',
      onError: error => { throw error; }, closingMessage: 'test closed' });
    vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
    state.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
    state.started = true;
    let settled = false;
    const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, signal)
      .then(() => { settled = true; return 'activated'; }, (error: Error) => { settled = true; return error; });
    vi.mocked(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).mockResolvedValue({
      outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 582n,
    });
    vi.spyOn(f.agent, 'subscribeToContextGraph').mockImplementationOnce(() => { throw new Error('network activation failed'); });
    try {
      await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      expect(f.rows.get(LOCAL)?.onChainId).toBe('582');
      expect(f.agent.isContextGraphSubscriptionCommitted(LOCAL)).toBe(false);
      expect(settled).toBe(false);
      await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      expect(await outcome).toBe('activated');
      expect(f.agent.isContextGraphSubscriptionCommitted(LOCAL)).toBe(true);
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { state.started = false; }
  });

  it.each(['recover', 'clear', 'replace'] as const)('owns unbound persisted activation through %s', async action => {
    const f = await fixture(false, true), state = f.agent as any;
    expect(state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    expect(state.contextGraphSubscriptionDormancyById.get(LOCAL)).toBe('authorityUnavailable');
    const signal = new AbortController().signal;
    const runtime = new CoalescingRecurringTask({ retryIntervalMs: 30_000, runPass: async () => 'idle',
      onError: error => { throw error; }, closingMessage: 'test closed' });
    vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
    state.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
    state.started = true;
    vi.useFakeTimers();
    let settled = false;
    const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, signal)
      .then(() => { settled = true; return 'activated'; }, (error: Error) => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(2500);
      expect(settled).toBe(false);
      if (action === 'clear') await f.agent.clearContextGraphSubscriptions();
      else {
        if (action === 'replace') await f.store.save({ ...f.original, onChainId: '583' });
        vi.mocked(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).mockResolvedValue({
          outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible',
          onChainId: action === 'replace' ? 583n : 582n,
        });
        await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      }
      await vi.advanceTimersByTimeAsync(2500);
      if (action === 'recover') {
        expect(await outcome).toBe('activated');
        expect(state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ subscribed: true, onChainId: '582' });
      } else expect(await outcome).toMatchObject({ message: 'Subscription activation ownership changed' });
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { state.started = false; vi.useRealTimers(); }
  });

  it('finalizes rolling activation while another graph is denied during its preparation', async () => {
    const f = await fixture(false, true), state = f.agent as any;
    const other = { ...f.original, id: 'unrelated-denied', onChainId: '583', onChainHash: ethers.id('unrelated-denied') };
    await f.store.save(other);
    const caller = new AbortController(), signal = caller.signal, entered = deferred(), release = deferred();
    const runtime = new CoalescingRecurringTask({ retryIntervalMs: 30_000, runPass: async () => 'idle',
      onError: error => { throw error; }, closingMessage: 'test closed' });
    vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
    state.contextGraphSubscriptionRehydrationPromotionRuntime = runtime;
    state.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
    state.contextGraphSubscriptionRehydrationStatus.rehydrationEnabled = true;
    state.contextGraphSubscriptionRehydrationStatus.activationCap = 1;
    state.contextGraphSubscriptionRehydrationPendingIds.add(LOCAL);
    state.contextGraphSubscriptionActivations.reset([f.original, other]);
    state.transitionContextGraphSubscriptionDormancy(LOCAL, 'activationCap');
    state.transitionContextGraphSubscriptionDormancy(other.id, 'authorityUnavailable');
    vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockImplementation(async id => id === LOCAL ? {
      outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 582n,
    } : { outcome: 'denied', source: 'registered-chain', reason: 'not-a-member', metadataBootstrap: 'forbidden' });
    const persist = f.agent.persistContextGraphSubscriptionStrict.bind(f.agent);
    vi.spyOn(f.agent, 'persistContextGraphSubscriptionStrict').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return persist(...args);
    });
    const events: string[] = [];
    f.agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, event => events.push(event.contextGraphId));
    state.started = true;
    const promotion = f.agent.promoteDormantContextGraphSubscriptions(signal);
    try {
      await entered.promise;
      const owner = state.contextGraphSubscriptionActivations.get(LOCAL);
      expect(owner).toBeDefined();
      await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      expect(state.contextGraphSubscriptionDormancyById.get(other.id)).toBe('authorityDenied');
      expect(state.contextGraphSubscriptionActivations.get(LOCAL)).toBe(owner);
      release.resolve(); await promotion;
      expect(f.agent.isContextGraphSubscriptionCommitted(LOCAL)).toBe(true);
      expect(events).toEqual([LOCAL]);
      expect(state.contextGraphSubscriptionRehydrationPendingIds.has(LOCAL)).toBe(false);
    } finally { release.resolve(); caller.abort(); await promotion.catch(() => undefined); state.started = false; }
  });

  it('retains activation ownership when a capped subscription is promoted into unavailable authority', async () => {
    const f = await fixture(false), state = f.agent as any;
    const caller = new AbortController(), signal = caller.signal;
    const runtime = new CoalescingRecurringTask({ retryIntervalMs: 30_000, runPass: async () => 'idle',
      onError: error => { throw error; }, closingMessage: 'test closed' });
    vi.spyOn(runtime, 'owns').mockImplementation(candidate => candidate === signal);
    state.contextGraphSubscriptionRehydrationPromotionRuntime = runtime;
    state.contextGraphSubscriptionAuthorityRecoveryRuntime = runtime;
    state.contextGraphSubscriptionRehydrationStatus.rehydrationEnabled = true;
    state.contextGraphSubscriptionRehydrationStatus.activationCap = 1;
    state.contextGraphSubscriptionRehydrationPendingIds.add(LOCAL);
    state.contextGraphSubscriptionActivations.reset([f.original]);
    state.transitionContextGraphSubscriptionDormancy(LOCAL, 'activationCap');
    state.started = true;
    vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockResolvedValue({
      outcome: 'unavailable', source: 'registered-chain', reason: 'temporary-authority-outage', metadataBootstrap: 'eligible',
    });
    try {
      await f.agent.promoteDormantContextGraphSubscriptions(signal);
      expect(state.contextGraphSubscriptionDormancyById.get(LOCAL)).toBe('authorityUnavailable');
      const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, signal)
        .then(() => 'activated', (error: Error) => error);
      expect(state.workLifetime.physicalRuns.size).toBe(1);
      vi.mocked(f.agent.resolveContextGraphSubscriptionBootstrapAuthority).mockResolvedValue({
        outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'eligible', onChainId: 582n,
      });
      await f.agent.retryUnavailableContextGraphSubscriptionAuthorities(signal);
      expect(await outcome).toBe('activated');
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { caller.abort(); state.started = false; }
  });

  it('settles an authority wait after an explicit persisted unsubscribe', async () => {
    const f = await fixture(false), state = f.agent as any;
    state.started = true;
    state.setContextGraphSubscription(LOCAL, { ...state.subscribedContextGraphs.get(LOCAL), subscribed: true }, { persist: false });
    state.contextGraphSubscriptionDormancyById.set(LOCAL, 'authorityUnavailable');
    state.contextGraphSubscriptionActivations.observe(f.original);
    const caller = new AbortController();
    const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, caller.signal)
      .then(() => 'inactive', (error: Error) => error);
    try {
      f.agent.unsubscribeFromContextGraph(LOCAL);
      await f.drain();
      expect(state.workLifetime.physicalRuns.size).toBe(0);
      expect(await outcome).toBe('inactive');
      expect(state.subscribedContextGraphs.get(LOCAL)?.subscribed).toBe(false);
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { caller.abort(); state.started = false; }
  });

  it.each([false, true])('fences pending snapshot activation after real clear, recreated=%s', async recreate => {
    const f = await fixture(false);
    const state = f.agent as any;
    state.started = true;
    state.contextGraphSubscriptionDormancyById.set(LOCAL, 'authorityUnavailable');
    state.contextGraphSubscriptionActivations.observe(f.original);
    const send = vi.fn(async () => { throw new Error('unexpected core read'); });
    state.router = { send };
    const insert = vi.spyOn(f.agent.store, 'insert');
    vi.useFakeTimers();
    const pending = f.agent.syncPublicGraphSnapshot({ contextGraphId: LOCAL, onChainId: '582',
      mode: 'core-cache', trustedCorePeerIds: ['core'] });
    const outcome = pending.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.agent.clearContextGraphSubscriptions()).toBe(1);
      expect(state.subscribedContextGraphs.has(LOCAL)).toBe(false);
      if (recreate) state.setContextGraphSubscription(LOCAL, {
        subscribed: true, syncMode: 'always-on', onChainId: '582', onChainHash: HASH,
      }, { persist: false });
      await vi.advanceTimersByTimeAsync(2500);
      expect(await outcome).toMatchObject({ message: 'Snapshot job ownership changed' });
      expect(send).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(f.rows.has(LOCAL)).toBe(false);
      expect(state.subscribedContextGraphs.has(LOCAL)).toBe(recreate);
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { state.started = false; vi.useRealTimers(); }
  });

  it('keeps the activation wait alive across a transaction rollback of the same saved intent', async () => {
    const f = await fixture(false);
    const state = f.agent as any;
    state.started = true;
    state.contextGraphSubscriptionDormancyById.set(LOCAL, 'authorityUnavailable');
    state.contextGraphSubscriptionActivations.observe(f.original);
    vi.useFakeTimers();
    let settled = false;
    const outcome = state.waitForContextGraphSubscriptionActivation(LOCAL, new AbortController().signal)
      .then(() => { settled = true; }, (error: Error) => { settled = true; return error; });
    try {
      await expect(state.activatePersistedContextGraphSubscriptionRecord(f.original, {
        prepare: async () => { throw new Error('authority temporarily unavailable'); },
      })).rejects.toThrow('authority temporarily unavailable');
      await vi.advanceTimersByTimeAsync(2500);
      expect(settled).toBe(false);
      await f.agent.clearContextGraphSubscriptions();
      await vi.advanceTimersByTimeAsync(2500);
      expect(await outcome).toMatchObject({ message: 'Subscription activation ownership changed' });
      expect(state.workLifetime.physicalRuns.size).toBe(0);
    } finally { state.started = false; vi.useRealTimers(); }
  });

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
