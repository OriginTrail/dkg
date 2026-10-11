import { createHostModeTestFixture, installGossipStub, type StripInternals } from './swm/host-mode.fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { SwmHostModeStore, type SwmHostModeSubscriptionBinding } from '../src/swm/host-mode-store.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import { ethers } from 'ethers';

interface RestorationOwner {
  swmHostModeStore?: SwmHostModeStore;
  restoreSwmHostModeSubscriptions(): Promise<void>;
  swmHostModeRestoration?: import('../src/internal/host-mode-restoration.js').HostModeRestoration;
  swmHostModeSubscribed: ReadonlyMap<string, unknown>;
  wireSwmHostModeHandler(id: string): boolean;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  reconcileCursors: Map<string, unknown>;
  canonicalSwmHostModeKey(id: string): string;
  contextGraphBindingState: { capture(id: string): number };
  restorePersistedHostModeSubscription(entry: SwmHostModeSubscriptionBinding, strip: boolean): Promise<void>;
  restorePersistedHostModeBinding(id: string, chainId: string): boolean;
  bindSubscriptionOnChainId(id: string, row: ContextGraphSub, chainId: string): void;
  setContextGraphSubscription(id: string, row: ContextGraphSub, options?: { persist?: boolean }): ContextGraphSub;
  awaitHostModePersistence(id: string): Promise<void>;
  enqueueHostModePersistence(id: string, subscribed: boolean): void;
  sharedMemoryGossipRegistered: Set<string>;
  isMemberModeRegisteredForCg(id: string): boolean;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('host-mode restoration physical ownership', () => {
  const agents: DKGAgent[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const agent of agents.splice(0)) { await agent.stop(); await agent.store.close(); }
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });
  async function create(options: { stripCiphertext?: boolean; hostPublic?: boolean } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-host-restore-owner-'));
    directories.push(dataDir);
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({ name: 'host-restore-owner', dataDir, listenHost: '127.0.0.1',
      store: new OxigraphStore(), chainAdapter: chain, nodeRole: 'core', rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 1, ...options } });
    agents.push(agent);
    const markers = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await markers.init();
    return { agent, chain, markers, dataDir, owner: agent as unknown as RestorationOwner };
  }

  for (const heldIndex of [0, 1]) it(`started stop drains held ${heldIndex === 0 ? 'startup prefix' : 'background tail'} and restart resets its fence`, async () => {
    const { agent, markers, owner } = await create();
    await markers.markHostModeSubscribed('restore-first');
    await markers.markHostModeSubscribed('restore-second');
    const entered = deferred(), release = deferred();
    const original = owner.restorePersistedHostModeSubscription.bind(agent);
    let calls = 0;
    const completed: string[] = [];
    const observation = vi.spyOn(owner, 'restorePersistedHostModeSubscription').mockImplementation(async (entry, strip) => {
      if (calls++ === heldIndex) { entered.resolve(); await release.promise; }
      await original(entry, strip);
      completed.push(entry.contextGraphId);
    });
    const starting = agent.start();
    try {
      await entered.promise;
      if (heldIndex === 1) {
        await starting;
        const ready = owner.restoreSwmHostModeSubscriptions();
        expect(ready).toBe(owner.swmHostModeRestoration!.startupReady);
        expect(owner.restoreSwmHostModeSubscriptions()).toBe(ready);
        await ready;
      }
      let stopped = false;
      const stopping = agent.stop().then(() => { stopped = true; });
      await vi.waitFor(() => expect(owner.swmHostModeRestoration?.closed).toBe(true));
      expect(owner.swmHostModeRestoration!.close()).toBe(owner.swmHostModeRestoration!.drained);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      const wiredBeforeRelease = [...owner.swmHostModeSubscribed.keys()];
      release.resolve();
      await Promise.all([starting, stopping]);
      expect(stopped).toBe(true);
      expect([...owner.swmHostModeSubscribed.keys()]).toEqual([]);
      expect(completed).toHaveLength(heldIndex + 1);
      expect(wiredBeforeRelease).toHaveLength(heldIndex);
      observation.mockRestore();
      await agent.start();
      await owner.swmHostModeRestoration?.drained;
      expect(owner.swmHostModeRestoration?.closed).toBe(false);
      expect(owner.swmHostModeSubscribed.size).toBe(2);
    } finally { release.resolve(); await starting; }
  }, 60_000);

  for (const wireMarker of [false, true]) for (const strip of [false, true]) it(
    `deferred ${wireMarker ? 'wire' : 'cleartext'} marker cannot replace admitted member binding with strip=${strip}`,
    async () => {
      const { agent, markers, owner } = await create();
      const id = 'current-member-binding';
      const wireId = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
      const markerId = wireMarker ? wireId : id;
      await markers.markHostModeSubscribed('restore-prefix');
      await markers.markHostModeSubscribed(markerId, { onChainId: '10' });
      // Marker enumeration order is not specified; force the real disk-backed
      // member marker into the deferred tail rather than the startup prefix.
      const list = SwmHostModeStore.prototype.listHostModeSubscriptions;
      vi.spyOn(SwmHostModeStore.prototype, 'listHostModeSubscriptions').mockImplementation(async function () {
        return (await list.call(this)).sort((a, b) => Number(a.contextGraphId === markerId) - Number(b.contextGraphId === markerId));
      });
      const entered = deferred(), release = deferred();
      const original = owner.restorePersistedHostModeSubscription.bind(agent);
      vi.spyOn(owner, 'restorePersistedHostModeSubscription').mockImplementation(async (entry, _strip) => {
        if (entry.contextGraphId === markerId) { entered.resolve(); await release.promise; }
        await original(entry, strip);
      });
      const starting = agent.start();
      try {
        await entered.promise;
        await starting;
        // Admission/rehydration won the race, before its gossip handler is wired.
        const current = owner.setContextGraphSubscription(id, {
          subscribed: true, synced: true, syncMode: 'always-on', onChainHash: wireId,
          onChainId: '11', lastReconciledOrdinal: 9,
        }, { persist: false });
        const cursor = {};
        owner.reconcileCursors.set(id, cursor);
        const generation = owner.contextGraphBindingState.capture(id);
        release.resolve();
        await owner.swmHostModeRestoration?.drained;
        expect(owner.subscribedContextGraphs.get(id)).toBe(current);
        expect(current.onChainId).toBe('11');
        expect(current.lastReconciledOrdinal).toBe(9);
        expect(owner.reconcileCursors.get(id)).toBe(cursor);
        expect(owner.contextGraphBindingState.capture(id)).toBe(generation);
        expect(owner.swmHostModeSubscribed.has(owner.canonicalSwmHostModeKey(id))).toBe(false);
        // The independently callable cold-binding helper has the same custody rule.
        owner.restorePersistedHostModeBinding(markerId, '8');
        expect(owner.subscribedContextGraphs.get(id)).toBe(current);
        expect(current.onChainId).toBe('11');
        expect(owner.contextGraphBindingState.capture(id)).toBe(generation);
      } finally { release.resolve(); await starting; }
    }, 60_000,
  );

  for (const reverseMapped of [false, true]) it(`cold ${reverseMapped ? 'reverse-mapped wire' : 'cleartext'} marker restores its numeric public binding`, async () => {
    const { agent, chain, markers, owner } = await create({ stripCiphertext: true, hostPublic: true });
    const id = 'cold-public-binding';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const registration = await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: wireId });
    const numericId = String(registration.contextGraphId);
    if (reverseMapped) owner.setContextGraphSubscription(id, {
      subscribed: false, synced: false, syncMode: 'always-on', onChainHash: wireId,
    }, { persist: false });
    await markers.markHostModeSubscribed(reverseMapped ? wireId : id, { onChainId: numericId });
    const access = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    const publish = vi.spyOn(chain, 'getContextGraphPublishPolicy');
    await agent.start();
    await owner.swmHostModeRestoration?.drained;
    expect(owner.subscribedContextGraphs.get(id)?.onChainId).toBe(numericId);
    expect(owner.subscribedContextGraphs.has(wireId)).toBe(false);
    expect(access).toHaveBeenCalledWith(BigInt(numericId));
    expect(publish).toHaveBeenCalledWith(BigInt(numericId));
    expect(owner.swmHostModeSubscribed.has(owner.canonicalSwmHostModeKey(id))).toBe(true);
  }, 60_000);

  it('wire-only uppercase persistence retains the canonical numeric binding and member refusal', async () => {
    const { agent, owner } = await create();
    await agent.start();
    const wireId = ethers.keccak256(ethers.toUtf8Bytes('cold-wire-only')).toLowerCase();
    const uppercase = '0x' + wireId.slice(2).toUpperCase();
    owner.subscribedContextGraphs.set(wireId, { subscribed: false, synced: false,
      syncMode: 'always-on', onChainHash: wireId, onChainId: '42' });
    owner.enqueueHostModePersistence(uppercase, true);
    await owner.awaitHostModePersistence(uppercase);
    expect(await owner.swmHostModeStore!.listHostModeSubscriptions())
      .toContainEqual({ contextGraphId: wireId, onChainId: '42' });
    owner.sharedMemoryGossipRegistered.add(wireId);
    expect(owner.isMemberModeRegisteredForCg(uppercase)).toBe(true);
  }, 60_000);

  it('cold binding restores reset generation, watermark and cursor and persist later canonical rebindings', async () => {
    const { agent, owner, dataDir } = await create();
    await agent.start();
    const id = 'binding-refresh';
    owner.subscribedContextGraphs.set(id, { subscribed: false, synced: false, syncMode: 'always-on', onChainId: '10', lastReconciledOrdinal: 9 });
    owner.reconcileCursors.set(id, {});
    const generation = owner.contextGraphBindingState.capture(id);
    owner.restorePersistedHostModeBinding(id, '11');
    const restored = owner.subscribedContextGraphs.get(id)!;
    expect(restored).toMatchObject({ onChainId: '11', lastReconciledOrdinal: 0 });
    expect(owner.reconcileCursors.has(id)).toBe(false);
    expect(owner.contextGraphBindingState.capture(id)).toBeGreaterThan(generation);
    expect(owner.wireSwmHostModeHandler(id)).toBe(true);
    // Clone-based callers commit through the canonical setter.
    const next = { ...restored };
    owner.bindSubscriptionOnChainId(id, next, '12');
    owner.setContextGraphSubscription(id, next, { persist: false });
    await owner.awaitHostModePersistence(id);
    expect(await owner.swmHostModeStore!.listHostModeSubscriptions()).toContainEqual({ contextGraphId: id, onChainId: '12' });
    // In-place late binding has no setter; its owner must persist it too.
    owner.bindSubscriptionOnChainId(id, owner.subscribedContextGraphs.get(id)!, '13');
    await owner.awaitHostModePersistence(id);
    expect(await owner.swmHostModeStore!.listHostModeSubscriptions()).toContainEqual({ contextGraphId: id, onChainId: '13' });
    owner.setContextGraphSubscription(id, { ...owner.subscribedContextGraphs.get(id)!, onChainId: undefined }, { persist: false });
    await owner.awaitHostModePersistence(id);
    const reopened = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    expect(await reopened.listHostModeSubscriptions()).toContainEqual({ contextGraphId: id });
    await expect(reopened.listHostModeSubscriptions()).resolves.not.toContainEqual({ contextGraphId: id, onChainId: '13' });
  }, 60_000);
});

describe('persisted host-mode restoration compatibility', () => {
  const { makeCore } = createHostModeTestFixture();

  it('closing before restoration prevents a later direct call from admitting work', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    await g.swmHostModeStore!.markHostModeSubscribed('closed-before-restore');
    await core.stop();
    const ready = g.restoreSwmHostModeSubscriptions();
    expect(ready).toBe(g.swmHostModeRestoration!.startupReady);
    await ready;
    expect(g.swmHostModeRestoration!.closed).toBe(true);
    expect(g.swmHostModeSubscribed.size).toBe(0);
  });

  it('closing a held registration probe keeps the native registration marker unchanged', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const id = 'held-restoration-registration';
    const store = g.swmHostModeStore!;
    await store.markHostModeSubscribed(id);
    const entered = deferred(), release = deferred();
    vi.spyOn(core, 'isContextGraphRegisteredOnChain').mockImplementation(async () => {
      entered.resolve(); await release.promise; return true;
    });
    const mark = vi.spyOn(store, 'markRegistered');
    const restoring = g.restoreSwmHostModeSubscriptions();
    try {
      await entered.promise;
      let stopped = false;
      const stopping = core.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await Promise.all([restoring, stopping]);
      expect(mark).not.toHaveBeenCalled();
      expect(await store.isRegistered(id)).toBe(false);
    } finally { release.resolve(); await restoring; }
  });

  it('listing failure settles both boundaries without restoring any marker', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    vi.spyOn(g.swmHostModeStore!, 'listHostModeSubscriptions').mockRejectedValue(new Error('marker directory unavailable'));
    const ready = g.restoreSwmHostModeSubscriptions();
    await ready;
    await g.swmHostModeRestoration!.drained;
    expect(g.swmHostModeSubscribed.size).toBe(0);
  });

  it('cold restart restores a hash-only public host from its persisted chain binding', async () => {
    const wireId = ethers.keccak256(ethers.toUtf8Bytes('cg-public-cold-host')).toLowerCase();
    const onChainId = '42';
    const first = await makeCore(true, { hostPublic: true, chain: null });
    const dataDir = (first as unknown as StripInternals).config.dataDir;
    const firstInternals = first as unknown as StripInternals;
    const firstStore = firstInternals.swmHostModeStore!;
    (firstInternals as any).scheduleRfc64CatalogResponsibilityReconciliationV1 = () => {};
    expect(firstInternals.stageOnChainContextGraphBindingFromNameHash(wireId, onChainId))
      .toBe(wireId);
    firstInternals.enqueueHostModePersistence(wireId, true);
    await firstInternals.awaitHostModePersistence(wireId);
    expect(await firstStore.listHostModeSubscriptions()).toEqual([{
      contextGraphId: wireId,
      onChainId,
    }]);
    await first.stop().catch(() => {});
    await first.store.close().catch(() => {});

    const chain = new MockChainAdapter();
    const getContextGraphAccessPolicy = vi.fn(async () => 0);
    const getContextGraphPublishPolicy = vi.fn(async () => ({
      publishPolicy: 1,
      publishAuthority: ethers.ZeroAddress,
    }));
    chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;
    chain.getContextGraphPublishPolicy = getContextGraphPublishPolicy;
    const restarted = await makeCore(true, { hostPublic: true, chain, dataDir });
    const restored = restarted as unknown as StripInternals;
    installGossipStub(restored);
    (restored as any).maybeMarkRegisteredForHostMode = async () => {};

    await restored.initializeSwmHostModeStore();
    await restored.restoreSwmHostModeSubscriptions();

    expect(restored.subscribedContextGraphs.get(wireId)?.onChainId).toBe(onChainId);
    expect(restored.swmHostModeSubscribed.has(wireId)).toBe(true);
    expect(restored.swmHostModeHandlers.has(wireId)).toBe(true);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(getContextGraphPublishPolicy).toHaveBeenCalledWith(42n);
  });

  it('restart restore contains a failing policy re-evaluation to keep startup alive', async () => {
    const core = await makeCore(true, { hostPublic: true, chain: null });
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const cgId = 'cg-public-restore-error';
    const store = g.swmHostModeStore!;
    await store.markHostModeSubscribed(cgId);
    await store.markHostModeSubscribed('zz-healthy-restoration');
    await expect(g.initializeSwmHostModeStore()).resolves.toBeUndefined();
    const listing = g.swmHostModeStore!.listHostModeSubscriptions.bind(g.swmHostModeStore);
    vi.spyOn(g.swmHostModeStore!, 'listHostModeSubscriptions').mockImplementation(async () =>
      (await listing()).sort((a, b) => Number(b.contextGraphId === cgId) - Number(a.contextGraphId === cgId)));
    const calls: string[] = [];
    vi.spyOn(core, 'isCuratedForHostMode').mockImplementation(async (id) => {
      calls.push(id);
      if (id === cgId) throw new Error('simulated policy probe failure');
      return false;
    });
    vi.spyOn(g, 'isConfirmedPublicForHostMode').mockResolvedValue(true);

    await expect(g.restoreSwmHostModeSubscriptions()).resolves.toBeUndefined();
    expect(calls).toEqual([cgId, 'zz-healthy-restoration']);
    expect(g.swmHostModeHandlers.size).toBe(1);
  });

  it('restart restore wires persisted subscriptions when private-ciphertext strip is OFF', async () => {
    const core = await makeCore(false, { chain: null });
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const cgId = 'cg-curated-restore';
    const store = g.swmHostModeStore!;
    await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
      return true;
    };

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(wired).toEqual([cgId]);
  });

  it('restart restore awaits at most reconcileBatchSize markers and drains the rest off startup', async () => {
    // Codex review #2614 — `initializeSwmHostModeStore` is awaited from
    // `start()`. Every persisted marker costs at least a store probe (and a
    // chain RPC pair on a `hostPublic` core), so the startup walk must be
    // capped the same way the periodic sweep is. Nothing may be dropped: the
    // tail still runs, just not on the boot path.
    const core = await makeCore(false, { reconcileBatchSize: 2, chain: null });
    const g = core as unknown as StripInternals;
    const store = g.swmHostModeStore!;
    installGossipStub(g);
    const cgIds = ['cg-b1', 'cg-b2', 'cg-b3', 'cg-b4', 'cg-b5'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => {
      wired.push(id);
      return true;
    };

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(wired).toHaveLength(2);
    expect(g.swmHostModeRestoration?.drained).toBeDefined();

    await g.swmHostModeRestoration?.drained;

    expect([...wired].sort()).toEqual([...cgIds].sort());
  });

  it('deferred restore drain skips a CG that became member-registered mid-drain', async () => {
    // Codex review #2614 follow-up — the batched restore above moved the tail
    // of the walk OFF the startup await, which broke the ordering the direct
    // (strip OFF) re-wire used to rely on: the whole walk finished inside the
    // awaited `initializeSwmHostModeStore`, i.e. before member-mode
    // rehydration could claim any CG. Now a marker past `reconcileBatchSize`
    // can be drained AFTER `reconcileSharedMemoryGossipSubscription` has
    // unwired the host handler and added the CG to
    // `sharedMemoryGossipRegistered` — re-wiring it there double-processes
    // every envelope (member apply + opaque host append). The refusal lives in
    // `wireSwmHostModeHandler` itself (review #2614), so this drives the REAL
    // wiring point instead of a stub of it.
    const core = await makeCore(false, { reconcileBatchSize: 2, chain: null });
    const g = core as unknown as StripInternals;
    const store = g.swmHostModeStore!;
    const cgIds = ['cg-race-1', 'cg-race-2', 'cg-race-3', 'cg-race-4', 'cg-race-5'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    installGossipStub(g);
    // Restore order is store-listing order, not the order they were marked.
    const restoreOrder = (await store.listHostModeSubscriptions()).map((e) => e.contextGraphId);
    expect([...restoreOrder].sort()).toEqual([...cgIds].sort());
    const firstDeferred = restoreOrder[2];
    const claimedByMember = restoreOrder[4];
    // `maybeMarkRegisteredForHostMode` runs right AFTER each marker is wired,
    // so it is the seam where member rehydration lands mid-drain: the first
    // deferred marker is done and the tail (including `claimedByMember`) has
    // not run yet.
    (g as any).maybeMarkRegisteredForHostMode = async (id: string) => {
      if (id === firstDeferred) g.sharedMemoryGossipRegistered.add(claimedByMember);
    };
    const hostKey = (id: string): string => (g as any).canonicalSwmHostModeKey(id) as string;

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect([...g.swmHostModeSubscribed.keys()]).toEqual(restoreOrder.slice(0, 2).map(hostKey));
    expect(g.swmHostModeRestoration?.drained).toBeDefined();

    await g.swmHostModeRestoration?.drained;

    expect(g.swmHostModeHandlers.has(hostKey(claimedByMember))).toBe(false);
    expect(g.swmHostModeSubscribed.has(hostKey(claimedByMember))).toBe(false);
    expect([...g.swmHostModeSubscribed.keys()]).toEqual(restoreOrder.slice(0, 4).map(hostKey));
  });

  it('deferred restore drain refuses a HASH-keyed marker whose cleartext id is member-registered', async () => {
    // Codex review #2614 — `sharedMemoryGossipRegistered` is keyed by the
    // member's CLEARTEXT id, while a host-only discovery path persists its
    // marker under the curator-committed wire HASH. A raw `has()` misses that
    // pairing entirely, so the drain would wire a host handler onto the very
    // topic the member handler already owns (apply + opaque append). The
    // membership probe must resolve the hash back through `wireIdToLocalCgId`.
    const core = await makeCore(false, { reconcileBatchSize: 1, chain: null });
    const g = core as unknown as StripInternals;
    const store = g.swmHostModeStore!;
    const cgId = 'cg-hash-keyed-member';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();
    // One inline marker keeps the hash marker in the DEFERRED tail.
    await store.markHostModeSubscribed('cg-hash-keyed-filler');
    await store.markHostModeSubscribed(wireId);
    installGossipStub(g);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};
    // The node is a MEMBER of the same CG, registered under the cleartext id.
    g.wireIdToLocalCgId.set(wireId, cgId);
    g.sharedMemoryGossipRegistered.add(cgId);

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();
    expect(g.swmHostModeRestoration?.drained).toBeDefined();
    await g.swmHostModeRestoration?.drained;

    expect(g.swmHostModeHandlers.has(wireId)).toBe(false);
    expect(g.swmHostModeSubscribed.has(wireId)).toBe(false);
    // The marker itself must SURVIVE: member mode can hand the CG back, and
    // the marker is what re-engages hosting then.
    expect((await store.listHostModeSubscriptions()).map((e) => e.contextGraphId))
      .toContain(wireId);
  });

  it('stop() fences the deferred restore drain — nothing is wired after teardown', async () => {
    // Codex review #2614 — the drain was a detached, unowned task: `stop()`
    // cleared the host-mode timers and joined every other background owner but
    // never this one, so the tail could still subscribe a gossip topic and
    // rewrite a marker while the node tore down.
    const core = await makeCore(false, { reconcileBatchSize: 1, chain: null });
    const g = core as unknown as StripInternals;
    const store = g.swmHostModeStore!;
    const cgIds = ['cg-stop-1', 'cg-stop-2', 'cg-stop-3', 'cg-stop-4'];
    for (const cgId of cgIds) await store.markHostModeSubscribed(cgId);
    installGossipStub(g);
    (g as any).maybeMarkRegisteredForHostMode = async () => {};

    await g.initializeSwmHostModeStore();
    await g.restoreSwmHostModeSubscriptions();

    expect(g.swmHostModeSubscribed.size).toBe(1);
    expect(g.swmHostModeRestoration?.drained).toBeDefined();

    await core.stop();
    await g.swmHostModeRestoration?.drained;

    // The drain aborted at its first fence check, before the unref'd tick's
    // first deferred marker could be wired.
    expect(g.swmHostModeSubscribed.size).toBe(1);
  });

  it('restart restore contains a failing legacy re-wire to keep startup alive', async () => {
    const core = await makeCore(false, { chain: null });
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const cgId = 'cg-curated-restore-error';
    const store = g.swmHostModeStore!;
    await store.markHostModeSubscribed(cgId);
    await store.markHostModeSubscribed('zz-healthy-restoration');
    await expect(g.initializeSwmHostModeStore()).resolves.toBeUndefined();
    const listing = g.swmHostModeStore!.listHostModeSubscriptions.bind(g.swmHostModeStore);
    vi.spyOn(g.swmHostModeStore!, 'listHostModeSubscriptions').mockImplementation(async () =>
      (await listing()).sort((a, b) => Number(b.contextGraphId === cgId) - Number(a.contextGraphId === cgId)));
    const calls: string[] = [];
    const wire = g.wireSwmHostModeHandler.bind(g);
    g.wireSwmHostModeHandler = (id, source, curated) => {
      calls.push(id);
      if (id === cgId) throw new Error('simulated re-wire failure');
      return wire(id, source, curated);
    };

    await expect(g.restoreSwmHostModeSubscriptions()).resolves.toBeUndefined();
    expect(calls).toEqual([cgId, 'zz-healthy-restoration']);
    expect(g.swmHostModeHandlers.size).toBe(1);
  });

  // ── 2. operator override hatch CLOSED (WS-A divergence from rung-1) ───────

});
