import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  encodePublishRequest,
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
  it('rejects null instead of silently enabling persisted subscription rehydration', async () => {
    await expect(DKGAgent.create({
      name: 'RehydrationNull',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionRehydrationEnabled: null as any,
    })).rejects.toThrow(
      'DKGAgentConfig.contextGraphSubscriptionRehydrationEnabled must be a boolean',
    );
  });

  it.each([
    ['default', undefined],
    ['explicitly enabled', true],
  ] as const)('keeps persisted subscription rehydration %s', async (_label, enabled) => {
    const id = `rehydration-${_label.replace(/\s+/g, '-')}`;
    const record: ContextGraphSubscriptionRecord = {
      id,
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
    };
    const persisted = new Map([[id, { ...record }]]);
    const agent = await DKGAgent.create({
      name: `Rehydration${_label}`,
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: new MockChainAdapter(),
      ...(enabled === undefined
        ? {}
        : { contextGraphSubscriptionRehydrationEnabled: enabled }),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (next) => { persisted.set(next.id, { ...next }); },
        delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
      },
    });

    try {
      await agent.start();
      expect(agent.getSubscribedContextGraphs().get(id)).toMatchObject({
        subscribed: true,
        synced: true,
      });
      expect((agent as any).config.syncContextGraphs ?? []).toContain(id);
      expect((agent as any).gossipRegistered.has(id)).toBe(true);
      expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
        rehydrationEnabled: true,
        persistedTotal: 1,
        activated: 1,
        dormant: 0,
      });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('leaves durable subscriptions dormant and stored content queryable when rehydration is disabled', async () => {
    const subscribedId = 'rehydration-disabled-subscriber';
    const hostedId = 'rehydration-disabled-host';
    const graph = contextGraphDataGraphUri(subscribedId);
    const persisted = new Map<string, ContextGraphSubscriptionRecord>([
      [SYSTEM_CONTEXT_GRAPHS.AGENTS, {
        id: SYSTEM_CONTEXT_GRAPHS.AGENTS,
        subscribed: true,
        synced: true,
        syncScoped: true,
      }],
      [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, {
        id: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        subscribed: true,
        synced: true,
        syncScoped: true,
      }],
      [subscribedId, {
        id: subscribedId,
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        syncScoped: true,
      }],
      [hostedId, {
        id: hostedId,
        subscribed: false,
        synced: true,
        coreHosted: true,
        syncScoped: true,
      }],
    ]);
    const durableBefore = new Map(
      [...persisted.entries()].map(([id, record]) => [id, { ...record }]),
    );
    const deleted: string[] = [];
    const agent = await DKGAgent.create({
      name: 'RehydrationDisabled',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionRehydrationEnabled: false,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (contextGraphId) => {
          deleted.push(contextGraphId);
          persisted.delete(contextGraphId);
        },
      },
    });

    await agent.store.insert([{
      subject: 'urn:dkg:retained-subject',
      predicate: 'urn:dkg:retained-predicate',
      object: '"retained"',
      graph,
    }]);

    try {
      await agent.start();
      for (const id of [subscribedId, hostedId]) {
        expect(agent.getSubscribedContextGraphs().has(id)).toBe(false);
        expect((agent as any).config.syncContextGraphs ?? []).not.toContain(id);
        expect((agent as any).gossipRegistered.has(id)).toBe(false);
        expect(persisted.get(id)).toEqual(durableBefore.get(id));
      }
      for (const systemId of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
        expect(agent.getSubscribedContextGraphs().get(systemId)?.subscribed).toBe(true);
        expect((agent as any).gossipRegistered.has(systemId)).toBe(true);
      }
      expect(deleted).not.toContain(subscribedId);
      expect(deleted).not.toContain(hostedId);
      expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
        rehydrationEnabled: false,
        persistedTotal: 2,
        systemExcluded: 2,
        hostedActivated: 0,
        activated: 0,
        dormant: 2,
        dormantIds: [hostedId, subscribedId],
      });
      expect(await agent.query(`
        ASK WHERE {
          GRAPH <${graph}> {
            <urn:dkg:retained-subject> <urn:dkg:retained-predicate> "retained" .
          }
        }
      `, { contextGraphId: subscribedId })).toEqual({
        bindings: [{ result: 'true' }],
      });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('keeps discovery passive, activates explicit intent, and rehydrates only the explicit subscription', async () => {
    expect([...Object.values(SYSTEM_CONTEXT_GRAPHS)].sort()).toEqual(['agents', 'ontology']);
    expect(AGENT_REGISTRY_CONTEXT_GRAPH).toBe(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const onChainId = '101';

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
      nodeRole: 'edge',
    });

    try {
      await agentA.start();
      for (const systemId of Object.values(SYSTEM_CONTEXT_GRAPHS)) {
        expect(agentA.getSubscribedContextGraphs().get(systemId)?.subscribed).toBe(true);
      }

      for (const id of ['discovery-only-cg', 'explicit-after-discovery']) {
        agentA.recordDiscoveredContextGraph(id, {
          name: id,
        });
      }
      agentA.recordDiscoveredContextGraph('discovery-only-cg', {
        // Runtime hardening: callers compiled against an older API may still
        // pass forbidden state. The central recorder ignores it even though
        // the new discovery metadata type prevents this at compile time.
        coreHosted: true,
        lastReconciledOrdinal: 7,
        pendingMeta: true,
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const discoveryOnly = agentA.getSubscribedContextGraphs().get('discovery-only-cg');
      expect(discoveryOnly?.subscribed).toBe(false);
      expect(discoveryOnly?.coreHosted).toBeUndefined();
      expect(discoveryOnly?.lastReconciledOrdinal).toBeUndefined();
      expect(discoveryOnly?.pendingMeta).toBeUndefined();
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
        onChainId,
      });
      expect(agentA.getSubscribedContextGraphs().get('explicit-after-discovery')).toMatchObject({
        name: 'Authoritative Discovered Name',
        subscribed: true,
        onChainId,
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
      nodeRole: 'edge',
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

  it('applies the edge/core role policy through the real agent-backed ontology gossip handler', async () => {
    for (const role of ['edge', 'core'] as const) {
      const persisted = new Map<string, ContextGraphSubscriptionRecord>();
      const id = `ontology-gossip-${role}`;
      const agent = await DKGAgent.create({
        name: `OntologyGossip${role}`,
        listenHost: '127.0.0.1',
        nodeRole: role,
        chainAdapter: new MockChainAdapter(),
        contextGraphSubscriptionStore: {
          loadAll: async () => [...persisted.values()],
          save: async (record) => { persisted.set(record.id, { ...record }); },
          delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
        },
      });

      try {
        await agent.start();
        const data = encodePublishRequest({
          ual: '',
          nquads: new TextEncoder().encode([
            `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
            `<did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.SCHEMA_NAME}> "Ontology ${role}" <did:dkg:context-graph:${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}> .`,
          ].join('\n')),
          contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
          kas: [],
          publisherIdentity: new Uint8Array(32),
          publisherAddress: '0x1111111111111111111111111111111111111111',
          startKAId: 0,
          endKAId: 0,
          chainId: 'mock:31337',
          publisherSignatureR: new Uint8Array(0),
          publisherSignatureVs: new Uint8Array(0),
        });

        await (agent as any).getOrCreateGossipPublishHandler().handlePublishMessage(
          data,
          SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(agent.getSubscribedContextGraphs().get(id)).toMatchObject({
          name: `Ontology ${role}`,
          subscribed: role === 'core',
          synced: false,
          metaSynced: false,
        });
        expect((agent as any).gossipRegistered.has(id)).toBe(role === 'core');
        expect(((agent as any).config.syncContextGraphs ?? []).includes(id)).toBe(role === 'core');
        expect(persisted.has(id)).toBe(role === 'core');

        const inserted = await agent.store.query(`
          ASK WHERE {
            GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
              <${contextGraphDataGraphUri(id)}>
                <${DKG_ONTOLOGY.RDF_TYPE}>
                <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            }
          }
        `);
        expect(inserted).toEqual({ type: 'boolean', value: true });
      } finally {
        await agent.stop().catch(() => {});
      }
    }
  }, 60_000);

  it('catalogues public and curated store definitions on an edge without activating either graph', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'PassiveStoreDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      nodeRole: 'edge',
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

  it('auto-subscribes a core to public and curated store discoveries', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'CoreStoreDiscovery',
      listenHost: '127.0.0.1',
      nodeRole: 'core',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });

    try {
      await agent.start();
      const publicId = 'core-store-public';
      const curatedId = 'core-store-curated';
      await agent.store.insert([
        {
          subject: contextGraphDataGraphUri(publicId),
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
        },
        {
          subject: contextGraphDataGraphUri(curatedId),
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: contextGraphMetaGraphUri(curatedId),
        },
        {
          subject: contextGraphDataGraphUri(curatedId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: contextGraphMetaGraphUri(curatedId),
        },
      ]);

      expect(await agent.discoverContextGraphsFromStore()).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (const id of [publicId, curatedId]) {
        expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).toBe(true);
        expect((agent as any).gossipRegistered.has(id)).toBe(true);
        expect((agent as any).config.syncContextGraphs ?? []).toContain(id);
        expect(persisted.get(id)).toMatchObject({ subscribed: true, syncScoped: true });
      }

      let capturedProfile: Record<string, unknown> | undefined;
      (agent as any).profileManager.publishProfile = async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
      (agent as any).broadcastPublish = async () => undefined;
      await agent.publishProfile();
      expect(capturedProfile?.contextGraphsServed).toEqual([publicId]);

      agent.unsubscribeFromContextGraph(publicId);
      expect(await agent.discoverContextGraphsFromStore()).toBe(0);
      expect(agent.getSubscribedContextGraphs().get(publicId)?.subscribed).toBe(false);
      expect((agent as any).gossipRegistered.has(publicId)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('catalogues revealed chain entries while retaining their authoritative ID', async () => {
    const onChainId = '202';
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
      nodeRole: 'edge',
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

  it('reverse-resolves the real NameRegistry bytes32 shape before persisting a numeric binding', async () => {
    const localId = 'chain-discovery-real-registry-shape';
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(localId)).toLowerCase();
    const numericOnChainId = 202n;
    const chain = new MockChainAdapter();
    (chain as any).listContextGraphsFromChain = async () => ([{
      // This is the production EVM adapter shape: the legacy field is the
      // NameRegistry bytes32 key, not the ContextGraphStorage slot.
      contextGraphId: nameHash,
      name: localId,
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    const resolvedHashes: string[] = [];
    (chain as any).resolveContextGraphIdByNameHash = async (candidate: string) => {
      resolvedHashes.push(candidate);
      return candidate === nameHash ? numericOnChainId : null;
    };
    const agent = await DKGAgent.create({
      name: 'RealShapeChainDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
      nodeRole: 'edge',
    });

    try {
      await agent.start();
      expect(await agent.discoverContextGraphsFromChain()).toBe(1);
      expect(resolvedHashes).toEqual([nameHash]);
      expect(agent.getSubscribedContextGraphs().get(localId)).toMatchObject({
        subscribed: false,
        onChainId: numericOnChainId.toString(),
        onChainHash: nameHash,
      });

      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const contextGraphUri = contextGraphDataGraphUri(localId);
      const numericBinding = await agent.store.query(`
        ASK WHERE {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${numericOnChainId}" .
          }
        }
      `);
      const hashBinding = await agent.store.query(`
        ASK WHERE {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${nameHash}" .
          }
        }
      `);
      expect(numericBinding).toEqual({ type: 'boolean', value: true });
      expect(hashBinding).toEqual({ type: 'boolean', value: false });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('fails closed before RDF or subscription mutation when a NameRegistry hash has no numeric binding', async () => {
    const localId = 'chain-discovery-unbound-registry-name';
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(localId)).toLowerCase();
    const chain = new MockChainAdapter();
    (chain as any).listContextGraphsFromChain = async () => ([{
      contextGraphId: nameHash,
      name: localId,
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    (chain as any).resolveContextGraphIdByNameHash = async () => null;
    const agent = await DKGAgent.create({
      name: 'UnboundRealShapeChainDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
      nodeRole: 'edge',
    });

    try {
      await agent.start();
      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
      expect(agent.getSubscribedContextGraphs().has(localId)).toBe(false);
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const contextGraphUri = contextGraphDataGraphUri(localId);
      const anyBinding = await agent.store.query(`
        ASK WHERE {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?id .
          }
        }
      `);
      expect(anyBinding).toEqual({ type: 'boolean', value: false });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('rejects revealed metadata whose cleartext does not commit to the registry name hash', async () => {
    const localId = 'chain-discovery-mismatched-reveal';
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes('different-name')).toLowerCase();
    const chain = new MockChainAdapter();
    (chain as any).listContextGraphsFromChain = async () => ([{
      contextGraphId: nameHash,
      name: localId,
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    let resolverCalls = 0;
    (chain as any).resolveContextGraphIdByNameHash = async () => {
      resolverCalls += 1;
      return 203n;
    };
    const agent = await DKGAgent.create({
      name: 'MismatchedRevealChainDiscovery',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
      nodeRole: 'edge',
    });

    try {
      await agent.start();
      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
      expect(resolverCalls).toBe(0);
      expect(agent.getSubscribedContextGraphs().has(localId)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('auto-subscribes a core to chain discovery while preserving the legacy non-sync-scoped mode', async () => {
    const onChainId = '404';
    const localId = 'core-chain-discovery';
    const chain = new MockChainAdapter();
    (chain as any).listContextGraphsFromChain = async () => ([{
      contextGraphId: onChainId,
      name: localId,
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 102,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await DKGAgent.create({
      name: 'CoreChainDiscovery',
      listenHost: '127.0.0.1',
      nodeRole: 'core',
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(agent.getSubscribedContextGraphs().get(localId)).toMatchObject({
        subscribed: true,
        synced: false,
        onChainId,
      });
      expect((agent as any).gossipRegistered.has(localId)).toBe(true);
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain(localId);
      expect(persisted.get(localId)).toMatchObject({ subscribed: true, syncScoped: false });
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('reconstructs an OnChainId-only edge catalogue entry after restart without chain RPC', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-discovery-restart-'));
    const localId = 'restart-chain-catalogue';
    const onChainId = '505';
    const discoveryChain = new MockChainAdapter();
    (discoveryChain as any).listContextGraphsFromChain = async () => ([{
      contextGraphId: onChainId,
      name: localId,
      creator: '0x1111111111111111111111111111111111111111',
      accessPolicy: 0,
      blockNumber: 103,
      metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    let first: DKGAgent | undefined;
    let restarted: DKGAgent | undefined;

    try {
      first = await DKGAgent.create({
        name: 'RestartCatalogueFirst',
        listenHost: '127.0.0.1',
        nodeRole: 'edge',
        chainAdapter: discoveryChain,
        dataDir,
      });
      await first.start();
      expect(await first.discoverContextGraphsFromChain()).toBe(1);
      expect(first.getSubscribedContextGraphs().get(localId)).toMatchObject({
        subscribed: false,
        onChainId,
      });
      await first.stop();
      first = undefined;

      const offlineChain = new MockChainAdapter();
      (offlineChain as any).listContextGraphsFromChain = async () => {
        throw new Error('chain RPC unavailable');
      };
      restarted = await DKGAgent.create({
        name: 'RestartCatalogueOffline',
        listenHost: '127.0.0.1',
        nodeRole: 'edge',
        chainAdapter: offlineChain,
        dataDir,
      });
      await restarted.start();
      expect(await restarted.discoverContextGraphsFromStore()).toBe(1);

      expect(restarted.getSubscribedContextGraphs().get(localId)).toMatchObject({
        name: localId,
        subscribed: false,
        synced: false,
        onChainId,
      });
      expect((restarted as any).gossipRegistered.has(localId)).toBe(false);
      expect((restarted as any).config.syncContextGraphs ?? []).not.toContain(localId);
    } finally {
      await first?.stop().catch(() => {});
      await restarted?.stop().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('resets and persists reconciliation state when discovery changes an active graph binding', async () => {
    const persisted = new Map<string, ContextGraphSubscriptionRecord>();
    const localId = 'discovery-rebind-active';
    const oldOnChainId = '601';
    const newOnChainId = '602';
    const oldOnChainHash = `0x${'3'.repeat(64)}`;
    const agent = await DKGAgent.create({
      name: 'DiscoveryBindingReset',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persisted.values()],
        save: async (record) => { persisted.set(record.id, { ...record }); },
        delete: async (id) => { persisted.delete(id); },
      },
    });

    try {
      await agent.start();
      agent.subscribeToContextGraph(localId);
      (agent as any).setContextGraphSubscription(localId, {
        ...(agent.getSubscribedContextGraphs().get(localId)!),
        onChainId: oldOnChainId,
        onChainHash: oldOnChainHash,
        lastReconciledOrdinal: 7,
      });
      const staleCursor = { watermark: 7, ahead: new Set([8]) };
      (agent as any).reconcileCursors.set(localId, staleCursor);

      agent.recordDiscoveredContextGraph(localId, {
        name: 'Rebound Active Graph',
        onChainId: newOnChainId,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(agent.getSubscribedContextGraphs().get(localId)).toMatchObject({
        name: 'Rebound Active Graph',
        subscribed: true,
        onChainId: newOnChainId,
        lastReconciledOrdinal: 0,
      });
      expect(agent.getSubscribedContextGraphs().get(localId)?.onChainHash).toBeUndefined();
      // The live reconciler may immediately self-prime a fresh cursor after
      // the reset; the stale object must never survive the rebind.
      expect((agent as any).reconcileCursors.get(localId)).not.toBe(staleCursor);
      expect(persisted.get(localId)).toMatchObject({
        subscribed: true,
        onChainId: newOnChainId,
        lastReconciledOrdinal: 0,
      });

      (agent as any).setContextGraphSubscription(localId, {
        ...(agent.getSubscribedContextGraphs().get(localId)!),
        lastReconciledOrdinal: 4,
      });
      const currentCursor = { watermark: 4, ahead: new Set<number>() };
      (agent as any).reconcileCursors.set(localId, currentCursor);
      agent.recordDiscoveredContextGraph(localId, { onChainId: newOnChainId });

      expect(agent.getSubscribedContextGraphs().get(localId)?.lastReconciledOrdinal).toBe(4);
      expect((agent as any).reconcileCursors.get(localId)).toBe(currentCursor);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('acknowledges cursor pages only after authoritative metadata is durably catalogued', async () => {
    const onChainId = '303';
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
      nodeRole: 'edge',
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
      agent.subscribeToContextGraph('implicit-local-write', { syncMode: 'on-demand' });
      expect(agent.getSubscribedContextGraphs().get('implicit-local-write')?.syncMode).toBe('on-demand');
      expect(persisted.has('implicit-local-write')).toBe(false);
      await agent.ensureImplicitSharedMemoryContextGraph('implicit-local-write');
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (const id of ['explicit-local-create', 'implicit-local-write']) {
        expect(agent.getSubscribedContextGraphs().get(id)?.subscribed).toBe(true);
        expect(agent.getSubscribedContextGraphs().get(id)?.syncMode).toBe('always-on');
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
