import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphAppTopic,
  contextGraphFinalizationTopic,
  contextGraphPublishTopic,
  contextGraphUpdateTopic,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../src/dkg-agent-constants.js';
import { activatePersistedContextGraphSubscription } from
  '../src/context-graph-subscription-authority-recovery.js';

const mockLivePolicy = (agent: DKGAgent, accessPolicy: 0 | 1) =>
  vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
    kind: 'available',
    accessPolicy,
  });

class ActivationTestGossip {
  readonly subscribed = new Set<string>();

  subscribe(topic: string): void {
    this.subscribed.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
  }

  onMessage(): void {}

  async publish(): Promise<void> {}

  getSubscribers(): string[] {
    return [];
  }
}

describe('Context Graph subscription authority retry', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('compensates partial network activation and permits a clean later retry', async () => {
    const contextGraphId = 'persisted-partial-network-activation';
    const row = {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    const subscriptions = new Map<string, any>();
    const syncScope = new Set<string>();
    const gossipHandlers = new Set<string>();
    let failSubscribe = true;
    const ports = {
      install: () => {
        const subscription = { ...row, syncMode: 'always-on' as const };
        subscriptions.set(contextGraphId, subscription);
        return subscription;
      },
      current: (id: string) => subscriptions.get(id),
      remove: (id: string) => { subscriptions.delete(id); },
      rollbackNetworkEffects: (id: string) => {
        syncScope.delete(id);
        gossipHandlers.delete(id);
      },
      trackSync: (id: string) => { syncScope.add(id); },
      subscribe: (id: string) => {
        // Model the real activation replacing the installed record, then a
        // topic installed before a later topic subscription throws.
        subscriptions.set(id, { ...subscriptions.get(id), subscribed: true });
        gossipHandlers.add(id);
        if (failSubscribe) throw new Error('gossip topic install failed');
      },
      persistMembership: () => undefined,
    };

    await expect(activatePersistedContextGraphSubscription(row, ports))
      .rejects.toThrow('gossip topic install failed');
    expect([...subscriptions]).toEqual([]);
    expect([...syncScope]).toEqual([]);
    expect([...gossipHandlers]).toEqual([]);

    failSubscribe = false;
    await expect(activatePersistedContextGraphSubscription(row, ports))
      .resolves.toMatchObject({ id: contextGraphId, subscribed: true });
    expect(subscriptions.get(contextGraphId)).toMatchObject({ subscribed: true });
    expect([...syncScope]).toEqual([contextGraphId]);
    expect([...gossipHandlers]).toEqual([contextGraphId]);
  });

  it('rolls back real agent sync and gossip effects after post-subscribe failure', async () => {
    const contextGraphId = 'persisted-agent-network-rollback';
    const row = {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    agent = await DKGAgent.create({
      name: 'PrivateReadPersistedAgentNetworkRollback',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
    });
    const gossip = new ActivationTestGossip();
    (agent as unknown as { gossip: ActivationTestGossip }).gossip = gossip;
    const topics = [
      contextGraphPublishTopic(contextGraphId),
      contextGraphAppTopic(contextGraphId),
      contextGraphUpdateTopic(contextGraphId),
      contextGraphFinalizationTopic(contextGraphId),
    ];
    let failAfterSubscribe = true;
    vi.spyOn(agent, 'persistLocalNodeMembership').mockImplementation(() => {
      if (failAfterSubscribe) {
        failAfterSubscribe = false;
        throw new Error('membership projection failed after gossip installation');
      }
    });

    await expect(agent.activatePersistedContextGraphSubscriptionRecord(row))
      .rejects.toThrow('membership projection failed after gossip installation');
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getSyncContextGraphIds()).not.toContain(contextGraphId);
    expect(topics.every((topic) => !gossip.subscribed.has(topic))).toBe(true);
    expect((agent as unknown as { gossipRegistered: Set<string> })
      .gossipRegistered.has(contextGraphId)).toBe(false);

    await expect(agent.activatePersistedContextGraphSubscriptionRecord(row))
      .resolves.toMatchObject({ subscribed: true });
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      syncMode: 'always-on',
    });
    expect(agent.getSyncContextGraphIds()).toContain(contextGraphId);
    expect(topics.every((topic) => gossip.subscribed.has(topic))).toBe(true);
    expect((agent as unknown as { gossipRegistered: Set<string> })
      .gossipRegistered.has(contextGraphId)).toBe(true);
  });

  it('retries a cold persisted binding after startup and restores the subscription', async () => {
    const contextGraphId = 'persisted-cold-binding-retry';
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]]);
    const loadAll = vi.fn(async () => [...rows.values()]);
    const load = vi.fn(async (id: string) => rows.get(id) ?? null);
    let attempt = 0;
    let completeColdRetry!: (value: bigint | null) => void;
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation((_nameHash, options) => {
        // Other startup policy probes may use the same adapter method without
        // the bounded registration resolver's signal. They are not the cold
        // binding attempts this fixture controls.
        if (!options?.signal) return Promise.resolve(null);
        attempt += 1;
        if (attempt > 1) {
          return new Promise<bigint | null>((resolve) => { completeColdRetry = resolve; });
        }
        // Keep startup deterministic: the first lookup is unavailable without
        // spending the full bootstrap scan deadline. The second lookup remains
        // open long enough to prove the background retry owns that deadline.
        return Promise.reject(new Error('temporary name-hash lookup outage'));
      });
    agent = await DKGAgent.create({
      name: 'PrivateReadColdBindingBackgroundRetry',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll,
        load,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    mockLivePolicy(agent, 0);
    const retry = vi.spyOn(agent, 'retryUnavailableContextGraphSubscriptionAuthorities');

    await agent.start();
    await vi.waitFor(() => expect(attempt).toBe(2));
    const retrySignal = [...resolveByNameHash.mock.calls]
      .reverse()
      .find(([, options]) => options?.signal)?.[1]?.signal;
    expect(retrySignal?.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAIN_POLICY_READ_TIMEOUT_MS + 1);
    });
    expect(retrySignal?.aborted).toBe(false);
    completeColdRetry(7n);
    await vi.waitFor(
      () => expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(true),
      // Recovery now remains intentionally hidden until RFC-64 responsibility
      // and the healed chain binding are both durable. Under the integration
      // shard's concurrent node load that boundary can exceed the old 2s UI-
      // style polling window even though the authority retry itself completed.
      { timeout: 20_000 },
    );

    expect(retry).toHaveBeenCalledOnce();
    expect(loadAll).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, contextGraphId);
    expect(load).toHaveBeenNthCalledWith(2, contextGraphId);
    expect(resolveByNameHash.mock.calls.find(([, options]) => options?.signal)?.[1]?.signal?.aborted)
      .toBe(false);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(rows.get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(rows.get(contextGraphId)?.onChainHash).toBeUndefined();
    expect(agent.readRfc64CatalogRuntimeSelectionV1()).toMatchObject({
      eligibleContextGraphs: [contextGraphId],
      selectedContextGraphs: [contextGraphId],
    });
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantIds: [],
      dormantReasons: {
        authorityUnavailable: [],
      },
    });
  }, (2 * CHAIN_POLICY_READ_TIMEOUT_MS) + 24_000);

  it('retries unavailable subscription authority again at the exact recurring boundary', async () => {
    const contextGraphId = 'persisted-recurring-authority-retry';
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]]);
    agent = await DKGAgent.create({
      name: 'PrivateReadRecurringAuthorityRetry',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let authorityAvailable = false;
    const resolveAuthority = vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
      .mockImplementation(async (candidateId) => {
      if (candidateId === contextGraphId && !authorityAvailable) {
        return {
          outcome: 'unavailable',
          source: 'registered-chain',
          reason: 'temporary-authority-outage',
          metadataBootstrap: 'eligible',
        } as const;
      }
      return {
        outcome: 'allowed',
        source: 'registered-chain',
        reason: 'open-context-graph',
        metadataBootstrap: 'eligible',
        onChainId: 7n,
      } as const;
    });
    const targetAttempts = () => resolveAuthority.mock.calls
      .filter(([candidateId]) => candidateId === contextGraphId).length;
    const retry = vi.spyOn(agent, 'retryUnavailableContextGraphSubscriptionAuthorities');
    vi.useFakeTimers();

    await agent.start();
    expect(targetAttempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(targetAttempts()).toBe(2);
    expect(retry).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(targetAttempts()).toBe(2);
    expect(retry).toHaveBeenCalledOnce();
    authorityAvailable = true;
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledTimes(2);

    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantReasons: { authorityUnavailable: [] },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('retires recurring recovery when unavailable authority becomes denied', async () => {
    const contextGraphId = 'persisted-authority-retry-denied';
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]]);
    agent = await DKGAgent.create({
      name: 'PrivateReadAuthorityRetryDenied',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let attempts = 0;
    const resolveAuthority = vi.spyOn(
      agent,
      'resolveContextGraphSubscriptionBootstrapAuthority',
    ).mockImplementation(async (candidateId) => {
      if (candidateId !== contextGraphId) {
        return {
          outcome: 'unavailable',
          source: 'registered-chain',
          reason: 'unrelated-startup-probe',
          metadataBootstrap: 'eligible',
        } as const;
      }
      attempts += 1;
      return attempts === 1
        ? {
            outcome: 'unavailable',
            source: 'registered-chain',
            reason: 'temporary-authority-outage',
            metadataBootstrap: 'eligible',
          } as const
        : {
            outcome: 'denied',
            source: 'registered-chain',
            reason: 'caller-not-participant',
            metadataBootstrap: 'forbidden',
          } as const;
    });
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership');
    vi.useFakeTimers();

    await agent.start();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(subscribe.mock.calls.some(([id]) => id === contextGraphId)).toBe(false);
    expect(persistMembership.mock.calls.some(([id]) => id === contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [],
        authorityDenied: [contextGraphId],
      },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    expect(resolveAuthority.mock.calls.filter(([id]) => id === contextGraphId)).toHaveLength(2);
  });

  it('does not resurrect a different subscription deleted during authority retry', async () => {
    const coldContextGraphId = 'persisted-cold-target';
    const liveContextGraphId = 'persisted-live-deleted';
    const rows = new Map<string, any>([
      [coldContextGraphId, {
        id: coldContextGraphId,
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        syncScoped: true,
      }],
      [liveContextGraphId, {
        id: liveContextGraphId,
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        syncScoped: true,
      }],
    ]);
    agent = await DKGAgent.create({
      name: 'PrivateReadScopedAuthorityRetryDeleteRace',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let coldAttempts = 0;
    let releaseRetry!: () => void;
    let enteredRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryStarted = new Promise<void>((resolve) => { enteredRetry = resolve; });
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
      .mockImplementation(async (contextGraphId) => {
        if (contextGraphId === liveContextGraphId) {
          return {
            outcome: 'allowed',
            source: 'registered-chain',
            reason: 'open-context-graph',
            metadataBootstrap: 'not-needed',
          } as const;
        }
        coldAttempts += 1;
        if (coldAttempts === 1) {
          return {
            outcome: 'unavailable',
            source: 'registered-chain',
            reason: 'temporary-authority-outage',
            metadataBootstrap: 'eligible',
          } as const;
        }
        enteredRetry();
        await retryGate;
        return {
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'open-context-graph',
          metadataBootstrap: 'not-needed',
        } as const;
      });

    await agent.start();
    await retryStarted;
    agent.unsubscribeFromContextGraph(liveContextGraphId);
    await vi.waitFor(() => expect(rows.has(liveContextGraphId)).toBe(false));
    releaseRetry();

    await vi.waitFor(() => {
      expect(agent!.getSubscribedContextGraphs().has(coldContextGraphId)).toBe(true);
    });
    expect(agent.getSubscribedContextGraphs().get(liveContextGraphId)).toMatchObject({
      subscribed: false,
    });
    expect(rows.has(liveContextGraphId)).toBe(false);
  }, 15_000);

  it('keeps the recovered row dormant when binding persistence fails', async () => {
    const contextGraphId = 'persisted-cold-binding-save-failure';
    const row = {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    agent = await DKGAgent.create({
      name: 'PrivateReadScopedAuthorityRetrySaveFailure',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [row],
        save: async () => { throw new Error('binding store unavailable'); },
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let attempts = 0;
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockImplementation(async () => {
      attempts += 1;
      return attempts === 1
        ? {
          outcome: 'unavailable',
          source: 'registered-chain',
          reason: 'temporary-authority-outage',
          metadataBootstrap: 'eligible',
        } as const
        : {
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'open-context-graph',
          metadataBootstrap: 'eligible',
          onChainId: 7n,
        } as const;
    });

    await agent.start();
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(agent!.getSubscribedContextGraphs().has(contextGraphId))
      .toBe(false));

    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [contextGraphId],
      },
    });
    expect(agent.readRfc64CatalogRuntimeSelectionV1()).toMatchObject({
      eligibleContextGraphs: [],
      selectedContextGraphs: [],
    });
  }, 15_000);

  it('drains a cancelled authority retry without activating after its save settles', async () => {
    const contextGraphId = 'persisted-cold-binding-stop-during-save';
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]]);
    let releaseSave!: () => void;
    let enteredSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const saveStarted = new Promise<void>((resolve) => { enteredSave = resolve; });
    agent = await DKGAgent.create({
      name: 'PrivateReadAuthorityRetryShutdownFence',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => {
          if (row.id === contextGraphId && row.onChainId === '7') {
            enteredSave();
            await saveGate;
          }
          rows.set(row.id, row);
        },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let attempts = 0;
    let retrySignal: AbortSignal | undefined;
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
      .mockImplementation(async (_candidateId, options) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            outcome: 'unavailable',
            source: 'registered-chain',
            reason: 'temporary-authority-outage',
            metadataBootstrap: 'eligible',
          } as const;
        }
        retrySignal = options?.signal;
        return {
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'open-context-graph',
          metadataBootstrap: 'eligible',
          onChainId: 7n,
        } as const;
      });
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership');

    await agent.start();
    await saveStarted;
    const stopping = agent.stop();
    let stopSettled = false;
    const observedStop = stopping.then(() => { stopSettled = true; });
    await vi.waitFor(() => expect(retrySignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    releaseSave();
    await observedStop;

    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(subscribe.mock.calls.some(([id]) => id === contextGraphId)).toBe(false);
    expect(persistMembership.mock.calls.some(([id]) => id === contextGraphId)).toBe(false);
  }, 15_000);

  it('does not activate the authority-retry target after it is deleted', async () => {
    const contextGraphId = 'persisted-cold-deleted-during-retry';
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]]);
    agent = await DKGAgent.create({
      name: 'PrivateReadScopedAuthorityRetryTargetDeleteRace',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let attempts = 0;
    let releaseRetry!: () => void;
    let enteredRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryStarted = new Promise<void>((resolve) => { enteredRetry = resolve; });
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          outcome: 'unavailable',
          source: 'registered-chain',
          reason: 'temporary-authority-outage',
          metadataBootstrap: 'eligible',
        } as const;
      }
      enteredRetry();
      await retryGate;
      return {
        outcome: 'allowed',
        source: 'registered-chain',
        reason: 'open-context-graph',
        metadataBootstrap: 'not-needed',
      } as const;
    });

    await agent.start();
    await retryStarted;
    rows.delete(contextGraphId);
    releaseRetry();

    await vi.waitFor(() => expect(
      agent!.getContextGraphSubscriptionRehydrationStatus(),
    ).toMatchObject({
      activated: 0,
      persistedTotal: 0,
      dormant: 0,
      dormantIds: [],
    }));
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
  }, 15_000);

  it('preserves the active row when recovered authority reaches the activation cap', async () => {
    const coldContextGraphId = 'persisted-cold-cap-target';
    const liveContextGraphId = 'persisted-live-cap-owner';
    const rows = [coldContextGraphId, liveContextGraphId].map((id) => ({
      id,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }));
    agent = await DKGAgent.create({
      name: 'PrivateReadScopedAuthorityRetryCap',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => rows,
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      maxRehydratedContextGraphSubscriptions: 1,
    });
    let coldAttempts = 0;
    let releaseRetry!: () => void;
    let enteredRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryStarted = new Promise<void>((resolve) => { enteredRetry = resolve; });
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
      .mockImplementation(async (contextGraphId) => {
        if (contextGraphId === liveContextGraphId) {
          return {
            outcome: 'allowed',
            source: 'registered-chain',
            reason: 'open-context-graph',
            metadataBootstrap: 'not-needed',
          } as const;
        }
        coldAttempts += 1;
        if (coldAttempts === 1) {
          return {
            outcome: 'unavailable',
            source: 'registered-chain',
            reason: 'temporary-authority-outage',
            metadataBootstrap: 'eligible',
          } as const;
        }
        enteredRetry();
        await retryGate;
        return {
          outcome: 'allowed',
          source: 'registered-chain',
          reason: 'open-context-graph',
          metadataBootstrap: 'not-needed',
        } as const;
      });

    await agent.start();
    await retryStarted;
    expect(agent.getSubscribedContextGraphs().has(liveContextGraphId)).toBe(true);
    releaseRetry();

    await vi.waitFor(() => expect(
      agent!.getContextGraphSubscriptionRehydrationStatus(),
    ).toMatchObject({
      activated: 1,
      dormantReasons: {
        activationCap: [coldContextGraphId],
        authorityUnavailable: [],
      },
    }));
    expect(agent.getSubscribedContextGraphs().has(liveContextGraphId)).toBe(true);
    expect(agent.getSubscribedContextGraphs().has(coldContextGraphId)).toBe(false);
  }, 15_000);
});
