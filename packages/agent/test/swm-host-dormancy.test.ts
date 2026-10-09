import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { contextGraphWorkspaceTopic, contextGraphMetaGraphUri, contextGraphDataUri, DKG_ONTOLOGY, SUBSCRIPTION_SOURCES } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { SwmHostModeStore } from '../src/swm/host-mode-store.js';
import { encodeCgDiscoveryBeacon, mintCgDiscoveryBeacon } from '../src/swm/cg-discovery-beacon.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const LOCAL = 'zz-swm-host-dormancy';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
type Handler = (topic: string, data: Uint8Array, from: string) => void | Promise<void>;
class Gossip {
  readonly topics = new Set<string>();
  readonly handlers = new Map<string, Handler[]>();
  subscribe(topic: string) { this.topics.add(topic); }
  unsubscribe(topic: string) { this.topics.delete(topic); this.handlers.delete(topic); }
  onMessage(topic: string, handler: Handler) { this.handlers.set(topic, [...(this.handlers.get(topic) ?? []), handler]); }
  offMessage(topic: string, handler: Handler) { this.handlers.set(topic, (this.handlers.get(topic) ?? []).filter(value => value !== handler)); }
  async deliver(topic: string, data: Uint8Array) {
    if (this.topics.has(topic)) for (const handler of this.handlers.get(topic) ?? []) await handler(topic, data, 'owned-dormancy-probe');
  }
  async publish() {}
  getSubscribers() { return []; }
}
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  contextGraphSubscriptionDormancyById: Map<string, unknown>;
  wireIdToLocalCgId: Map<string, string>;
  onChainAccessPolicyCache: Map<string, number>;
  swmHostModeStore: SwmHostModeStore;
  swmHostModeHandlers: Map<string, Handler>;
  swmHostModeSubscribed: Map<string, string>;
  setContextGraphSubscription(id: string, row: ContextGraphSubInput, opts: { persist: false; deferWireAdoption?: boolean }): ContextGraphSub;
}
const agents: DKGAgent[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) { await agent.stop(); await agent.store.close(); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(options: { capped?: boolean; host?: boolean; marker?: boolean; nativeStart?: boolean; skipPlan?: boolean; private?: boolean; sameHashSecond?: boolean; secondPublic?: boolean; wire?: boolean; markerOnly?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-swm-host-dormancy-')); directories.push(directory);
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
  await chain.createOnChainContextGraph({ accessPolicy: options.private ? 1 : 0, publishPolicy: 1, nameHash: HASH });
  const blocker = '00-swm-cap-blocker';
  const blockerHash = options.sameHashSecond ? HASH : ethers.keccak256(ethers.toUtf8Bytes(blocker));
  await chain.createOnChainContextGraph({ accessPolicy: options.sameHashSecond && !options.secondPublic ? 1 : 0, publishPolicy: 1, nameHash: blockerHash });
  const target: ContextGraphSubscriptionRecord = { id: options.wire ? HASH : LOCAL, subscribed: !options.host, coreHosted: options.host ?? false,
    synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true, onChainId: SLOT, onChainHash: HASH };
  let rows = options.capped ? [{ ...target, id: blocker, onChainId: '583', onChainHash: blockerHash }, target] : [target];
  if (options.markerOnly) rows = [];
  if (options.marker) {
    const store = new SwmHostModeStore({ dataDir: join(directory, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init(); await store.markHostModeSubscribed(LOCAL);
  }
  const agent = await DKGAgent.create({ name: 'SwmDormancy', dataDir: directory, nodeRole: 'core',
    listenHost: '127.0.0.1', listenPort: 0, chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false }, swmHostMode: { enabled: true, stripCiphertext: false },
    syncReconcilerEnabled: false, vmReconcilerEnabled: false,
    contextGraphSubscriptionRehydrationEnabled: options.capped ?? false, maxRehydratedContextGraphSubscriptions: options.capped ? 1 : undefined,
    contextGraphSubscriptionStore: { loadAll: async () => rows.map(row => ({ ...row })),
      load: async id => { const row = rows.find(value => value.id === id); return row ? { ...row } : null; },
      save: async row => { rows = [...rows.filter(value => value.id !== row.id), { ...row }]; },
      delete: async id => { rows = rows.filter(value => value.id !== id); } },
  });
  agents.push(agent);
  const state = agent as unknown as Internals;
  const gossip = new Gossip();
  if (!options.nativeStart) {
    (agent as unknown as { node: unknown }).node = { peerId: '12D3KooWSwmDormancy', libp2p: { getPeers: () => [] } };
    (agent as unknown as { gossip: Gossip }).gossip = gossip;
    await agent.initializeSwmHostModeStore();
    if (!options.skipPlan) await agent.rehydrateContextGraphSubscriptions(null);
  }
  await new GraphManager(agent.store).ensureContextGraph(LOCAL);
  const assertAbsent = async () => {
    expect(state.swmHostModeHandlers.has(HASH)).toBe(false);
    expect(state.swmHostModeSubscribed.has(HASH)).toBe(false);
    expect(gossip.handlers.get(contextGraphWorkspaceTopic(HASH)) ?? []).toEqual([]);
    await agent.awaitHostModePersistence(LOCAL);
    if (!options.marker) expect(await state.swmHostModeStore.listHostModeSubscribedCgs()).not.toContain(LOCAL);
  };
  const assertDispatch = async (rawId: string = LOCAL) => {
    const topic = contextGraphWorkspaceTopic(HASH); const handler = state.swmHostModeHandlers.get(HASH);
    expect(handler).toBeDefined(); expect(gossip.handlers.get(topic)).toContain(handler);
    const ingest = vi.spyOn(agent, 'ingestSwmHostModeEnvelope');
    const bytes = new Uint8Array([1]);
    await gossip.deliver(topic, bytes);
    expect(ingest).toHaveBeenCalledExactlyOnceWith(rawId, bytes, 'owned-dormancy-probe');
    await ingest.mock.results[0].value; ingest.mockRestore();
  };
  return { agent, state, gossip, chain, assertAbsent, assertDispatch };
}
async function privateMetadata(agent: DKGAgent) {
  await agent.store.insert([{ subject: contextGraphDataUri(LOCAL), predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    object: '"private"', graph: contextGraphMetaGraphUri(LOCAL) }]);
  expect(await agent.isPrivateContextGraph(LOCAL)).toBe(true);
}

describe('automatic SWM host admission honors durable dormancy', () => {
  it.each([false, true])('refuses disabled public identity in direct and periodic paths, saved Core=%s', async host => {
    const f = await fixture({ host });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ subscribed: false, coreHosted: false, onChainId: SLOT });
    expect(f.state.contextGraphSubscriptionDormancyById.has(LOCAL)).toBe(true);
    await f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await f.agent.reconcileHostModeSubscriptions();
    await f.assertAbsent();
  });
  it('refuses capped public identity in direct and periodic paths', async () => {
    const f = await fixture({ capped: true });
    expect(f.state.contextGraphSubscriptionDormancyById.has(LOCAL)).toBe(true);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.subscribed).toBe(false);
    await f.agent.reconcileSwmHostModeSubscription(LOCAL); await f.agent.reconcileHostModeSubscriptions();
    await f.assertAbsent();
  });
  it.each([false, true])('actual startup restores only after disabled/capped dormancy is recorded, capped=%s', async capped => {
    const f = await fixture({ capped, marker: true, nativeStart: true });
    const order: string[] = [];
    const init = f.agent.initializeSwmHostModeStore.bind(f.agent);
    const rehydrate = f.agent.rehydrateContextGraphsFromDurableState.bind(f.agent);
    const restore = f.agent.restoreSwmHostModeSubscriptions.bind(f.agent);
    vi.spyOn(f.agent, 'initializeSwmHostModeStore').mockImplementation(async () => { await init(); order.push('store'); expect(f.state.swmHostModeHandlers.size).toBe(0); });
    vi.spyOn(f.agent, 'rehydrateContextGraphsFromDurableState').mockImplementation(async () => { await rehydrate(); order.push('durable'); });
    vi.spyOn(f.agent, 'restoreSwmHostModeSubscriptions').mockImplementation(async () => { await restore(); order.push('restore'); });
    await f.agent.start();
    expect(order).toEqual(['store', 'durable', 'restore']);
    expect(f.state.contextGraphSubscriptionDormancyById.has(LOCAL)).toBe(true);
    expect(f.state.swmHostModeHandlers.has(HASH)).toBe(false);
    expect(await f.state.swmHostModeStore.listHostModeSubscribedCgs()).toContain(LOCAL);
  }, 15000);
  it('actual startup restores an eligible marker-only listener after durable rehydration', async () => {
    const f = await fixture({ private: true, marker: true, markerOnly: true, nativeStart: true });
    await privateMetadata(f.agent);
    expect(await f.agent.isCuratedForHostMode(LOCAL)).toBe(true);
    const order: string[] = [];
    const init = f.agent.initializeSwmHostModeStore.bind(f.agent);
    const rehydrate = f.agent.rehydrateContextGraphsFromDurableState.bind(f.agent);
    const restore = f.agent.restoreSwmHostModeSubscriptions.bind(f.agent);
    vi.spyOn(f.agent, 'initializeSwmHostModeStore').mockImplementation(async () => { await init(); order.push('store'); expect(f.state.swmHostModeHandlers.size).toBe(0); });
    vi.spyOn(f.agent, 'rehydrateContextGraphsFromDurableState').mockImplementation(async () => { await rehydrate(); order.push('durable'); expect(f.state.swmHostModeHandlers.size).toBe(0); });
    vi.spyOn(f.agent, 'restoreSwmHostModeSubscriptions').mockImplementation(async () => {
      expect(f.state.swmHostModeHandlers.size).toBe(0);
      await restore(); order.push('restore');
      expect(f.state.swmHostModeHandlers.has(HASH)).toBe(true);
    });
    vi.spyOn(f.agent, 'reconcileSwmHostModeSubscription').mockResolvedValue(undefined);
    vi.spyOn(f.agent, 'reconcileHostModeSubscriptions').mockResolvedValue(undefined);
    await f.agent.start();
    expect(order).toEqual(['store', 'durable', 'restore']);
    const topic = contextGraphWorkspaceTopic(HASH);
    const gossip = (f.agent as unknown as { gossip: { subscribedTopics: string[]; topicHandlers: Map<string, Set<Handler>> } }).gossip;
    const handler = f.state.swmHostModeHandlers.get(HASH);
    expect(handler).toBeDefined();
    expect(gossip.subscribedTopics).toContain(topic);
    expect(gossip.topicHandlers.get(topic)).toContain(handler);
    expect(f.state.swmHostModeSubscribed.get(HASH)).toBe(SUBSCRIPTION_SOURCES.RECONCILER);
    expect(await f.state.swmHostModeStore.listHostModeSubscribedCgs()).toContain(LOCAL);
  }, 15000);
  it('does not recreate a dormant listener through the direct automatic wire choke point', async () => {
    const f = await fixture();
    f.agent.wireSwmHostModeHandler(LOCAL, SUBSCRIPTION_SOURCES.RECONCILER, true);
    await f.assertAbsent();
  });
  it('retires its own automatic listener on dormant reentry', async () => {
    const f = await fixture({ skipPlan: true });
    f.agent.wireSwmHostModeHandler(LOCAL, SUBSCRIPTION_SOURCES.RECONCILER, true);
    await f.assertDispatch();
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await f.assertAbsent();
  });
  it('preserves explicit MANUAL provenance and dispatch during automatic dormant refusal', async () => {
    const f = await fixture();
    await expect(f.agent.enableSwmHostModeFor(LOCAL)).resolves.toMatchObject({ subscribed: true });
    expect(f.state.swmHostModeSubscribed.get(HASH)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    await f.agent.reconcileSwmHostModeSubscription(LOCAL);
    expect(f.state.swmHostModeSubscribed.get(HASH)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    await f.assertDispatch();
  });
  it('keeps the actual admitted different-slot wire owner listener when exact LOCAL is dormant', async () => {
    const f = await fixture({ sameHashSecond: true });
    f.state.setContextGraphSubscription(HASH, { subscribed: false, coreHosted: true, synced: false,
      onChainId: '583', onChainHash: HASH }, { persist: false });
    f.state.onChainAccessPolicyCache.set('583', await f.chain.getContextGraphAccessPolicy(583n));
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    await f.agent.reconcileSwmHostModeSubscription(HASH);
    expect(f.state.swmHostModeSubscribed.get(HASH)).toBe(SUBSCRIPTION_SOURCES.RECONCILER);
    await f.assertDispatch(HASH);
    await f.agent.reconcileSwmHostModeSubscription(LOCAL);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    await f.assertDispatch(HASH);
  });
  it('keeps genuine admitted numeric private hosting', async () => {
    const f = await fixture({ private: true });
    f.state.setContextGraphSubscription(LOCAL, { ...f.state.subscribedContextGraphs.get(LOCAL)!, coreHosted: true }, { persist: false });
    f.state.onChainAccessPolicyCache.set(SLOT, await f.chain.getContextGraphAccessPolicy(582n));
    await f.agent.reconcileSwmHostModeSubscription(LOCAL); await f.assertDispatch();
    await f.agent.awaitHostModePersistence(LOCAL);
    expect(await f.state.swmHostModeStore.listHostModeSubscribedCgs()).toContain(LOCAL);
  });
  it('hosts a genuine signature-verified pre-registration curated beacon', async () => {
    const f = await fixture();
    const signer = ethers.Wallet.createRandom(); const wire = ethers.keccak256(ethers.toUtf8Bytes('fresh-curated-beacon'));
    const beacon = await mintCgDiscoveryBeacon({ nameHash: wire, accessPolicy: 1, curatorEoa: signer.address, sign: digest => signer.signMessage(digest) });
    await f.agent.handleIncomingCgDiscoveryBeacon(encodeCgDiscoveryBeacon(beacon), 'owned-beacon-peer');
    expect(f.state.swmHostModeHandlers.has(wire)).toBe(true);
    await f.agent.awaitHostModePersistence(wire);
    expect(await f.state.swmHostModeStore.listHostModeSubscribedCgs()).toContain(wire);
  });
  it('does not let a genuine curated beacon override an authoritative public numeric policy', async () => {
    const f = await fixture(); const signer = ethers.Wallet.createRandom();
    f.state.setContextGraphSubscription(LOCAL, { ...f.state.subscribedContextGraphs.get(LOCAL)!, coreHosted: true }, { persist: false });
    f.state.onChainAccessPolicyCache.set(SLOT, await f.chain.getContextGraphAccessPolicy(582n));
    const beacon = await mintCgDiscoveryBeacon({ nameHash: HASH, accessPolicy: 1, curatorEoa: signer.address, sign: digest => signer.signMessage(digest) });
    await f.agent.handleIncomingCgDiscoveryBeacon(encodeCgDiscoveryBeacon(beacon), 'owned-beacon-peer');
    await f.assertAbsent();
  });
  it.each(['marker-write', 'existing-registration', 'restore-registration'] as const)('retires automatic custody after dormancy appears during native %s', async window => {
    const f = await fixture({ skipPlan: true, marker: window === 'restore-registration' });
    await privateMetadata(f.agent);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    if (window === 'marker-write') {
      const original = f.state.swmHostModeStore.markHostModeSubscribed.bind(f.state.swmHostModeStore);
      vi.spyOn(f.state.swmHostModeStore, 'markHostModeSubscribed').mockImplementationOnce(async id => { entered(); await held; await original(id); });
    } else {
      const original = f.agent.maybeMarkRegisteredForHostMode.bind(f.agent);
      vi.spyOn(f.agent, 'maybeMarkRegisteredForHostMode').mockImplementationOnce(async id => { entered(); await held; await original(id); });
      if (window === 'existing-registration') f.agent.wireSwmHostModeHandler(LOCAL, SUBSCRIPTION_SOURCES.RECONCILER, true);
    }
    const operation = window === 'restore-registration'
      ? f.agent.restoreSwmHostModeSubscriptions() : f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await started; await f.agent.rehydrateContextGraphSubscriptions(null);
    release(); await operation; await f.assertAbsent();
  });
  it('does not probe a replacement session after an old existing-handler classification returns false', async () => {
    const f = await fixture({ skipPlan: true });
    await f.agent.enableSwmHostModeFor(LOCAL);
    (f.agent as unknown as { config: { swmHostMode: { stripCiphertext: boolean } } }).config.swmHostMode.stripCiphertext = true;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.agent.isPrivateContextGraph.bind(f.agent);
    vi.spyOn(f.agent, 'isPrivateContextGraph').mockImplementationOnce(async id => { const result = await original(id); expect(result).toBe(false); entered(); await held; return result; });
    const probe = vi.spyOn(f.agent, 'maybeMarkRegisteredForHostMode');
    const reconciling = f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await started;
    const replacement = new Gossip();
    (f.agent as unknown as { gossip: Gossip }).gossip = replacement;
    f.agent.wireSwmHostModeHandler(LOCAL, SUBSCRIPTION_SOURCES.MANUAL, false);
    const handler = f.state.swmHostModeHandlers.get(HASH);
    expect(handler).toBeDefined();
    probe.mockClear(); release(); await reconciling;
    expect(probe).not.toHaveBeenCalled();
    expect(f.state.swmHostModeHandlers.get(HASH)).toBe(handler);
    expect(f.state.swmHostModeSubscribed.get(HASH)).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    const ingest = vi.spyOn(f.agent, 'ingestSwmHostModeEnvelope'); const bytes = new Uint8Array([1]);
    await replacement.deliver(contextGraphWorkspaceTopic(HASH), bytes);
    expect(ingest).toHaveBeenCalledExactlyOnceWith(LOCAL, bytes, 'owned-dormancy-probe');
    await ingest.mock.results[0].value;
  });
  it('rechecks numeric policy after the caller awaits an immediate private-policy result', async () => {
    const f = await fixture({ private: true, sameHashSecond: true, secondPublic: true });
    f.state.setContextGraphSubscription(LOCAL, { ...f.state.subscribedContextGraphs.get(LOCAL)!, coreHosted: true }, { persist: false });
    f.state.onChainAccessPolicyCache.set(SLOT, await f.chain.getContextGraphAccessPolicy(582n));
    const publicPolicy = await f.chain.getContextGraphAccessPolicy(583n);
    const reconciling = f.agent.reconcileSwmHostModeSubscription(LOCAL);
    f.agent.bindSubscriptionOnChainId(LOCAL, f.state.subscribedContextGraphs.get(LOCAL)!, '583');
    f.state.onChainAccessPolicyCache.set('583', publicPolicy);
    await reconciling; await f.assertAbsent();
  });
  it('refuses an absent case-variant wire request for the normalized dormant wire row', async () => {
    const f = await fixture({ wire: true });
    const variant = HASH.toUpperCase().replace('0X', '0x');
    expect(f.state.contextGraphSubscriptionDormancyById.has(HASH)).toBe(true);
    expect(f.state.subscribedContextGraphs.has(variant)).toBe(false);
    f.agent.wireSwmHostModeHandler(variant, SUBSCRIPTION_SOURCES.RECONCILER, true);
    await f.assertAbsent();
  });
  it('keeps an exact hash-shaped cleartext identity distinct from the normalized dormant wire row', async () => {
    const f = await fixture({ wire: true });
    const literal = HASH.toUpperCase().replace('0X', '0x');
    const commitment = ethers.keccak256(ethers.toUtf8Bytes(literal));
    const registration = await f.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1, nameHash: commitment });
    f.state.setContextGraphSubscription(literal, { subscribed: false, coreHosted: true, synced: false,
      onChainId: String(registration.contextGraphId), onChainHash: commitment }, { persist: false });
    f.state.onChainAccessPolicyCache.set(String(registration.contextGraphId), await f.chain.getContextGraphAccessPolicy(registration.contextGraphId));
    await f.agent.reconcileSwmHostModeSubscription(literal);
    expect(f.state.swmHostModeHandlers.has(commitment)).toBe(true);
    expect(f.state.swmHostModeHandlers.has(HASH)).toBe(false);
    await f.agent.awaitHostModePersistence(literal);
  });
  it('rechecks dormancy after the actual private metadata probe yields', async () => {
    const f = await fixture({ skipPlan: true }); await privateMetadata(f.agent);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.agent.isPrivateContextGraph.bind(f.agent);
    vi.spyOn(f.agent, 'isPrivateContextGraph').mockImplementation(async id => { const result = await original(id); entered(); await held; return result; });
    const reconciling = f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await started; await f.agent.rehydrateContextGraphSubscriptions(null); release(); await reconciling;
    await f.assertAbsent();
  });
  it('rechecks authoritative public numeric policy after a private metadata probe yields', async () => {
    const f = await fixture({ skipPlan: true }); await privateMetadata(f.agent);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.agent.isPrivateContextGraph.bind(f.agent);
    vi.spyOn(f.agent, 'isPrivateContextGraph').mockImplementation(async id => { const result = await original(id); entered(); await held; return result; });
    const reconciling = f.agent.reconcileSwmHostModeSubscription(LOCAL);
    await started;
    f.state.setContextGraphSubscription(LOCAL, { subscribed: false, coreHosted: true, synced: false, onChainId: SLOT, onChainHash: HASH }, { persist: false });
    f.state.onChainAccessPolicyCache.set(SLOT, await f.chain.getContextGraphAccessPolicy(582n));
    release(); await reconciling; await f.assertAbsent();
  });
});
