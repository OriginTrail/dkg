import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GossipSubManager,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphAppTopic,
  contextGraphFinalizationTopic,
  contextGraphPublishTopic,
  contextGraphSharedMemoryTopic,
  contextGraphUpdateTopic,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';

/**
 * Same-instance restart contract: `stop()` then `start()` on one `DKGAgent`.
 *
 * `start()` builds a brand-new `GossipSubManager` on a brand-new libp2p node
 * (`DKGNode.start()` creates a fresh libp2p every time), so every piece of
 * bookkeeping that mirrors "topic X is subscribed on the manager" is
 * session-scoped. The subscribe helpers short-circuit on that bookkeeping, so
 * a stale copy makes a restarted node silently deaf. Subscription INTENT
 * (`subscribedContextGraphs`), sync scope and disconnect history are durable
 * and must survive.
 */

const CG = 'restart-gossip-cg';
const OTHER_CG = 'restart-gossip-other-cg';

type SubscriptionRow = Record<string, unknown> & { id: string };

interface RestartInternals {
  gossip: GossipSubManager;
  gossipRegistered: Set<string>;
  sharedMemoryGossipRegistered: Set<string>;
  swmHostModeSubscribed: Map<string, unknown>;
  swmHostModeCurated: Map<string, boolean>;
  swmHostModeHandlers: Map<string, unknown>;
  lastSyncDisconnectedAt: Map<string, number>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; syncMode?: string; pendingMeta?: boolean }>;
  config: { syncContextGraphs?: string[] };
  contextGraphSubscriptionDormancyById: Map<string, string>;
  contextGraphSubscriptionRehydrationAccountedIds: Set<string>;
  wireSwmHostModeHandler(contextGraphId: string, source?: string, curated?: boolean): void;
  gossipWireIdFor(contextGraphId: string): string;
  rehydrateContextGraphsFromDurableState(): Promise<void>;
  updateContextGraphSubscriptionRehydrationStatusAfterPersist(
    contextGraphId: string,
    next?: { subscribed: boolean; coreHosted?: boolean },
  ): void;
}

function memberTopics(contextGraphId: string): string[] {
  return [
    contextGraphPublishTopic(contextGraphId),
    contextGraphAppTopic(contextGraphId),
    contextGraphUpdateTopic(contextGraphId),
    contextGraphFinalizationTopic(contextGraphId),
  ];
}

/** The fake subscription store shape the daemon's SQLite store satisfies. */
function createSubscriptionStore() {
  const persisted = new Map<string, SubscriptionRow>();
  return {
    persisted,
    store: {
      loadAll: async () => [...persisted.values()],
      save: async (record: SubscriptionRow) => {
        persisted.set(record.id, { ...record });
      },
      delete: async (contextGraphId: string) => {
        persisted.delete(contextGraphId);
      },
    },
  };
}

/**
 * Order the next `start()`: its rehydration pass ends, then `contextGraphId`
 * is accounted the way the completion of a subscription save accounts it, then
 * the rest of `start()` runs. The accounting is delivered directly, so the
 * order holds whether or not `stop()` waits for the saves still in flight.
 */
function accountSaveAfterRehydration(internals: RestartInternals, contextGraphId: string): void {
  const rehydrate = internals.rehydrateContextGraphsFromDurableState.bind(internals);
  vi.spyOn(internals, 'rehydrateContextGraphsFromDurableState').mockImplementation(async () => {
    await rehydrate();
    internals.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, { subscribed: true });
  });
}

async function createEdgeAgent(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ agent: DKGAgent; internals: RestartInternals }> {
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: new MockChainAdapter(),
    nodeRole: 'edge',
    ...extra,
  });
  return { agent, internals: agent as unknown as RestartInternals };
}

async function createLocalContextGraph(agent: DKGAgent, id = CG): Promise<void> {
  await agent.createContextGraph({
    id,
    name: `Restart gossip graph ${id}`,
    description: 'Same-instance restart regression graph',
  });
}

describe('DKGAgent same-instance restart re-subscribes gossip', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('re-subscribes a subscribed context graph and the system graphs on the fresh manager, on every restart', async () => {
    const boot = await createEdgeAgent('RestartGossipTopics');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    await createLocalContextGraph(agent);
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);

    const expectedTopics = [
      ...memberTopics(CG),
      contextGraphSharedMemoryTopic(internals.gossipWireIdFor(CG)),
      ...memberTopics(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      ...memberTopics(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    ];
    for (const topic of expectedTopics) expect(internals.gossip.subscribedTopics).toContain(topic);

    let previousManager = internals.gossip;
    for (let restart = 1; restart <= 2; restart += 1) {
      await agent.stop();
      await agent.start();

      // The restart really did build a new manager on a new libp2p node.
      expect(internals.gossip).not.toBe(previousManager);
      previousManager = internals.gossip;
      await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
      for (const topic of expectedTopics) expect(internals.gossip.subscribedTopics).toContain(topic);
    }
  }, 60_000);

  it('installs the topic handlers on the new manager, not only the libp2p subscriptions', async () => {
    const boot = await createEdgeAgent('RestartGossipHandlers');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    await createLocalContextGraph(agent);
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
    const firstManager = internals.gossip;
    await agent.stop();

    const subscribe = vi.spyOn(GossipSubManager.prototype, 'subscribe');
    const onMessage = vi.spyOn(GossipSubManager.prototype, 'onMessage');
    await agent.start();
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);

    const restartedManager = internals.gossip;
    expect(restartedManager).not.toBe(firstManager);
    const onNew = (spy: { mock: { calls: unknown[][]; contexts: unknown[] } }): string[] => spy.mock.calls
      .filter((_call, index) => spy.mock.contexts[index] === restartedManager)
      .map(([topic]) => String(topic));
    const wanted = [...memberTopics(CG), contextGraphSharedMemoryTopic(internals.gossipWireIdFor(CG))];
    const subscribedOnNew = onNew(subscribe);
    const handledOnNew = onNew(onMessage);
    for (const topic of wanted) expect(subscribedOnNew).toContain(topic);
    // The app topic carries no handler; the other three, and the SWM topic, do.
    for (const topic of wanted.filter((candidate) => candidate !== contextGraphAppTopic(CG))) {
      expect(handledOnNew).toContain(topic);
    }
    // Nothing was ever wired on the retired manager after the restart.
    expect(subscribe.mock.contexts.filter((context) => context === firstManager)).toHaveLength(0);
    expect(onMessage.mock.contexts.filter((context) => context === firstManager)).toHaveLength(0);
  }, 60_000);

  it('clears the manager-bound bookkeeping when the session stops', async () => {
    const boot = await createEdgeAgent('RestartGossipReset');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    await createLocalContextGraph(agent);
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
    expect(internals.gossipRegistered.has(CG)).toBe(true);
    expect(internals.gossipRegistered.has(SYSTEM_CONTEXT_GRAPHS.AGENTS)).toBe(true);
    const hostCg = internals.gossipWireIdFor(OTHER_CG);
    internals.wireSwmHostModeHandler(hostCg, 'manual', true);
    expect(internals.swmHostModeHandlers.has(hostCg)).toBe(true);
    expect(internals.swmHostModeSubscribed.has(hostCg)).toBe(true);
    expect(internals.swmHostModeCurated.has(hostCg)).toBe(true);

    await agent.stop();

    expect(internals.gossipRegistered.size).toBe(0);
    expect(internals.sharedMemoryGossipRegistered.size).toBe(0);
    expect(internals.swmHostModeSubscribed.size).toBe(0);
    expect(internals.swmHostModeCurated.size).toBe(0);
    expect(internals.swmHostModeHandlers.size).toBe(0);
  }, 60_000);

  it('lets a host-mode handler be wired again on the fresh manager', async () => {
    const boot = await createEdgeAgent('RestartGossipHostMode');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    const hostCg = internals.gossipWireIdFor(OTHER_CG);
    const hostTopic = contextGraphSharedMemoryTopic(hostCg);
    internals.wireSwmHostModeHandler(hostCg, 'manual', true);
    expect(internals.gossip.subscribedTopics).toContain(hostTopic);

    await agent.stop();
    await agent.start();
    expect(internals.gossip.subscribedTopics).not.toContain(hostTopic);

    // The persisted-marker restore loop and the host reconciler both come
    // through here; a stale handler map would make this an idempotent no-op.
    internals.wireSwmHostModeHandler(hostCg, 'reconciler', true);
    expect(internals.gossip.subscribedTopics).toContain(hostTopic);
    expect(internals.swmHostModeHandlers.has(hostCg)).toBe(true);
  }, 60_000);

  it('keeps durable state across a restart: subscription intent, sync scope and disconnect history', async () => {
    const boot = await createEdgeAgent('RestartGossipDurable');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    await createLocalContextGraph(agent);
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
    const peer = '12D3KooWRestartDurableHistoryPeer';
    internals.lastSyncDisconnectedAt.set(peer, 1_234_567);
    expect(internals.subscribedContextGraphs.get(CG)?.subscribed).toBe(true);
    expect(internals.config.syncContextGraphs).toContain(CG);

    await agent.stop();
    // Durable across the stopped window ...
    expect(internals.lastSyncDisconnectedAt.get(peer)).toBe(1_234_567);
    expect(internals.subscribedContextGraphs.get(CG)?.subscribed).toBe(true);
    expect(internals.config.syncContextGraphs).toContain(CG);

    await agent.start();
    // ... and across the restarted session.
    expect(internals.lastSyncDisconnectedAt.get(peer)).toBe(1_234_567);
    expect(internals.subscribedContextGraphs.get(CG)?.subscribed).toBe(true);
    expect(internals.config.syncContextGraphs).toContain(CG);
  }, 60_000);

  it('re-arms an on-demand (process-local) subscription with its sync mode and without persisting it', async () => {
    const durable = createSubscriptionStore();
    const boot = await createEdgeAgent('RestartGossipOnDemand', {
      contextGraphSubscriptionStore: durable.store,
    });
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    agent.subscribeToContextGraph(OTHER_CG, { syncMode: 'on-demand' });
    expect(internals.gossipRegistered.has(OTHER_CG)).toBe(true);
    expect(internals.subscribedContextGraphs.get(OTHER_CG)?.syncMode).toBe('on-demand');
    // An on-demand subscription is process-local: no durable row backs it.
    expect(durable.persisted.has(OTHER_CG)).toBe(false);

    await agent.stop();
    await agent.start();

    for (const topic of memberTopics(OTHER_CG)) expect(internals.gossip.subscribedTopics).toContain(topic);
    expect(internals.subscribedContextGraphs.get(OTHER_CG)).toMatchObject({
      subscribed: true,
      syncMode: 'on-demand',
    });
    // Re-arming re-wires; it never writes a durable row.
    expect(durable.persisted.has(OTHER_CG)).toBe(false);
  }, 60_000);

  it('does not resurrect a subscription that was left before the restart', async () => {
    const boot = await createEdgeAgent('RestartGossipLeft');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    await createLocalContextGraph(agent);
    await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
    agent.unsubscribeFromContextGraph(CG);
    expect(internals.subscribedContextGraphs.get(CG)?.subscribed).toBe(false);

    await agent.stop();
    await agent.start();

    expect(internals.gossipRegistered.has(CG)).toBe(false);
    for (const topic of memberTopics(CG)) expect(internals.gossip.subscribedTopics).not.toContain(topic);
    expect(internals.subscribedContextGraphs.get(CG)?.subscribed).toBe(false);
  }, 60_000);

  it('leaves a restricted pending-metadata bootstrap without live gossip', async () => {
    const boot = await createEdgeAgent('RestartGossipPendingMeta');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    internals.subscribedContextGraphs.set(OTHER_CG, {
      subscribed: true,
      synced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    } as never);

    await agent.stop();
    await agent.start();

    expect(internals.gossipRegistered.has(OTHER_CG)).toBe(false);
    for (const topic of memberTopics(OTHER_CG)) expect(internals.gossip.subscribedTopics).not.toContain(topic);
  }, 60_000);

  it('does not let one failing re-arm stop the restart or the other subscriptions', async () => {
    const boot = await createEdgeAgent('RestartGossipRearmFailure');
    agent = boot.agent;
    const { internals } = boot;
    await agent.start();
    agent.subscribeToContextGraph(CG, { persist: false });
    agent.subscribeToContextGraph(OTHER_CG, { persist: false });
    await agent.stop();

    const subscribe = agent.subscribeToContextGraph.bind(agent);
    vi.spyOn(agent, 'subscribeToContextGraph').mockImplementation((id, options) => {
      if (id === CG) throw new Error('boom');
      return subscribe(id, options);
    });
    await agent.start();

    expect(internals.gossipRegistered.has(CG)).toBe(false);
    expect(internals.gossipRegistered.has(OTHER_CG)).toBe(true);
    for (const topic of memberTopics(OTHER_CG)) expect(internals.gossip.subscribedTopics).toContain(topic);
  }, 60_000);

  describe('with a durable subscription store', () => {
    it('replays a persisted subscription through rehydration onto the fresh manager', async () => {
      const durable = createSubscriptionStore();
      const boot = await createEdgeAgent('RestartGossipRehydrate', {
        contextGraphSubscriptionStore: durable.store,
      });
      agent = boot.agent;
      const { internals } = boot;
      await agent.start();
      await createLocalContextGraph(agent);
      await expect.poll(() => durable.persisted.get(CG)?.subscribed).toBe(true);
      await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);

      await agent.stop();
      // stop() forgets the wiring, never the durable row.
      expect(durable.persisted.get(CG)?.subscribed).toBe(true);
      await agent.start();

      await expect.poll(() => internals.sharedMemoryGossipRegistered.has(CG)).toBe(true);
      for (const topic of memberTopics(CG)) expect(internals.gossip.subscribedTopics).toContain(topic);
      expect(durable.persisted.get(CG)?.subscribed).toBe(true);
    }, 60_000);

    it('keeps a row dormant that the rehydration kill-switch inventories, even though it was live before', async () => {
      const durable = createSubscriptionStore();
      const boot = await createEdgeAgent('RestartGossipKillSwitch', {
        contextGraphSubscriptionStore: durable.store,
        contextGraphSubscriptionRehydrationEnabled: false,
      });
      agent = boot.agent;
      const { internals } = boot;
      await agent.start();
      // An explicit subscribe is a normal live activation even with rehydration off.
      await createLocalContextGraph(agent);
      await expect.poll(() => durable.persisted.get(CG)?.subscribed).toBe(true);
      expect(internals.gossipRegistered.has(CG)).toBe(true);

      await agent.stop();
      await agent.start();

      // A fresh process would leave this row dormant; so does a restart.
      expect(internals.contextGraphSubscriptionDormancyById.get(CG)).toBe('rehydrationDisabled');
      expect(internals.gossipRegistered.has(CG)).toBe(false);
      for (const topic of memberTopics(CG)) expect(internals.gossip.subscribedTopics).not.toContain(topic);
      expect(durable.persisted.get(CG)?.subscribed).toBe(true);
    }, 60_000);

    it('re-arms a subscription whose save from the retired session lands after the restart rehydrated', async () => {
      const durable = createSubscriptionStore();
      const boot = await createEdgeAgent('RestartGossipLateSave', {
        contextGraphSubscriptionStore: durable.store,
      });
      agent = boot.agent;
      const { internals } = boot;
      await agent.start();
      // Live on the first manager, with no durable row behind it.
      agent.subscribeToContextGraph(CG, { persist: false });
      expect(internals.gossipRegistered.has(CG)).toBe(true);

      await agent.stop();
      expect(durable.persisted.has(CG)).toBe(false);
      accountSaveAfterRehydration(internals, CG);
      await agent.start();

      // Accounted only after the pass had read a store without the row, so no
      // rehydration replayed the graph: the live intent is all that re-arms it.
      expect(internals.contextGraphSubscriptionRehydrationAccountedIds.has(CG)).toBe(true);
      expect(internals.gossipRegistered.has(CG)).toBe(true);
      for (const topic of memberTopics(CG)) expect(internals.gossip.subscribedTopics).toContain(topic);
    }, 60_000);

    it('keeps a row the restart left dormant when a save from the retired session lands after it rehydrated', async () => {
      const durable = createSubscriptionStore();
      const boot = await createEdgeAgent('RestartGossipLateSaveDormant', {
        contextGraphSubscriptionStore: durable.store,
        contextGraphSubscriptionRehydrationEnabled: false,
      });
      agent = boot.agent;
      const { internals } = boot;
      await agent.start();
      agent.subscribeToContextGraph(CG);
      await expect.poll(() => durable.persisted.get(CG)?.subscribed).toBe(true);

      await agent.stop();
      accountSaveAfterRehydration(internals, CG);
      await agent.start();

      // Accounting the row again cleared the dormancy the pass had recorded for
      // it, and the kill-switch decision about the row still stands.
      expect(internals.contextGraphSubscriptionDormancyById.has(CG)).toBe(false);
      expect(internals.gossipRegistered.has(CG)).toBe(false);
      for (const topic of memberTopics(CG)) expect(internals.gossip.subscribedTopics).not.toContain(topic);
    }, 60_000);
  });
});
