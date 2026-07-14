import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { bootstrapConfiguredContextGraphs } from '../src/daemon/lifecycle.js';

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

  return {
    agent: {
      ensureContextGraphLocal,
      getContextGraphCreator: vi.fn(async (contextGraphId: string) => creators[contextGraphId] ?? null),
      isCuratorOf: vi.fn(async (contextGraphId: string) => locallyCurated[contextGraphId] ?? false),
      hasConfirmedMetaState: vi.fn(async (contextGraphId: string) =>
        confirmedMeta[contextGraphId] ?? Boolean(creators[contextGraphId])),
      getSubscribedContextGraphs: () => subscriptions,
      subscribeToContextGraph,
      markContextGraphSubscriptionState,
      store,
    } as unknown as DKGAgent,
    ensureContextGraphLocal,
    markContextGraphSubscriptionState,
    subscribeToContextGraph,
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
    // Mirrors hasConfirmedMetaState's legacy-placeholder guard: the normal
    // public ontology fallback says true, but the explicit remote proof must
    // reject the same unregistered placeholder before migration reads it.
    vi.mocked(fixture.agent.hasConfirmedMetaState).mockImplementation(async (
      _id,
      options?: { rejectUnregisteredPlaceholder?: boolean },
    ) => options?.rejectUnregisteredPlaceholder !== true);

    await bootstrapConfiguredContextGraphs({
      agent: fixture.agent,
      configuredContextGraphIds: [contextGraphId],
      networkDefaultContextGraphIds: [],
      log: vi.fn(),
    });

    expect(fixture.agent.hasConfirmedMetaState).toHaveBeenCalledTimes(1);
    expect(fixture.agent.hasConfirmedMetaState).toHaveBeenCalledWith(
      contextGraphId,
      { rejectUnregisteredPlaceholder: true },
    );
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
    );
    expect(fixture.subscriptions.has(SYSTEM_CONTEXT_GRAPHS.AGENTS)).toBe(false);
    expect(fixture.subscriptions.has(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)).toBe(false);
  });
});
