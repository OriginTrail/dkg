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
  swmHostModeRestoreDrain?: Promise<void>;
  swmHostModeRestoreDrainAborted: boolean;
  swmHostModeSubscribed: Map<string, unknown>;
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
    return { agent, chain, markers, owner: agent as unknown as RestorationOwner };
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
      if (heldIndex === 1) await starting;
      let stopped = false;
      const stopping = agent.stop().then(() => { stopped = true; });
      await vi.waitFor(() => expect(owner.swmHostModeRestoreDrainAborted).toBe(true));
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
      await owner.swmHostModeRestoreDrain;
      expect(owner.swmHostModeRestoreDrainAborted).toBe(false);
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
        await owner.swmHostModeRestoreDrain;
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
    await owner.swmHostModeRestoreDrain;
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
    const { agent, owner } = await create();
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
    owner.swmHostModeSubscribed.set(owner.canonicalSwmHostModeKey(id), 'reconciler');
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
  }, 60_000);
});
