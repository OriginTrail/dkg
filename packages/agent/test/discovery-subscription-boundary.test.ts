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
});
