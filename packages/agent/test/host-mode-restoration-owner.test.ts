import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { SwmHostModeStore, type SwmHostModeSubscriptionBinding } from '../src/swm/host-mode-store.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';

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
  restorePersistedHostModeBinding(id: string, chainId: string): void;
  bindSubscriptionOnChainId(id: string, row: ContextGraphSub, chainId: string): void;
  setContextGraphSubscription(id: string, row: ContextGraphSub, options?: { persist?: boolean }): ContextGraphSub;
  awaitHostModePersistence(id: string): Promise<void>;
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
  async function create() {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-host-restore-owner-'));
    directories.push(dataDir);
    const agent = await DKGAgent.create({ name: 'host-restore-owner', dataDir, listenHost: '127.0.0.1',
      store: new OxigraphStore(), chainAdapter: new MockChainAdapter(), nodeRole: 'core', rfc64CatalogActivation: { enabled: false },
      swmHostMode: { enabled: true, stripCiphertext: false, reconcileBatchSize: 1 } });
    agents.push(agent);
    const markers = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await markers.init();
    return { agent, markers, owner: agent as unknown as RestorationOwner };
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
