import { describe, expect, it, vi } from 'vitest';
import type {
  ConfiguredContextGraphMetadataReconciliationResult,
  DKGAgent,
} from '@origintrail-official/dkg-agent';
import { DKGEvent, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  bootstrapConfiguredContextGraphs,
} from '../src/daemon/lifecycle.js';
import {
  persistProjectSyncedReadiness,
  registerProjectSyncedReadinessPersistence,
} from '../src/context-graph-readiness.js';

type Subscription = {
  subscribed?: boolean;
  synced?: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  pendingMeta?: boolean;
};

function createStore(queryImplementation?: (sparql: string) => Promise<unknown>) {
  return {
    query: vi.fn(queryImplementation ?? (async () => ({ type: 'bindings', bindings: [] }))),
    delete: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  };
}

function createAgent(
  initial: Record<string, Subscription> = {},
  creators: Record<string, string | null> = {},
  store = createStore(),
  confirmedMeta: Record<string, boolean> = {},
  locallyCurated: Record<string, boolean> = {},
) {
  const subscriptions = new Map<string, Subscription>(Object.entries(initial));
  const ensureContextGraphLocal = vi.fn();
  const subscribeToContextGraph = vi.fn((contextGraphId: string) => {
    const existing = subscriptions.get(contextGraphId);
    subscriptions.set(contextGraphId, {
      ...existing,
      subscribed: true,
      synced: existing?.synced ?? false,
    });
  });
  const markContextGraphSubscriptionState = vi.fn(
    (contextGraphId: string, patch: Partial<Subscription>) => {
      const existing = subscriptions.get(contextGraphId);
      if (!existing) return;
      subscriptions.set(contextGraphId, { ...existing, ...patch });
    },
  );
  const reconcileConfiguredContextGraphMetadata = vi.fn(
    async (contextGraphId: string): Promise<ConfiguredContextGraphMetadataReconciliationResult> => {
      const repair = {
        outcome: 'not-chain-attested' as const,
        chainProof: { state: 'not-public' as const, reason: 'unregistered' as const },
      };
      return confirmedMeta[contextGraphId] ?? Boolean(creators[contextGraphId])
        ? { outcome: 'authoritative', repair }
        : { outcome: 'pending', reason: 'missing-metadata', repair };
    },
  );

  return {
    agent: {
      ensureContextGraphLocal,
      getContextGraphCreator: vi.fn(async (contextGraphId: string) => creators[contextGraphId] ?? null),
      isCuratorOf: vi.fn(async (contextGraphId: string) => locallyCurated[contextGraphId] ?? false),
      hasConfirmedMetaState: vi.fn(async (contextGraphId: string) =>
        confirmedMeta[contextGraphId] ?? Boolean(creators[contextGraphId])),
      getSubscribedContextGraphs: () => subscriptions,
      subscribeToContextGraph,
      reconcileConfiguredContextGraphMetadata,
      markContextGraphSubscriptionState,
      store,
    } as unknown as DKGAgent,
    ensureContextGraphLocal,
    markContextGraphSubscriptionState,
    subscribeToContextGraph,
    reconcileConfiguredContextGraphMetadata,
    subscriptions,
    store,
  };
}

describe('configured context graph daemon bootstrap', () => {
  it('subscribes an unknown namespaced graph as pending metadata without creating a local definition', async () => {
    const fixture = createAgent();
    const log = vi.fn();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: ['0x1234567890123456789012345678901234567890/private-cg'],
      networkDefaultContextGraphIds: [],
      log,
    });

    expect(fixture.ensureContextGraphLocal).not.toHaveBeenCalled();
    expect(fixture.subscribeToContextGraph).toHaveBeenCalledWith(
      '0x1234567890123456789012345678901234567890/private-cg',
      { syncMode: 'always-on' },
    );
    expect(
      fixture.subscriptions.get('0x1234567890123456789012345678901234567890/private-cg'),
    ).toEqual({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(log).toHaveBeenCalledWith(
      'Subscribed to configured context graph: 0x1234567890123456789012345678901234567890/private-cg (metadata pending)',
    );
  });

  it('treats an unknown bare configured graph as a remote metadata target', async () => {
    const fixture = createAgent();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: ['private-cg-without-namespace'],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.ensureContextGraphLocal).not.toHaveBeenCalled();
    expect(fixture.subscriptions.get('private-cg-without-namespace')).toEqual({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('preserves a confirmed namespaced local subscription while ensuring it remains subscribed', async () => {
    const fixture = createAgent(
      {
        '0x1234567890123456789012345678901234567890/local-cg': {
          subscribed: false,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          pendingMeta: false,
        },
      },
      {
        '0x1234567890123456789012345678901234567890/local-cg':
          'did:dkg:agent:12D3KooWCreator',
      },
      createStore(),
      {},
      { '0x1234567890123456789012345678901234567890/local-cg': true },
    );

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: ['0x1234567890123456789012345678901234567890/local-cg'],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.subscribeToContextGraph).toHaveBeenCalledWith(
      '0x1234567890123456789012345678901234567890/local-cg',
      { syncMode: 'always-on' },
    );
    expect(fixture.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(
      fixture.subscriptions.get('0x1234567890123456789012345678901234567890/local-cg'),
    ).toEqual({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('preserves a confirmed remote public configured graph even when it has no creator', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/creatorless-public';
    const store = createStore();
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      store,
      { [contextGraphId]: true },
    );
    const log = vi.fn();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log,
    });

    expect(fixture.store.delete).not.toHaveBeenCalled();
    expect(fixture.store.flush).not.toHaveBeenCalled();
    expect(fixture.markContextGraphSubscriptionState).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      `Subscribed to configured context graph: ${contextGraphId} (metadata already confirmed)`,
    );
    expect(fixture.subscriptions.get(contextGraphId)).toEqual({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });
  });

  it('repairs chain-attested public metadata before accepting a legacy configured graph', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/legacy-public';
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: true },
    );
    fixture.reconcileConfiguredContextGraphMetadata.mockResolvedValue({
      outcome: 'authoritative',
      repair: {
        outcome: 'projection-complete',
        chainProof: { state: 'public' },
      },
    });
    const log = vi.fn();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log,
    });

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledWith(contextGraphId);
    expect(log).toHaveBeenCalledWith(
      `Completed chain-attested public metadata for configured context graph: ${contextGraphId}`,
    );
    expect(log).toHaveBeenCalledWith(
      `Subscribed to configured context graph: ${contextGraphId} (metadata already confirmed)`,
    );
    expect(fixture.markContextGraphSubscriptionState).not.toHaveBeenCalled();
  });

  it('leaves a chain/root policy conflict pending without overwriting it', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/policy-conflict';
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: true },
    );
    fixture.reconcileConfiguredContextGraphMetadata.mockResolvedValue({
      outcome: 'pending',
      reason: 'conflicting-policy',
      repair: {
        outcome: 'conflicting-policy',
        chainProof: { state: 'public' },
      },
    });

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('accepts a conflict resolved before the next locked reconciliation without sticky state', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/resolved-conflict';
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: true },
    );
    fixture.reconcileConfiguredContextGraphMetadata
      .mockResolvedValueOnce({
        outcome: 'pending',
        reason: 'conflicting-policy',
        repair: {
          outcome: 'conflicting-policy',
          chainProof: { state: 'public' },
        },
      })
      .mockResolvedValueOnce({
        outcome: 'authoritative',
        repair: {
          outcome: 'projection-complete',
          chainProof: { state: 'public' },
        },
      });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await bootstrapConfiguredContextGraphs({
        agent: fixture.agent,
        configuredContextGraphIds: [contextGraphId],
        networkDefaultContextGraphIds: [],
        log: vi.fn(),
      });
    }

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(2);
    expect(fixture.markContextGraphSubscriptionState).toHaveBeenCalledTimes(2);
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('queues real PROJECT_SYNCED persistence behind the pending-state reset', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/late-authoritative';
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: true },
    );
    let releaseReconciliation!: () => void;
    const reconciliationBlocked = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
    fixture.reconcileConfiguredContextGraphMetadata.mockImplementation(async () => {
      await reconciliationBlocked;
      return {
        outcome: 'pending' as const,
        reason: 'missing-metadata' as const,
        repair: {
          outcome: 'not-chain-attested' as const,
          chainProof: { state: 'unknown' as const, reason: 'unprovable' as const },
        },
      };
    });
    const readinessWrites: Array<Readonly<{
      durableVerified: boolean;
      sharedMemoryVerified: boolean;
    }>> = [];
    const readinessStore = {
      setContextGraphReadinessProvenance: vi.fn((_id, readiness) => {
        readinessWrites.push({
          durableVerified: readiness.durableVerified,
          sharedMemoryVerified: readiness.sharedMemoryVerified,
        });
      }),
    };

    const bootstrap = bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      readinessStore,
      log: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    });
    const projectSynced = persistProjectSyncedReadiness({
      agent: fixture.agent,
      store: readinessStore,
      contextGraphId,
      dataSynced: 1,
      sharedMemorySynced: 1,
    });
    expect(readinessWrites).toEqual([]);
    releaseReconciliation();
    await Promise.all([bootstrap, projectSynced]);

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    expect(readinessWrites).toEqual([
      { durableVerified: false, sharedMemoryVerified: false },
      { durableVerified: true, sharedMemoryVerified: true },
    ]);
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('preserves a transient chain-proof failure as unknown and fails closed', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/transient-chain-proof';
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: false },
    );
    fixture.reconcileConfiguredContextGraphMetadata.mockResolvedValue({
      outcome: 'pending',
      reason: 'missing-metadata',
      repair: {
        outcome: 'not-chain-attested',
        chainProof: {
          state: 'unknown',
          reason: 'rpc-failure',
          detail: 'temporary RPC outage',
        },
      },
    });

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('continues startup and resets stale readiness when the locked repair rejects', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/repair-error';
    let readiness = {
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
      updatedAt: Date.now(),
    };
    const readinessStore = {
      getContextGraphReadinessProvenance: () => readiness,
      setContextGraphReadinessProvenance: vi.fn((_id, next) => {
        readiness = { ...next, updatedAt: Date.now() };
      }),
    };
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      createStore(),
      { [contextGraphId]: false },
    );
    fixture.reconcileConfiguredContextGraphMetadata.mockResolvedValue({
      outcome: 'pending',
      reason: 'missing-metadata',
      repair: { outcome: 'repair-failed', detail: 'simulated chain RPC failure' },
    });
    const log = vi.fn();

    await expect(bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      readinessStore,
      log,
    })).resolves.toBeUndefined();

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      `Context graph "${contextGraphId}" public metadata repair failed`,
    ));
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('marks an unconfirmed creatorless configured graph pending without deleting RDF', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/unconfirmed';
    const store = createStore();
    const fixture = createAgent(
      {
        [contextGraphId]: {
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        },
      },
      {},
      store,
    );

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.store.delete).not.toHaveBeenCalled();
    expect(fixture.store.flush).not.toHaveBeenCalled();
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('clears persisted readiness proof while configured metadata is pending', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/stale-proof';
    const fixture = createAgent({
      [contextGraphId]: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
      },
    });
    const setContextGraphReadinessProvenance = vi.fn();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      readinessStore: {
        getContextGraphReadinessProvenance: () => ({
          version: 1,
          durableVerified: true,
          sharedMemoryVerified: true,
          updatedAt: Date.now(),
        }),
        setContextGraphReadinessProvenance,
      },
      log: vi.fn(),
    });

    expect(setContextGraphReadinessProvenance).toHaveBeenCalledWith(
      contextGraphId,
      expect.objectContaining({
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
      }),
    );
  });

  it('preserves PROJECT_SYNCED proof that lands during stale bootstrap classification', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/startup-sync-race';
    const fixture = createAgent({
      [contextGraphId]: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
      },
    });
    let readiness: {
      version: number;
      durableVerified: boolean;
      sharedMemoryVerified: boolean;
      updatedAt: number;
    } | null = null;
    let projectSyncedHandler: ((data: unknown) => void) | undefined;
    (fixture.agent as any).eventBus = {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        if (event === DKGEvent.PROJECT_SYNCED) projectSyncedHandler = handler;
      }),
    };
    vi.mocked(fixture.agent.hasConfirmedMetaState).mockResolvedValue(true);
    fixture.reconcileConfiguredContextGraphMetadata.mockResolvedValue({
      outcome: 'authoritative',
      repair: {
        outcome: 'already-complete',
        chainProof: { state: 'not-requested' },
      },
    });
    const readinessStore = {
      getContextGraphReadinessProvenance: () => readiness,
      setContextGraphReadinessProvenance: vi.fn((id, next) => {
        expect(id).toBe(contextGraphId);
        readiness = { ...next, updatedAt: Date.now() };
      }),
    };
    registerProjectSyncedReadinessPersistence({
      agent: fixture.agent,
      store: readinessStore,
      log: vi.fn(),
    });
    fixture.subscribeToContextGraph.mockImplementation((id: string) => {
      const current = fixture.subscriptions.get(id);
      fixture.subscriptions.set(id, {
        ...current,
        subscribed: true,
        synced: true,
        metaSynced: true,
        pendingMeta: false,
      });
      projectSyncedHandler?.({
        contextGraphId: id,
        dataSynced: 2,
        sharedMemorySynced: 0,
      });
    });

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      readinessStore,
      log: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(readiness).toMatchObject({
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: false,
      });
    });
    expect(fixture.markContextGraphSubscriptionState).not.toHaveBeenCalledWith(
      contextGraphId,
      expect.objectContaining({ metaSynced: false }),
    );
  });

  it('fails closed before checking a legacy unregistered configured shadow', async () => {
    const contextGraphId = '0x1234567890123456789012345678901234567890/legacy-shadow';
    const fixture = createAgent({
      [contextGraphId]: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });
    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.reconcileConfiguredContextGraphMetadata).toHaveBeenCalledWith(contextGraphId);
    expect(fixture.subscriptions.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('keeps network defaults and caller-supplied devnet fixtures on the local bootstrap path', async () => {
    const fixture = createAgent();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: ['configured-public-target', 'testing', 'devnet-test'],
      networkDefaultContextGraphIds: ['testing'],
      localBootstrapContextGraphIds: ['devnet-test'],
      log: vi.fn(),
    });

    expect(fixture.ensureContextGraphLocal).toHaveBeenCalledTimes(2);
    expect(fixture.ensureContextGraphLocal).toHaveBeenCalledWith({
      id: 'testing',
      name: 'testing',
      description: 'Default context graph: testing',
    });
    expect(fixture.ensureContextGraphLocal).toHaveBeenCalledWith({
      id: 'devnet-test',
      name: 'devnet-test',
      description: 'Default context graph: devnet-test',
    });
    expect(fixture.subscriptions.get('configured-public-target')).toMatchObject({
      subscribed: true,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('leaves system graph bootstrap to the agent and de-duplicates configured ids', async () => {
    const fixture = createAgent();

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [
        SYSTEM_CONTEXT_GRAPHS.AGENTS,
        SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        '0x1234567890123456789012345678901234567890/remote-cg',
        '0x1234567890123456789012345678901234567890/remote-cg',
      ],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.subscribeToContextGraph).toHaveBeenCalledTimes(1);
    expect(fixture.subscribeToContextGraph).toHaveBeenCalledWith(
      '0x1234567890123456789012345678901234567890/remote-cg',
      { syncMode: 'always-on' },
    );
    expect(fixture.subscriptions.has(SYSTEM_CONTEXT_GRAPHS.AGENTS)).toBe(false);
    expect(fixture.subscriptions.has(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)).toBe(false);
  });

  it('wires PROJECT_SYNCED persistence to the daemon event bus', async () => {
    const contextGraphId = 'project-synced-wiring';
    let handler: ((data: unknown) => void) | undefined;
    const setContextGraphReadinessProvenance = vi.fn();
    const agent = {
      eventBus: {
        on: vi.fn((event: string, next: (data: unknown) => void) => {
          if (event === DKGEvent.PROJECT_SYNCED) handler = next;
        }),
      },
      hasConfirmedMetaState: vi.fn(async () => true),
    } as unknown as DKGAgent;

    registerProjectSyncedReadinessPersistence({
      agent,
      store: {
        getContextGraphReadinessProvenance: () => null,
        setContextGraphReadinessProvenance,
      },
      log: vi.fn(),
    });

    expect(agent.eventBus.on).toHaveBeenCalledWith(
      DKGEvent.PROJECT_SYNCED,
      expect.any(Function),
    );
    expect(handler).toBeTypeOf('function');
    handler?.({
      contextGraphId,
      dataSynced: 3,
      sharedMemorySynced: 0,
    });

    await vi.waitFor(() => {
      expect(setContextGraphReadinessProvenance).toHaveBeenCalledWith(
        contextGraphId,
        expect.objectContaining({
          version: 1,
          durableVerified: true,
          sharedMemoryVerified: false,
        }),
      );
    });
  });

  it('persists durable readiness for a verified private-only PROJECT_SYNCED response', async () => {
    const contextGraphId = 'private-only-project-synced';
    let handler: ((data: unknown) => void) | undefined;
    const setContextGraphReadinessProvenance = vi.fn();
    const agent = {
      eventBus: {
        on: vi.fn((event: string, next: (data: unknown) => void) => {
          if (event === DKGEvent.PROJECT_SYNCED) handler = next;
        }),
      },
      hasConfirmedMetaState: vi.fn(async () => true),
    } as unknown as DKGAgent;

    registerProjectSyncedReadinessPersistence({
      agent,
      store: {
        getContextGraphReadinessProvenance: () => null,
        setContextGraphReadinessProvenance,
      },
      log: vi.fn(),
    });

    handler?.({
      contextGraphId,
      dataSynced: 0,
      sharedMemorySynced: 0,
      verifiedPrivateOnlyResponses: 1,
    });

    await vi.waitFor(() => {
      expect(setContextGraphReadinessProvenance).toHaveBeenCalledWith(
        contextGraphId,
        expect.objectContaining({
          version: 1,
          durableVerified: true,
          sharedMemoryVerified: false,
        }),
      );
    });
  });
});
