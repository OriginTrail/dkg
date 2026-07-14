import { describe, expect, it } from 'vitest';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter, type ContextGraphOnChain } from '@origintrail-official/dkg-chain';
import {
  AGENT_REGISTRY_CONTEXT_GRAPH,
  DKGAgent,
  type ContextGraphMembershipRecord,
  type ContextGraphSubscriptionRecord,
} from '../src/index.js';

describe('Context Graph discovery/subscription boundary', () => {
  it('keeps discovery passive, activates explicit intent, and rehydrates only the explicit subscription', async () => {
    expect([...Object.values(SYSTEM_CONTEXT_GRAPHS)].sort()).toEqual(['agents', 'ontology']);
    expect(AGENT_REGISTRY_CONTEXT_GRAPH).toBe(SYSTEM_CONTEXT_GRAPHS.AGENTS);

    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const members = new Map<string, ContextGraphMembershipRecord>();
    const subscriptionStore = {
      loadAll: async () => [...persisted.values()],
      save: async (record: ContextGraphSubscriptionRecord) => {
        persisted.set(record.id, { ...record });
      },
      delete: async (contextGraphId: string) => {
        persisted.delete(contextGraphId);
      },
    };
    const membershipStore = {
      upsert: async (record: ContextGraphMembershipRecord) => {
        members.set(`${record.contextGraphId}|${record.principalType}|${record.principalId}`, { ...record });
      },
      delete: async (contextGraphId: string, principalType: string, principalId: string) => {
        members.delete(`${contextGraphId}|${principalType}|${principalId}`);
      },
    };

    const agentA = await DKGAgent.create({
      name: 'DiscoveryBoundaryA',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: subscriptionStore,
      contextGraphMembershipStore: membershipStore,
    });

    try {
      await agentA.start();
      for (const systemId of Object.values(SYSTEM_CONTEXT_GRAPHS)) {
        expect(agentA.getSubscribedContextGraphs().get(systemId)?.subscribed).toBe(true);
      }

      for (const id of ['discovery-only-cg', 'explicit-after-discovery']) {
        agentA.recordDiscoveredContextGraph(id, {
          name: id,
          subscribed: false,
          synced: false,
          metaSynced: false,
        });
      }
      agentA.recordDiscoveredContextGraph('discovery-only-cg', {
        subscribed: false,
        synced: false,
        coreHosted: true,
        lastReconciledOrdinal: 7,
        pendingMeta: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(agentA.getSubscribedContextGraphs().get('discovery-only-cg')).toMatchObject({
        subscribed: false,
        coreHosted: undefined,
        lastReconciledOrdinal: undefined,
        pendingMeta: undefined,
      });
      expect((agentA as any).config.syncContextGraphs ?? []).not.toContain('discovery-only-cg');
      expect((agentA as any).gossipRegistered.has('discovery-only-cg')).toBe(false);
      expect(persisted.has('discovery-only-cg')).toBe(false);
      expect([...members.values()].some((record) => record.contextGraphId === 'discovery-only-cg')).toBe(false);

      agentA.subscribeToContextGraph('explicit-after-discovery');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(agentA.getSubscribedContextGraphs().get('explicit-after-discovery')?.subscribed).toBe(true);
      expect((agentA as any).config.syncContextGraphs ?? []).toContain('explicit-after-discovery');
      expect((agentA as any).gossipRegistered.has('explicit-after-discovery')).toBe(true);
      expect(persisted.get('explicit-after-discovery')).toMatchObject({
        subscribed: true,
        syncScoped: true,
      });
      expect([...members.values()].some((record) =>
        record.contextGraphId === 'explicit-after-discovery'
          && record.role === 'subscriber'
          && record.status === 'active',
      )).toBe(true);

      agentA.recordDiscoveredContextGraph('explicit-after-discovery', {
        name: 'Authoritative Discovered Name',
        subscribed: false,
        synced: false,
        onChainId: `0x${'a'.repeat(64)}`,
      });
      expect(agentA.getSubscribedContextGraphs().get('explicit-after-discovery')).toMatchObject({
        name: 'Authoritative Discovered Name',
        subscribed: true,
        onChainId: `0x${'a'.repeat(64)}`,
      });
      expect((agentA as any).gossipRegistered.has('explicit-after-discovery')).toBe(true);
    } finally {
      await agentA.stop().catch(() => {});
    }

    const agentB = await DKGAgent.create({
      name: 'DiscoveryBoundaryB',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: subscriptionStore,
      contextGraphMembershipStore: membershipStore,
    });

    try {
      await agentB.start();
      expect(agentB.getSubscribedContextGraphs().has('discovery-only-cg')).toBe(false);
      expect(agentB.getSubscribedContextGraphs().get('explicit-after-discovery')).toMatchObject({
        subscribed: true,
        synced: false,
      });
      expect((agentB as any).config.syncContextGraphs ?? []).toContain('explicit-after-discovery');
    } finally {
      await agentB.stop().catch(() => {});
    }
  }, 30_000);

  it('catalogues public and curated store definitions without activating either graph', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'PassiveStoreDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });

    try {
      await agent.start();
      const publicId = 'store-public-discovery';
      const curatedId = 'store-curated-discovery';
      const publicUri = contextGraphDataGraphUri(publicId);
      const curatedUri = contextGraphDataGraphUri(curatedId);
      await agent.store.insert([
        {
          subject: publicUri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
        },
        {
          subject: publicUri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Store Public Discovery"',
          graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
        },
        {
          subject: curatedUri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: contextGraphMetaGraphUri(curatedId),
        },
        {
          subject: curatedUri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Store Curated Discovery"',
          graph: contextGraphMetaGraphUri(curatedId),
        },
        {
          subject: curatedUri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: contextGraphMetaGraphUri(curatedId),
        },
      ]);

      expect(await agent.discoverContextGraphsFromStore()).toBe(2);
      for (const id of [publicId, curatedId]) {
        expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).toBe(false);
        expect((agent as any).config.syncContextGraphs ?? []).not.toContain(id);
        expect((agent as any).gossipRegistered.has(id)).toBe(false);
        expect(persisted.has(id)).toBe(false);
      }
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('catalogues revealed chain entries while retaining their authoritative ID', async () => {
    const onChainId = `0x${'b'.repeat(64)}`;
    const chain = new MockChainAdapter();
    (chain as any).listContextGraphsFromChain = async () => ([{
      contextGraphId: onChainId,
      name: 'chain-discovery-only',
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'PassiveChainDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });

    try {
      await agent.start();
      expect(await agent.discoverContextGraphsFromChain()).toBe(1);
      expect(agent.getSubscribedContextGraphs().get('chain-discovery-only')).toMatchObject({
        subscribed: false,
        synced: false,
        onChainId,
      });
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain('chain-discovery-only');
      expect((agent as any).gossipRegistered.has('chain-discovery-only')).toBe(false);
      expect(persisted.has('chain-discovery-only')).toBe(false);
      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('acknowledges cursor pages only after authoritative metadata is durably catalogued', async () => {
    const onChainId = `0x${'c'.repeat(64)}`;
    const localId = 'cursor-chain-discovery';
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const chain = new MockChainAdapter();
    let agent: DKGAgent | undefined;
    const acknowledgements: string[] = [];
    (chain as any).scanContextGraphRegistryPages = async function* () {
      yield {
        contextGraphs: [{
          contextGraphId: onChainId,
          name: localId,
          creator: '0x1111111111111111111111111111111111111111',
          accessPolicy: 0,
          blockNumber: 101,
          metadataRevealed: true,
        } satisfies ContextGraphOnChain],
        ack: async () => {
          const entry = agent!.getSubscribedContextGraphs().get(localId);
          expect(entry).toMatchObject({
            subscribed: false,
            synced: false,
            onChainId,
          });
          const durable = await agent!.store.query(`
            ASK WHERE {
              GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
                <${contextGraphDataGraphUri(localId)}>
                  <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId>
                  "${onChainId}" .
              }
            }
          `);
          expect(durable).toEqual({ type: 'boolean', value: true });
          acknowledgements.push('applied-then-acked');
        },
      };
    };

    agent = await DKGAgent.create({
      name: 'PassiveCursorDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });

    try {
      await agent.start();
      expect(await agent.discoverContextGraphsFromChain({
        mode: 'seedFromCursor',
        pageBudget: 1,
      })).toBe(1);
      expect(acknowledgements).toEqual(['applied-then-acked']);
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain(localId);
      expect((agent as any).gossipRegistered.has(localId)).toBe(false);
      expect(persisted.has(localId)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('preserves system subscriptions and explicit local create/write/unsubscribe side effects', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const members = new Map<string, ContextGraphMembershipRecord>();
    const agent = await DKGAgent.create({
      name: 'ExplicitLifecycleBoundary',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      syncContextGraphs: ['configured-default-cg'],
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
      contextGraphMembershipStore: {
        upsert: async (record) => {
          members.set(`${record.contextGraphId}|${record.principalType}|${record.principalId}`, { ...record });
        },
        delete: async (contextGraphId, principalType, principalId) => {
          members.delete(`${contextGraphId}|${principalType}|${principalId}`);
        },
      },
    });

    try {
      await agent.start();
      for (const systemId of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
        expect(agent.getSubscribedContextGraphs().get(systemId)?.subscribed).toBe(true);
        expect((agent as any).gossipRegistered.has(systemId)).toBe(true);
      }
      await agent.ensureContextGraphLocal({
        id: 'configured-default-cg',
        name: 'Configured Default CG',
      });
      expect(agent.getSubscribedContextGraphs().get('configured-default-cg')?.subscribed).toBe(true);
      expect((agent as any).gossipRegistered.has('configured-default-cg')).toBe(true);

      await agent.createContextGraph({
        id: 'explicit-local-create',
        name: 'Explicit Local Create',
      });
      await agent.ensureImplicitSharedMemoryContextGraph('implicit-local-write');
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (const id of ['explicit-local-create', 'implicit-local-write']) {
        expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).toBe(true);
        expect((agent as any).config.syncContextGraphs ?? []).toContain(id);
        expect((agent as any).gossipRegistered.has(id)).toBe(true);
        expect(persisted.get(id)).toMatchObject({ subscribed: true, syncScoped: true });
        expect([...members.values()].some((record) =>
          record.contextGraphId === id && record.status === 'active',
        )).toBe(true);
      }

      agent.unsubscribeFromContextGraph('explicit-local-create');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(agent.getSubscribedContextGraphs().get('explicit-local-create')?.subscribed).toBe(false);
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain('explicit-local-create');
      expect((agent as any).gossipRegistered.has('explicit-local-create')).toBe(false);
      expect(persisted.has('explicit-local-create')).toBe(false);
      expect([...members.values()].some((record) =>
        record.contextGraphId === 'explicit-local-create',
      )).toBe(false);
      expect(agent.getSubscribedContextGraphs().get('implicit-local-write')?.subscribed).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('excludes discovery-only and curated graphs from contextGraphsServed', async () => {
    const agent = await DKGAgent.create({
      name: 'ServedGraphBoundary',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    let capturedProfile: Record<string, unknown> | undefined;

    try {
      await agent.start();
      await agent.createContextGraph({
        id: 'served-public',
        name: 'Served Public',
      });
      await agent.createContextGraph({
        id: 'served-curated',
        name: 'Served Curated',
        accessPolicy: 1,
      });
      agent.recordDiscoveredContextGraph('catalogue-only-public', {
        name: 'Catalogue Only Public',
        subscribed: false,
        synced: false,
      });

      (agent as any).profileManager.publishProfile = async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
      (agent as any).broadcastPublish = async () => undefined;

      await agent.publishProfile();

      expect(capturedProfile?.contextGraphsServed).toEqual(['served-public']);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('keeps legacy cleanup operator-scoped and preserves systems, host mode, and graph data', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'CleanupBoundary',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });
    const clearableId = 'cleanup-clearable';
    const hostedId = 'cleanup-hosted';
    const dataGraph = contextGraphDataGraphUri(clearableId);

    try {
      await agent.start();
      agent.subscribeToContextGraph(clearableId);
      (agent as any).setContextGraphSubscription(hostedId, {
        name: hostedId,
        subscribed: false,
        synced: false,
        coreHosted: true,
      });
      agent.persistContextGraphSubscriptionState(hostedId);
      await agent.store.insert([{
        subject: 'urn:dkg:cleanup:preserved',
        predicate: 'http://schema.org/name',
        object: '"Preserved"',
        graph: dataGraph,
      }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(persisted.has(clearableId)).toBe(true);
      expect(persisted.get(hostedId)?.coreHosted).toBe(true);
      expect(await agent.clearContextGraphSubscriptions()).toBe(1);

      expect(agent.getSubscribedContextGraphs().has(clearableId)).toBe(false);
      expect(persisted.has(clearableId)).toBe(false);
      expect(agent.getSubscribedContextGraphs().get(hostedId)).toMatchObject({
        subscribed: false,
        coreHosted: true,
      });
      expect(persisted.get(hostedId)?.coreHosted).toBe(true);
      for (const systemId of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
        expect(agent.getSubscribedContextGraphs().get(systemId)?.subscribed).toBe(true);
        expect(persisted.has(systemId)).toBe(true);
      }
      const dataPreserved = await agent.store.query(`
        ASK WHERE {
          GRAPH <${dataGraph}> {
            <urn:dkg:cleanup:preserved> <http://schema.org/name> "Preserved" .
          }
        }
      `);
      expect(dataPreserved).toEqual({ type: 'boolean', value: true });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);
});
