import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../src/dkg-agent-constants.js';

const mockLivePolicy = (agent: DKGAgent, accessPolicy: 0 | 1) =>
  vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
    kind: 'available',
    accessPolicy,
  });

describe('Context Graph subscription authority retry', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
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
        attempt += 1;
        if (attempt > 1) {
          return new Promise<bigint | null>((resolve) => { completeColdRetry = resolve; });
        }
        return new Promise<bigint | null>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve(null);
            return;
          }
          signal?.addEventListener('abort', () => resolve(null), { once: true });
        });
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
    await vi.waitFor(() => expect(resolveByNameHash).toHaveBeenCalledTimes(2));
    const retrySignal = resolveByNameHash.mock.calls[1]?.[1]?.signal;
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
      { timeout: 10_000 },
    );

    expect(retry).toHaveBeenCalledOnce();
    expect(loadAll).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, contextGraphId);
    expect(load).toHaveBeenNthCalledWith(2, contextGraphId);
    expect(resolveByNameHash.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
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
  }, (2 * CHAIN_POLICY_READ_TIMEOUT_MS) + 14_000);

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
    const resolveAuthority = vi.spyOn(agent, 'resolveContextGraphReadAuthority')
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
    vi.spyOn(agent, 'resolveContextGraphReadAuthority')
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
    vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async () => {
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
    vi.spyOn(agent, 'resolveContextGraphReadAuthority')
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
    vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async () => {
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
    vi.spyOn(agent, 'resolveContextGraphReadAuthority')
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
