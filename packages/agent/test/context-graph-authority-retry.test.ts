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
import {
  activatePersistedContextGraphSubscription,
  recoverDeferredContextGraphSubscriptionAuthorities,
} from
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

  it('serializes authority reads while prioritizing every bound row and budgeting the cold tail', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      id: `deferred-${index}`,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      ...(index === 5 ? { onChainId: '7' } : {}),
    }));
    const loadAll = vi.fn(async () => rows.map((row) => ({ ...row })));
    const dormancyById = new Map(rows.map((row) => (
      [row.id, 'authorityUnavailable' as const]
    )));
    const status = {
      rehydrationEnabled: true,
      persistedTotal: rows.length,
      systemExcluded: 0,
      hostedActivated: 0,
      hostedActivatedIds: [],
      activated: 0,
      activationCap: 0,
      capDisabled: true,
      completedAt: 1,
      updatedAt: 1,
    };
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    const discoveryOrder: string[] = [];
    const activationOrder: string[] = [];
    const coldCursor = {};
    const resolveAuthority = vi.fn(async (row: { id: string }) => {
      discoveryOrder.push(row.id);
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      // Distinct Context Graphs cannot share a live-authority flight. Keep the
      // call open across a turn so this test detects any sibling overlap that
      // would compete inside the background RPC governor's attempt budget.
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeDiscoveries -= 1;
      return {
        outcome: 'allowed' as const,
        source: 'registered-chain' as const,
        reason: 'open-context-graph' as const,
        metadataBootstrap: 'eligible' as const,
      };
    });

    const recovery = recoverDeferredContextGraphSubscriptionAuthorities(
      new AbortController().signal,
      {
        store: {
          loadAll,
          save: async () => undefined,
          delete: async () => undefined,
        },
        dormancyById,
        persistRevisions: new Map(),
        subscriptions: new Map(),
        coldCursor,
        getStatus: () => status,
        isCurrent: () => true,
        touchStatus: () => undefined,
        clearStatus: vi.fn(),
        resolveAuthority,
        activate: async (row) => {
          activationOrder.push(row.id);
          await Promise.resolve();
        },
        warn: vi.fn(),
        activated: (contextGraphId) => {
          status.activated += 1;
          dormancyById.delete(contextGraphId);
        },
      },
    );
    await recovery;

    expect(resolveAuthority).toHaveBeenCalledTimes(2);
    expect(maxActiveDiscoveries).toBe(1);
    const boundFirstOrder = [rows[5]!.id, rows[0]!.id];
    expect(discoveryOrder).toEqual(boundFirstOrder);
    expect(activationOrder).toEqual(boundFirstOrder);
    expect(coldCursor).toEqual({ afterContextGraphId: rows[0]!.id });
    // One candidate snapshot plus one current-row recheck per attempted row.
    expect(loadAll).toHaveBeenCalledTimes(3);
  });

  it('advances the cold quota fairly across passes, deletion, insertion, and wraparound', async () => {
    const row = (id: string) => ({
      id,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    });
    const rows = new Map(['a', 'b', 'c'].map((id) => [id, row(id)]));
    const dormancyById = new Map<string, 'authorityUnavailable'>(
      [...rows].map(([id]) => [id, 'authorityUnavailable']),
    );
    const status = {
      rehydrationEnabled: true,
      persistedTotal: 3,
      systemExcluded: 0,
      hostedActivated: 0,
      hostedActivatedIds: [],
      activated: 0,
      activationCap: 0,
      capDisabled: true,
      completedAt: 1,
      updatedAt: 1,
    };
    const coldCursor = {};
    const attempts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const ports = {
      store: {
        loadAll: async () => [...rows.values()],
        load: async (id: string) => rows.get(id) ?? null,
        save: async () => undefined,
        delete: async () => undefined,
      },
      dormancyById,
      persistRevisions: new Map(),
      subscriptions: new Map(),
      coldCursor,
      getStatus: () => status,
      isCurrent: () => true,
      touchStatus: () => undefined,
      clearStatus: vi.fn(),
      resolveAuthority: vi.fn(async (candidate: { id: string }) => {
        attempts.push(candidate.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          outcome: 'unavailable' as const,
          source: 'registered-chain' as const,
          reason: 'temporary-authority-outage' as const,
          metadataBootstrap: 'eligible' as const,
        };
      }),
      activate: vi.fn(async () => undefined),
      warn: vi.fn(),
      activated: vi.fn(),
    };
    const runPass = () => recoverDeferredContextGraphSubscriptionAuthorities(
      new AbortController().signal,
      ports,
    );

    await runPass(); // a
    await runPass(); // b
    rows.delete('b');
    dormancyById.delete('b');
    rows.set('bb', row('bb'));
    dormancyById.set('bb', 'authorityUnavailable');
    await runPass(); // bb (first id after the deleted cursor b)
    await runPass(); // c
    await runPass(); // wrap to a

    expect(attempts).toEqual(['a', 'b', 'bb', 'c', 'a']);
    expect(maxActive).toBe(1);
    expect(coldCursor).toEqual({ afterContextGraphId: 'a' });
    expect(ports.activate).not.toHaveBeenCalled();
  });

  it('does not advance the cold cursor after cancellation retires the recovery owner', async () => {
    const contextGraphId = 'cancelled-cold-authority';
    const candidate = {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    const dormancyById = new Map<string, 'authorityUnavailable'>([
      [contextGraphId, 'authorityUnavailable'],
    ]);
    const status = {
      rehydrationEnabled: true,
      persistedTotal: 1,
      systemExcluded: 0,
      hostedActivated: 0,
      hostedActivatedIds: [],
      activated: 0,
      activationCap: 0,
      capDisabled: true,
      completedAt: 1,
      updatedAt: 1,
    };
    const coldCursor = {};
    const controller = new AbortController();
    let current = true;
    let enterAuthority!: () => void;
    const authorityEntered = new Promise<void>((resolve) => { enterAuthority = resolve; });
    const recovery = recoverDeferredContextGraphSubscriptionAuthorities(
      controller.signal,
      {
        store: {
          loadAll: async () => [candidate],
          load: async () => candidate,
          save: async () => undefined,
          delete: async () => undefined,
        },
        dormancyById,
        persistRevisions: new Map(),
        subscriptions: new Map(),
        coldCursor,
        getStatus: () => status,
        isCurrent: () => current,
        touchStatus: () => undefined,
        clearStatus: vi.fn(),
        resolveAuthority: async (_row, signal) => {
          enterAuthority();
          return await new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        activate: vi.fn(async () => undefined),
        warn: vi.fn(),
        activated: vi.fn(),
      },
    );

    await authorityEntered;
    current = false;
    controller.abort(new Error('recovery owner retired'));
    await expect(recovery).rejects.toThrow('recovery owner retired');
    expect(coldCursor).toEqual({});
  });

  it('skips a reclassified candidate and clears a durable row whose intent was removed', async () => {
    const reclassified = {
      id: 'reclassified-before-authority',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '7',
    };
    const noIntent = {
      id: 'intent-removed-before-authority',
      subscribed: false,
      coreHosted: false,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '8',
    };
    const rows = new Map([[reclassified.id, reclassified], [noIntent.id, noIntent]]);
    const dormancyById = new Map<string, any>([
      [reclassified.id, 'authorityUnavailable'],
      [noIntent.id, 'authorityUnavailable'],
    ]);
    const clearStatus = vi.fn((contextGraphId: string) => {
      dormancyById.delete(contextGraphId);
    });
    const resolveAuthority = vi.fn();

    await recoverDeferredContextGraphSubscriptionAuthorities(
      new AbortController().signal,
      {
        store: {
          loadAll: async () => [...rows.values()],
          load: async (contextGraphId) => {
            if (contextGraphId === reclassified.id) {
              dormancyById.set(contextGraphId, 'activationCap');
            }
            return rows.get(contextGraphId) ?? null;
          },
          save: async () => undefined,
          delete: async () => undefined,
        },
        dormancyById,
        persistRevisions: new Map(),
        subscriptions: new Map(),
        getStatus: () => ({
          rehydrationEnabled: true,
          persistedTotal: 2,
          systemExcluded: 0,
          hostedActivated: 0,
          hostedActivatedIds: [],
          activated: 0,
          activationCap: 0,
          capDisabled: true,
          completedAt: 1,
          updatedAt: 1,
        }),
        isCurrent: () => true,
        touchStatus: () => undefined,
        clearStatus,
        resolveAuthority,
        activate: vi.fn(),
        warn: vi.fn(),
        activated: vi.fn(),
      },
    );

    expect(resolveAuthority).not.toHaveBeenCalled();
    expect(dormancyById.get(reclassified.id)).toBe('activationCap');
    expect(clearStatus).toHaveBeenCalledWith(noIntent.id);
    expect(dormancyById.has(noIntent.id)).toBe(false);
  });

  it('activates a bound row before advancing to a later cold authority read', async () => {
    const bound = {
      id: 'z-bound',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '7',
    };
    const cold = {
      id: 'a-cold',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    const rows = new Map([[bound.id, bound], [cold.id, cold]]);
    const dormancyById = new Map<string, 'authorityUnavailable'>([
      [cold.id, 'authorityUnavailable'],
      [bound.id, 'authorityUnavailable'],
    ]);
    const status = {
      rehydrationEnabled: true,
      persistedTotal: 2,
      systemExcluded: 0,
      hostedActivated: 0,
      hostedActivatedIds: [],
      activated: 0,
      activationCap: 0,
      capDisabled: true,
      completedAt: 1,
      updatedAt: 1,
    };
    let releaseCold!: () => void;
    const coldGate = new Promise<void>((resolve) => { releaseCold = resolve; });
    const activated: string[] = [];
    const resolveAuthority = vi.fn(async (row: { id: string }) => {
      if (row.id === cold.id) await coldGate;
      return {
        outcome: 'allowed' as const,
        source: 'registered-chain' as const,
        reason: 'chain-participant' as const,
        metadataBootstrap: 'eligible' as const,
        onChainId: row.id === bound.id ? 7n : 8n,
      };
    });

    const recovery = recoverDeferredContextGraphSubscriptionAuthorities(
      new AbortController().signal,
      {
        store: {
          loadAll: async () => [...rows.values()],
          load: async (id) => rows.get(id) ?? null,
          save: async () => undefined,
          delete: async () => undefined,
        },
        dormancyById,
        persistRevisions: new Map(),
        subscriptions: new Map(),
        getStatus: () => status,
        isCurrent: () => true,
        touchStatus: () => undefined,
        clearStatus: vi.fn(),
        resolveAuthority,
        activate: async (row) => { activated.push(row.id); },
        warn: vi.fn(),
        activated: () => { status.activated += 1; },
      },
    );

    await vi.waitFor(() => expect(activated).toEqual([bound.id]));
    expect(resolveAuthority.mock.calls.map(([row]) => row.id)).toEqual([
      bound.id,
      cold.id,
    ]);
    releaseCold();
    await recovery;
    expect(activated).toEqual([bound.id, cold.id]);
  });

  it.each([
    ['on-chain id changes', false, (row: any) => ({ ...row, onChainId: '8' })],
    ['name commitment changes', false, (row: any) => ({ ...row, onChainHash: `0x${'bb'.repeat(32)}` })],
    ['admitted intent is removed', true, (row: any) => ({
      ...row,
      subscribed: false,
      coreHosted: false,
    })],
    ['row identity changes', false, (row: any) => ({ ...row, id: `${row.id}-replacement` })],
  ] as const)('does not activate when %s during authority resolution', async (
    _case,
    clearsDormancy,
    mutateRow,
  ) => {
    const contextGraphId = 'binding-mutates-during-recovery';
    const row = {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '7',
      onChainHash: `0x${'aa'.repeat(32)}`,
    };
    const rows = new Map([[contextGraphId, row]]);
    const dormancyById = new Map<string, 'authorityUnavailable'>([
      [contextGraphId, 'authorityUnavailable'],
    ]);
    const status = {
      rehydrationEnabled: true,
      persistedTotal: 1,
      systemExcluded: 0,
      hostedActivated: 0,
      hostedActivatedIds: [],
      activated: 0,
      activationCap: 0,
      capDisabled: true,
      completedAt: 1,
      updatedAt: 1,
    };
    let releaseAuthority!: () => void;
    let enterAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    const authorityEntered = new Promise<void>((resolve) => { enterAuthority = resolve; });
    const activate = vi.fn(async () => undefined);
    const clearStatus = vi.fn((id: string) => { dormancyById.delete(id); });
    const recovery = recoverDeferredContextGraphSubscriptionAuthorities(
      new AbortController().signal,
      {
        store: {
          loadAll: async () => [...rows.values()],
          load: async (id) => rows.get(id) ?? null,
          save: async () => undefined,
          delete: async () => undefined,
        },
        dormancyById,
        persistRevisions: new Map(),
        subscriptions: new Map(),
        getStatus: () => status,
        isCurrent: () => true,
        touchStatus: () => undefined,
        clearStatus,
        resolveAuthority: async () => {
          enterAuthority();
          await authorityGate;
          return {
            outcome: 'allowed' as const,
            source: 'registered-chain' as const,
            reason: 'chain-participant' as const,
            metadataBootstrap: 'eligible' as const,
            onChainId: 7n,
          };
        },
        activate,
        warn: vi.fn(),
        activated: () => { status.activated += 1; },
      },
    );

    await authorityEntered;
    rows.set(contextGraphId, mutateRow(row));
    releaseAuthority();
    await recovery;

    expect(activate).not.toHaveBeenCalled();
    if (clearsDormancy) {
      expect(clearStatus).toHaveBeenCalledWith(contextGraphId);
      expect(dormancyById.has(contextGraphId)).toBe(false);
    } else {
      expect(clearStatus).not.toHaveBeenCalled();
      expect(dormancyById.get(contextGraphId)).toBe('authorityUnavailable');
    }
    expect(status.activated).toBe(0);
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
      // This fixture owns one deliberately pending name-hash lookup. Keep the
      // unrelated VM startup sweep from issuing another lookup and replacing
      // the resolver that represents the authority-recovery attempt.
      syncReconcilerEnabled: false,
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

  it('rehydrates a durable numeric binding without reverse name discovery', async () => {
    const contextGraphId = 'persisted-authoritative-binding-startup';
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '7',
    }]]);
    agent = await DKGAgent.create({
      name: 'PersistedAuthoritativeBindingStartup',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
    });
    mockLivePolicy(agent, 0);
    const targetNameHash = agent.contextGraphNameCommitment(contextGraphId);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('durable binding must bypass reverse discovery');
        }
        return null;
      });

    await agent.start();

    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
    });
  });

  it('promotes a capped durable binding without reverse name discovery', async () => {
    const liveContextGraphId = '00-promotion-live-owner';
    const cappedContextGraphId = 'zz-promotion-bound-target';
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([
      [liveContextGraphId, {
        id: liveContextGraphId,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
        onChainId: '7',
      }],
      [cappedContextGraphId, {
        id: cappedContextGraphId,
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        syncScoped: true,
        onChainId: '8',
      }],
    ]);
    agent = await DKGAgent.create({
      name: 'PersistedBoundPromotion',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      maxRehydratedContextGraphSubscriptions: 1,
      syncReconcilerEnabled: false,
    });
    mockLivePolicy(agent, 0);
    const targetNameHash = agent.contextGraphNameCommitment(cappedContextGraphId);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('capped durable binding must bypass reverse discovery');
        }
        return null;
      });

    await agent.start();
    expect(agent.getSubscribedContextGraphs().has(cappedContextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      dormantReasons: { activationCap: [cappedContextGraphId] },
    });

    agent.setContextGraphSubscription(liveContextGraphId, {
      ...agent.getSubscribedContextGraphs().get(liveContextGraphId)!,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });

    await vi.waitFor(
      () => expect(agent!.getSubscribedContextGraphs().get(cappedContextGraphId))
        .toMatchObject({ subscribed: true, onChainId: '8' }),
      { timeout: 10_000, interval: 10 },
    );
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
  }, 15_000);

  it('strictly heals a malformed capped binding before promotion side effects', async () => {
    const liveContextGraphId = '00-promotion-heal-live-owner';
    const targetNameHash = `0x${'a3'.repeat(32)}`;
    const cappedContextGraphId = targetNameHash;
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([
      [liveContextGraphId, {
        id: liveContextGraphId,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
        onChainId: '7',
      }],
      [cappedContextGraphId, {
        id: cappedContextGraphId,
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        syncScoped: true,
        onChainId: '042',
        onChainHash: targetNameHash,
      }],
    ]);
    const resolveFinalized = vi.fn(async (nameHash: string) => (
      nameHash === targetNameHash ? 8n : null
    ));
    Object.assign(chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    agent = await DKGAgent.create({
      name: 'PersistedMalformedPromotion',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      maxRehydratedContextGraphSubscriptions: 1,
      syncReconcilerEnabled: false,
    });
    mockLivePolicy(agent, 0);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('capped repair must stay on the finalized index');
        }
        return null;
      });

    await agent.start();
    expect(agent.getSubscribedContextGraphs().has(cappedContextGraphId)).toBe(false);

    agent.setContextGraphSubscription(liveContextGraphId, {
      ...agent.getSubscribedContextGraphs().get(liveContextGraphId)!,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });

    await vi.waitFor(
      () => expect(agent!.getSubscribedContextGraphs().get(cappedContextGraphId))
        .toMatchObject({ subscribed: true, onChainId: '8' }),
      { timeout: 10_000, interval: 10 },
    );
    expect(rows.get(cappedContextGraphId)).toMatchObject({ onChainId: '8' });
    expect(resolveFinalized).toHaveBeenCalledWith(targetNameHash, expect.any(Object));
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
  }, 15_000);

  it.each([
    ['non-canonical', '042'],
    ['zero', '0'],
    ['uint256 overflow', (1n << 256n).toString(10)],
  ] as const)('heals a %s durable binding at startup only through the finalized index', async (
    _case,
    persistedOnChainId,
  ) => {
    const targetNameHash = `0x${'a1'.repeat(32)}`;
    const contextGraphId = targetNameHash;
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: persistedOnChainId,
      onChainHash: targetNameHash,
    }]]);
    const resolveFinalized = vi.fn(async () => 7n);
    Object.assign(chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    agent = await DKGAgent.create({
      name: `PersistedInvalidBindingStartup-${_case}`,
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
    });
    mockLivePolicy(agent, 0);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('malformed durable binding must not use legacy reverse discovery');
        }
        return null;
      });

    await agent.start();

    expect(resolveFinalized).toHaveBeenCalledWith(targetNameHash, expect.any(Object));
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(rows.get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '7',
    });
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantReasons: { authorityUnavailable: [] },
    });
  });

  it.each([
    ['non-canonical', '042'],
    ['zero', '0'],
    ['uint256 overflow', (1n << 256n).toString(10)],
  ] as const)('retries and heals a transient %s durable binding repair', async (
    _case,
    persistedOnChainId,
  ) => {
    const targetNameHash = `0x${'a2'.repeat(32)}`;
    const contextGraphId = targetNameHash;
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: persistedOnChainId,
      onChainHash: targetNameHash,
    }]]);
    let targetAttempts = 0;
    const resolveFinalized = vi.fn(async (nameHash: string) => {
      if (nameHash !== targetNameHash) return null;
      targetAttempts += 1;
      if (targetAttempts === 1) throw new Error('transient finalized-index outage');
      return 7n;
    });
    Object.assign(chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    agent = await DKGAgent.create({
      name: `PersistedInvalidBindingRetry-${_case}`,
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
    });
    mockLivePolicy(agent, 0);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('durable repair retry must stay on the finalized index');
        }
        return null;
      });

    await agent.start();
    await vi.waitFor(
      () => expect(agent!.getSubscribedContextGraphs().get(contextGraphId))
        .toMatchObject({ subscribed: true, onChainId: '7' }),
      { timeout: 10_000 },
    );

    expect(targetAttempts).toBeGreaterThanOrEqual(2);
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
    expect(rows.get(contextGraphId)).toMatchObject({ onChainId: '7' });
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantReasons: { authorityUnavailable: [] },
    });
  }, 15_000);

  it('retries a transient startup policy failure through the same durable binding', async () => {
    const contextGraphId = 'persisted-authoritative-binding-retry';
    const chain = new MockChainAdapter();
    const rows = new Map<string, any>([[contextGraphId, {
      id: contextGraphId,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      onChainId: '7',
    }]]);
    agent = await DKGAgent.create({
      name: 'PersistedAuthoritativeBindingRetry',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
    });
    let targetPolicyAttempts = 0;
    vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
      .mockImplementation(async (onChainId) => {
        if (onChainId !== '7') return { kind: 'available', accessPolicy: 0 };
        targetPolicyAttempts += 1;
        return targetPolicyAttempts === 1
          ? {
              kind: 'unavailable',
              reason: 'chain-access-policy-timeout',
              detail: 'transient startup policy timeout',
            }
          : { kind: 'available', accessPolicy: 0 };
      });
    const targetNameHash = agent.contextGraphNameCommitment(contextGraphId);
    const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockImplementation(async (nameHash) => {
        if (nameHash === targetNameHash) {
          throw new Error('authority retry must retain durable binding');
        }
        return null;
      });

    await agent.start();
    await vi.waitFor(
      () => expect(agent!.getSubscribedContextGraphs().get(contextGraphId))
        .toMatchObject({ subscribed: true, onChainId: '7' }),
      { timeout: 10_000 },
    );

    expect(targetPolicyAttempts).toBe(2);
    expect(reverse.mock.calls.some(([nameHash]) => nameHash === targetNameHash)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantReasons: { authorityUnavailable: [] },
    });
  }, 15_000);

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

  it('retains one cold fairness cursor across real recurring-owner passes', async () => {
    const ids = ['a-recurring-cold', 'b-recurring-cold'];
    const rows = new Map<string, any>(ids.map((id) => [id, {
      id,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    }]));
    agent = await DKGAgent.create({
      name: 'RecurringAuthorityFairCursor',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...rows.values()],
        load: async (id) => rows.get(id) ?? null,
        save: async (row) => { rows.set(row.id, row); },
        delete: async (id) => { rows.delete(id); },
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      syncReconcilerEnabled: false,
    });
    const attempts: string[] = [];
    vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
      .mockImplementation(async (contextGraphId) => {
        if (ids.includes(contextGraphId)) attempts.push(contextGraphId);
        return {
          outcome: 'unavailable',
          source: 'registered-chain',
          reason: 'temporary-authority-outage',
          metadataBootstrap: 'eligible',
        } as const;
      });
    const retry = vi.spyOn(agent, 'retryUnavailableContextGraphSubscriptionAuthorities');
    vi.useFakeTimers();

    await agent.start();
    expect(attempts).toEqual(ids);
    attempts.length = 0;

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([ids[0]]);
    expect(retry).toHaveBeenCalledOnce();
    const firstCursor = retry.mock.calls[0]?.[1];
    expect(firstCursor).toEqual({ afterContextGraphId: ids[0] });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual(ids);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[1]?.[1]).toBe(firstCursor);
    expect(firstCursor).toEqual({ afterContextGraphId: ids[1] });
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
    const subscribe = vi.spyOn(agent, 'adoptAndInstallContextGraphSubscription');
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
    const subscribe = vi.spyOn(agent, 'adoptAndInstallContextGraphSubscription');
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
