import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent, type ContextGraphSub, type ContextGraphSubscriptionStore } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphSharedMemoryUri, contextGraphMetaGraphUri, Logger } from '@origintrail-official/dkg-core';
import { type ChainAdapter, type ContextGraphOnChain } from '@origintrail-official/dkg-chain';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

async function createTestAgent(opts?: {
  chainAdapter?: ChainAdapter;
  store?: OxigraphStore;
  contextGraphSubscriptionStore?: ContextGraphSubscriptionStore;
}) {
  const store = opts?.store ?? new OxigraphStore();
  const agent = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name: 'ContextGraphTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: opts?.chainAdapter ?? createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    contextGraphSubscriptionStore: opts?.contextGraphSubscriptionStore,
  });
  return { agent, store };
}

describe('ensureContextGraphLocal', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('creates a contextGraph if it does not exist', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'test-contextGraph', name: 'Test ContextGraph' });

    const exists = await agent.contextGraphExists('test-contextGraph');
    expect(exists).toBe(true);

    const sub = agent.getSubscribedContextGraphs().get('test-contextGraph');
    expect(sub).toBeDefined();
    expect(sub!.subscribed).toBe(true);
    expect(sub!.synced).toBe(true);
    expect(sub!.name).toBe('Test ContextGraph');
  }, 15000);

  it('is idempotent — calling twice does not throw or duplicate triples', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'idem-test', name: 'Idempotent' });
    await agent.ensureContextGraphLocal({ id: 'idem-test', name: 'Idempotent' });

    const exists = await agent.contextGraphExists('idem-test');
    expect(exists).toBe(true);

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const countResult = await result.store.query(`
      SELECT (COUNT(*) AS ?c) WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphDataGraphUri('idem-test')}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}>
        }
      }
    `);
    expect(countResult.type).toBe('bindings');
    if (countResult.type === 'bindings') {
      const count = parseInt(String(countResult.bindings[0]?.['c'] ?? '0').replace(/^"?(\d+).*/, '$1'));
      expect(count).toBe(1);
    }
  }, 15000);

  it('does not throw when chain says "already exists"', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    await agent.createContextGraph({ id: 'pre-existing', name: 'Pre Existing' });

    await agent.ensureContextGraphLocal({ id: 'pre-existing', name: 'Pre Existing' });

    const exists = await agent.contextGraphExists('pre-existing');
    expect(exists).toBe(true);

    const sub = agent.getSubscribedContextGraphs().get('pre-existing');
    expect(sub?.subscribed).toBe(true);
    expect(sub?.synced).toBe(true);
  }, 15000);

  it('handles descriptions with special characters without parser errors', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({
      id: 'special-chars',
      name: 'Special Chars',
      description: 'Default contextGraph: special-chars (test)',
    });

    const exists = await agent.contextGraphExists('special-chars');
    expect(exists).toBe(true);

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'special-chars');
    expect(entry?.description).toBe('Default contextGraph: special-chars (test)');
    expect(entry?.callerInvolved).toBeUndefined();
  }, 15000);

  it('treats storage-backed shared-memory-only graphs as existing', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await store.insert([
      {
        subject: 'urn:workspace-only:test',
        predicate: 'http://schema.org/name',
        object: '"Workspace Only"',
        graph: contextGraphSharedMemoryUri('workspace-only'),
      },
    ]);

    await expect(agent.contextGraphExists('workspace-only')).resolves.toBe(true);
  }, 15000);

  it('probes write preflight policy and curator declarations from the AGENTS graph', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    const contextGraphId = 'agents-declared-private';
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const caller = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;

    await store.insert([
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: agentsGraph,
      },
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: agentsGraph,
      },
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_CURATOR,
        object: `did:dkg:agent:${caller}`,
        graph: agentsGraph,
      },
    ]);

    const allowlistSpy = vi
      .spyOn(agent, 'callerIsAllowlistedAgentParticipant')
      .mockRejectedValue(new Error('allowlist lookup should be skipped for curator'));

    const probe = await agent.probeContextGraphWritePreflight(contextGraphId, {
      callerAgentAddress: caller,
    });

    expect(probe).toMatchObject({
      exists: true,
      declarationFound: true,
      accessPolicy: 'private',
      callerAuthorized: true,
    });
    expect(allowlistSpy).not.toHaveBeenCalled();
  }, 15000);

  it('does not scan loadAll during exact write preflight when indexed subscription load is unavailable', async () => {
    const loadAll = vi.fn(async () => {
      throw new Error('loadAll scan should not run in write preflight');
    });
    const result = await createTestAgent({
      contextGraphSubscriptionStore: {
        loadAll,
        save: async () => {},
        delete: async () => {},
      },
    });
    agent = result.agent;

    const probe = await agent.probeContextGraphWritePreflight('loadless-cg');

    expect(loadAll).not.toHaveBeenCalled();
    expect(probe.persistedSubscription).toBeUndefined();
  }, 15000);
});

describe('implicit SWM context graph metadata', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('direct share to a fresh context graph registers useful public metadata', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const contextGraphId = 'lazy-swm-direct';
    const caller = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;

    await agent.share(contextGraphId, [
      {
        subject: 'urn:lazy-swm-direct:root',
        predicate: 'http://schema.org/name',
        object: '"Lazy SWM Direct"',
        graph: '',
      },
    ], { callerAgentAddress: caller });

    const contextGraphs = await agent.listContextGraphs({ callerAgentAddress: caller });
    const entry = contextGraphs.find(p => p.id === contextGraphId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: contextGraphId,
      uri: contextGraphDataGraphUri(contextGraphId),
      name: contextGraphId,
      creator: `did:dkg:agent:${agent.peerId}`,
      curator: `did:dkg:agent:${caller}`,
      accessPolicy: 'public',
      isSystem: false,
      subscribed: true,
      synced: true,
      callerInvolved: true,
    });
    expect(Date.parse(entry!.createdAt!)).not.toBeNaN();

    const sub = agent.getSubscribedContextGraphs().get(contextGraphId);
    expect(sub).toMatchObject({
      name: contextGraphId,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });
  }, 15000);

  it('does not overwrite an explicitly created context graph on later SWM writes', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const contextGraphId = 'lazy-swm-explicit';
    const caller = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Explicit Private Context',
      accessPolicy: 1,
      allowedAgents: [caller],
      callerAgentAddress: caller,
    });

    const before = (await agent.listContextGraphs({ callerAgentAddress: caller }))
      .find(p => p.id === contextGraphId);
    expect(before).toBeDefined();

    await agent.share(contextGraphId, [
      {
        subject: 'urn:lazy-swm-explicit:root',
        predicate: 'http://schema.org/name',
        object: '"Preserve Explicit"',
        graph: '',
      },
    ], { localOnly: true, callerAgentAddress: caller });

    const after = (await agent.listContextGraphs({ callerAgentAddress: caller }))
      .find(p => p.id === contextGraphId);
    expect(after).toBeDefined();
    expect(after!.name).toBe('Explicit Private Context');
    expect(after!.accessPolicy).toBe('private');
    expect(after!.curator).toBe(`did:dkg:agent:${caller}`);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.callerInvolved).toBe(true);
  }, 15000);

  it('ignores non-authoritative user triples when deciding whether metadata exists', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const contextGraphId = 'lazy-swm-user-type-triple';
    await result.store.insert([{
      subject: contextGraphDataGraphUri(contextGraphId),
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: contextGraphSharedMemoryUri(contextGraphId),
    }]);

    await agent.share(contextGraphId, [
      {
        subject: 'urn:lazy-swm-user-type-triple:root',
        predicate: 'http://schema.org/name',
        object: '"User Authored Type"',
        graph: '',
      },
    ], { localOnly: true });

    const entry = (await agent.listContextGraphs()).find(p => p.id === contextGraphId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: contextGraphId,
      name: contextGraphId,
      accessPolicy: 'public',
      subscribed: true,
      synced: true,
    });
    expect(Date.parse(entry!.createdAt!)).not.toBeNaN();
  }, 15000);
});

describe('discoverContextGraphsFromStore', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers contextGraphs from ONTOLOGY graph without auto-subscribing', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri('discovered-contextGraph');
    await store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Discovered ContextGraph"', graph: ontologyGraph },
    ]);

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(1);

    const sub = agent.getSubscribedContextGraphs().get('discovered-contextGraph');
    expect(sub).toBeDefined();
    expect(sub!.subscribed).toBe(false);
    // `synced` now means "actual CG data was pulled from a peer" — not
    // "we saw the definition triple from gossip." Discovery from the
    // store leaves us with the declaration only, so `synced` stays
    // false until the catchup runner flips it.
    expect(sub!.synced).toBe(false);
    expect(sub!.name).toBe('Discovered ContextGraph');
  }, 15000);

  it('does not re-discover already known contextGraphs', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'already-known', name: 'Already Known' });

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(0);
  }, 15000);

  it('skips system contextGraphs (agents, ontology)', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(0);
  }, 15000);
});

describe('listContextGraphs merge', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('returns synced contextGraphs with subscribed=true', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'synced-contextGraph', name: 'Synced' });

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'synced-contextGraph');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(true);
    expect(entry!.name).toBe('Synced');
    expect(entry!.callerInvolved).toBeUndefined();
  }, 15000);

  it('includes subscribed-but-not-synced contextGraphs from registry', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToContextGraph('chain-only');
    (agent as any).subscribedContextGraphs.set('chain-only', {
      name: 'Chain Only',
      subscribed: true,
      synced: false,
      onChainId: '0xabc123',
    });

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'chain-only');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(false);
    expect(entry!.name).toBe('Chain Only');
    expect(entry!.callerInvolved).toBeUndefined();
  }, 15000);

  // Regression for the "chatt-test takes ~107s to appear in the sidebar
  // after curator approval" bug. A curated CG has no on-chain ID and no
  // local content the moment we receive `join-approved` — until the first
  // meta sync completes. Without `pendingMeta`, the case-2 phantom filter
  // hides the entry entirely. With it, the entry surfaces with
  // synced=false so the UI's existing "waiting for sync" badge fires
  // immediately on approval.
  it('includes curator-approved CGs with pendingMeta (no on-chain ID, no local content yet)', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToContextGraph('curator-only');
    (agent as any).subscribedContextGraphs.set('curator-only', {
      name: 'Curator Only',
      subscribed: true,
      synced: false,
      pendingMeta: true,
    } satisfies ContextGraphSub);

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'curator-only');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(false);
    expect(entry!.name).toBe('Curator Only');
    expect(entry!.onChainId).toBeUndefined();
  }, 15000);

  // Symmetric guard: a stale subscription with neither onChainId nor
  // pendingMeta nor local content stays hidden as a phantom — the
  // pendingMeta flag must not weaken the existing phantom filter for
  // entries that don't actually have it set.
  it('still hides phantom subscriptions (no onChainId, no pendingMeta, no local content)', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToContextGraph('phantom-cg');
    (agent as any).subscribedContextGraphs.set('phantom-cg', {
      name: 'Phantom',
      subscribed: true,
      synced: false,
    } satisfies ContextGraphSub);

    const contextGraphs = await agent.listContextGraphs();
    expect(contextGraphs.find(p => p.id === 'phantom-cg')).toBeUndefined();
  }, 15000);

  it('marks SPARQL-only contextGraphs (not in registry) as subscribed=false', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri('unsubscribed');
    await store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Unsubscribed"', graph: ontologyGraph },
    ]);

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'unsubscribed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(false);
    // SPARQL-only discovery (definition triple from ONTOLOGY) leaves
    // `synced=false` — see the same expectation comment in the
    // "discovers contextGraphs from ONTOLOGY graph" case above.
    expect(entry!.synced).toBe(false);
    expect(entry!.callerInvolved).toBeUndefined();
  }, 15000);

  it('includes storage-only context graphs when shared memory graphs exist', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await store.insert([
      {
        subject: 'urn:workspace-only:test',
        predicate: 'http://schema.org/name',
        object: '"Workspace Only"',
        graph: contextGraphSharedMemoryUri('workspace-only'),
      },
    ]);

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'workspace-only');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('workspace-only');
    expect(entry!.subscribed).toBe(false);
    expect(entry!.synced).toBe(false);
    expect(entry!.callerInvolved).toBeUndefined();
  }, 15000);

  it('listContextGraphs sets callerInvolved from curator wallet match', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();
    await agent.createContextGraph({ id: 'owned-cg', name: 'Owned' });
    const wallet = agent.getDefaultAgentAddress();
    expect(wallet).toBeDefined();

    const noCaller = await agent.listContextGraphs();
    expect(noCaller.find(p => p.id === 'owned-cg')?.callerInvolved).toBeUndefined();

    const mine = await agent.listContextGraphs({ callerAgentAddress: wallet });
    expect(mine.find(p => p.id === 'owned-cg')?.callerInvolved).toBe(true);

    const otherWallet = ethers.Wallet.createRandom().address;
    const notMine = await agent.listContextGraphs({ callerAgentAddress: otherWallet });
    expect(notMine.find(p => p.id === 'owned-cg')?.callerInvolved).toBe(false);
  }, 15000);

  it('listContextGraphs hides curated CGs from non-members', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const myWallet = agent.getDefaultAgentAddress()!;
    await agent.createContextGraph({
      id: 'my-curated',
      name: 'My Curated',
      accessPolicy: 1,
      allowedAgents: [myWallet],
    });

    const otherWallet = ethers.Wallet.createRandom().address;
    const fromStranger = await agent.listContextGraphs({ callerAgentAddress: otherWallet });
    expect(fromStranger.find(p => p.id === 'my-curated')).toBeUndefined();

    const fromCurator = await agent.listContextGraphs({ callerAgentAddress: myWallet });
    expect(fromCurator.find(p => p.id === 'my-curated')).toBeDefined();

    const unauthenticated = await agent.listContextGraphs();
    expect(unauthenticated.find(p => p.id === 'my-curated')).toBeUndefined();
  }, 15000);

  it('does not reject the whole list when one row enrichment fails', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    await store.insert([
      {
        subject: contextGraphDataGraphUri('healthy-enrichment-row'),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri('healthy-enrichment-row'),
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Healthy Row"',
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri('healthy-enrichment-row'),
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri('broken-enrichment-row'),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri('broken-enrichment-row'),
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Broken Row"',
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri('broken-enrichment-row'),
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);

    vi.spyOn(agent as any, 'getContextGraphOnChainId').mockImplementation(async (id: string) => {
      if (id === 'broken-enrichment-row') return new Promise<undefined>(() => {});
      return undefined;
    });

    const contextGraphs = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(contextGraphs.find(p => p.id === 'healthy-enrichment-row')).toBeDefined();
    expect(contextGraphs.find(p => p.id === 'broken-enrichment-row')).toBeDefined();
  }, 15000);

  it('drops subscribed rows from scoped output when policy enrichment times out', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const id = 'degraded-private-cg';
    const metaGraph = contextGraphMetaGraphUri(id);
    const contextGraphUri = contextGraphDataGraphUri(id);
    await store.insert([
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: metaGraph,
      },
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Degraded Private"',
        graph: metaGraph,
      },
      {
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: metaGraph,
      },
    ]);
    (agent as any).subscribedContextGraphs.set(id, {
      name: 'Degraded Private',
      subscribed: true,
      synced: false,
      pendingMeta: true,
    } satisfies ContextGraphSub);

    const originalQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (query: string) => {
      if (query.includes(`<${metaGraph}>`) && query.includes('SELECT ?name ?desc ?creator ?created ?curator ?access')) {
        return new Promise<any>(() => {});
      }
      return originalQuery(query);
    });

    const stranger = ethers.Wallet.createRandom().address;
    const fromStranger = await agent.listContextGraphs({ callerAgentAddress: stranger });
    expect(fromStranger.find(p => p.id === id)).toBeUndefined();

    const noWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(noWallet.find(p => p.id === id)).toBeUndefined();
  }, 15000);

  it('invalidates cached scoped results when remote meta sync writes policy metadata', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'remote-meta-cache-cg';
    (agent as any).subscribedContextGraphs.set(id, {
      name: 'Remote Meta Cache',
      subscribed: true,
      synced: false,
      pendingMeta: true,
    } satisfies ContextGraphSub);

    const first = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(first.find(p => p.id === id)).toBeUndefined();

    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    await (agent as any).insertSyncedQuadsAndInvalidateListCache([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: metaGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: metaGraph,
      },
    ]);

    const second = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(second.find(p => p.id === id)).toBeDefined();
  }, 15000);

  it('drops map-state tail rows from scoped output when no policy literal was read', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'policy-unknown-tail-cg';
    (agent as any).subscribedContextGraphs.set(id, {
      name: 'Policy Unknown Tail',
      subscribed: true,
      synced: false,
      onChainId: '0xabc123',
    } satisfies ContextGraphSub);

    const scoped = await agent.listContextGraphs({ callerAgentAddress: ethers.Wallet.createRandom().address });
    expect(scoped.find(p => p.id === id)).toBeUndefined();

    const explicitNoWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(explicitNoWallet.find(p => p.id === id)).toBeUndefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === id)).toBeDefined();
  }, 15000);

  it('drops storage-only rows from scoped output when policy enrichment times out', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await store.insert([
      {
        subject: 'urn:workspace-only:policy-unknown',
        predicate: 'http://schema.org/name',
        object: '"Policy Unknown"',
        graph: contextGraphSharedMemoryUri('policy-unknown-storage'),
      },
    ]);

    const originalQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (query: string) => {
      if (query.includes('SELECT ?policy WHERE') && query.includes(DKG_ONTOLOGY.DKG_ACCESS_POLICY)) {
        return new Promise<any>(() => {});
      }
      return originalQuery(query);
    });

    const explicitNoWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(explicitNoWallet.find(p => p.id === 'policy-unknown-storage')).toBeUndefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === 'policy-unknown-storage')).toBeDefined();
  }, 15000);

  it('drops storage-only rows from scoped output when no explicit policy exists', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await store.insert([
      {
        subject: 'urn:workspace-only:policy-absent',
        predicate: 'http://schema.org/name',
        object: '"Policy Absent"',
        graph: contextGraphSharedMemoryUri('policy-absent-storage'),
      },
    ]);

    const explicitNoWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(explicitNoWallet.find(p => p.id === 'policy-absent-storage')).toBeUndefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === 'policy-absent-storage')).toBeDefined();
  }, 15000);

  it('does not cache private membership misses when allowlist lookup degrades', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'allowlist-unknown-cache-cg';
    const member = ethers.Wallet.createRandom().address;
    await agent.createContextGraph({
      id,
      name: 'Allowlist Unknown Cache',
      accessPolicy: 1,
      allowedAgents: [member],
    });

    const originalAllowlist = agent.callerIsAllowlistedAgentParticipant.bind(agent);
    let targetCalls = 0;
    vi.spyOn(agent, 'callerIsAllowlistedAgentParticipant').mockImplementation(async (contextGraphId, caller) => {
      if (contextGraphId === id && ethers.getAddress(caller) === ethers.getAddress(member)) {
        targetCalls += 1;
        if (targetCalls === 1) return new Promise<boolean>(() => {});
        return true;
      }
      return originalAllowlist(contextGraphId, caller);
    });

    const first = await agent.listContextGraphs({ callerAgentAddress: member });
    expect(first.find(p => p.id === id)).toBeUndefined();

    const second = await agent.listContextGraphs({ callerAgentAddress: member });
    const entry = second.find(p => p.id === id);
    expect(entry).toBeDefined();
    expect(entry!.callerInvolved).toBe(true);
    expect(targetCalls).toBe(2);
  }, 15000);

  it('rejects scoped list calls when allowlist lookup fails with a real error', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'allowlist-real-error-cg';
    const stranger = ethers.Wallet.createRandom().address;
    await agent.createContextGraph({
      id,
      name: 'Allowlist Real Error',
      accessPolicy: 1,
      allowedAgents: [agent.getDefaultAgentAddress()!],
    });

    vi.spyOn(agent, 'callerIsAllowlistedAgentParticipant').mockImplementation(async (contextGraphId, caller) => {
      if (contextGraphId === id && ethers.getAddress(caller) === ethers.getAddress(stranger)) {
        throw new Error('simulated store failure');
      }
      return false;
    });

    await expect(agent.listContextGraphs({ callerAgentAddress: stranger }))
      .rejects.toThrow('simulated store failure');
  }, 15000);

  it('invalidates wallet-scoped cached list results after agent revocation', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const owner = agent.getDefaultAgentAddress()!;
    const member = ethers.Wallet.createRandom().address;
    await agent.createContextGraph({
      id: 'cached-revoke-cg',
      name: 'Cached Revoke',
      accessPolicy: 1,
      allowedAgents: [member],
    });

    const before = await agent.listContextGraphs({ callerAgentAddress: member });
    expect(before.find(p => p.id === 'cached-revoke-cg')).toBeDefined();

    await agent.removeAgentFromContextGraph('cached-revoke-cg', member, owner);

    const after = await agent.listContextGraphs({ callerAgentAddress: member });
    expect(after.find(p => p.id === 'cached-revoke-cg')).toBeUndefined();
  }, 15000);

  it('invalidates wallet-scoped cached misses after agent invitation', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const owner = agent.getDefaultAgentAddress()!;
    const member = ethers.Wallet.createRandom().address;
    await agent.createContextGraph({
      id: 'cached-invite-cg',
      name: 'Cached Invite',
      accessPolicy: 1,
    });

    const before = await agent.listContextGraphs({ callerAgentAddress: member });
    expect(before.find(p => p.id === 'cached-invite-cg')).toBeUndefined();

    await agent.inviteAgentToContextGraph('cached-invite-cg', member, owner);

    const after = await agent.listContextGraphs({ callerAgentAddress: member });
    expect(after.find(p => p.id === 'cached-invite-cg')).toBeDefined();
  }, 15000);

  it('single-flights same-scope list calls, caches results, and invalidates on subscription changes', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const originalQuery = store.query.bind(store);
    let releaseDefinitionScan: (() => void) | undefined;
    const definitionScanGate = new Promise<void>((resolve) => {
      releaseDefinitionScan = resolve;
    });
    let definitionScans = 0;
    vi.spyOn(store, 'query').mockImplementation(async (query: string) => {
      if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem')) {
        definitionScans += 1;
        if (definitionScans === 1) {
          await definitionScanGate;
        }
      }
      return originalQuery(query);
    });

    const first = agent.listContextGraphs({ callerAgentAddress: null });
    const second = agent.listContextGraphs({ callerAgentAddress: null });
    await Promise.resolve();
    expect(definitionScans).toBe(1);
    releaseDefinitionScan?.();
    await Promise.all([first, second]);

    await agent.listContextGraphs({ callerAgentAddress: null });
    expect(definitionScans).toBe(1);

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const invalidatedUri = contextGraphDataGraphUri('cache-invalidated-cg');
    await store.insert([
      {
        subject: invalidatedUri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: invalidatedUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);
    (agent as any).setContextGraphSubscription('cache-invalidated-cg', {
      name: 'Cache Invalidated',
      subscribed: true,
      synced: false,
      onChainId: '0xabc123',
    } satisfies ContextGraphSub, { persist: false });

    const afterInvalidation = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(definitionScans).toBe(2);
    expect(afterInvalidation.find(p => p.id === 'cache-invalidated-cg')).toBeDefined();
  }, 15000);
});

describe('discoverContextGraphsFromChain', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers on-chain contextGraphs with cleartext name and auto-subscribes', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
        name: 'test-revealed',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: true,
      },
    ] satisfies ContextGraphOnChain[]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(1);

    const subs = agent.getSubscribedContextGraphs();
    const entry = subs.get('test-revealed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(false);
    expect(entry!.onChainId).toBe('0xdeadbeef00000000000000000000000000000000000000000000000000000001');
  }, 15000);

  it('skips auto-subscribe to revealed curated chain entries when not curator', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '0xcafebabe00000000000000000000000000000000000000000000000000000003',
        name: 'leaked-curated',
        creator: '0x000000000000000000000000000000000000dEaD',
        accessPolicy: 1,
        blockNumber: 100,
        metadataRevealed: true,
      },
    ] satisfies ContextGraphOnChain[]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(0);

    const subs = agent.getSubscribedContextGraphs();
    expect(subs.get('leaked-curated')).toBeUndefined();
  }, 15000);

  it('skips hash-only on-chain contextGraphs without metadata', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '0xdeadbeef00000000000000000000000000000000000000000000000000000002',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: false,
      },
    ] satisfies ContextGraphOnChain[]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(0);

    const subs = agent.getSubscribedContextGraphs();
    const ghost = [...subs.entries()].find(([id]) => id.startsWith('0x'));
    expect(ghost).toBeUndefined();
  }, 15000);

  it('skips already known on-chain contextGraphs', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '0xaaa',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 50,
        metadataRevealed: false,
      },
    ] satisfies ContextGraphOnChain[]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    (agent as any).subscribedContextGraphs.set('known', {
      name: 'Known',
      subscribed: true,
      synced: true,
      onChainId: '0xaaa',
    });

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(0);
  }, 15000);

  it('returns 0 when chain adapter has no listContextGraphsFromChain', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => [];

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(0);
  }, 15000);

  it('keeps full chain discovery as the default and makes incremental opt-in', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const calls: unknown[] = [];
    (chain as any).listContextGraphsFromChain = async (_fromBlock?: number, options?: unknown) => {
      calls.push(options);
      return [];
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ incremental: true })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ seedIncrementalWatermark: true })).toBe(0);

    expect(calls).toEqual([undefined, { incremental: true }, { seedIncrementalWatermark: true }]);
  }, 15000);

  it('warns once for repeated chain scan failures and logs recovery', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    let fail = true;
    (chain as any).listContextGraphsFromChain = async () => {
      if (fail) throw new Error('range too wide [0, 1999]');
      return [];
    };
    const entries: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => entries.push({ level: entry.level, message: entry.message }));
    try {
      const result = await createTestAgent({ chainAdapter: chain });
      agent = result.agent;
      await agent.start();

      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
      fail = false;
      expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    } finally {
      Logger.setSink(null);
    }

    const warnings = entries.filter((entry) =>
      entry.level === 'warn' && entry.message.includes('Chain context graph scan failed'),
    );
    expect(warnings).toHaveLength(1);
    expect(entries.some((entry) =>
      entry.level === 'info' && entry.message.includes('Chain context graph scan recovered after 2 failed attempt(s)'),
    )).toBe(true);
  }, 15000);

  it('can surface chain scan failures for daemon seed retries without changing the default contract', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const failure = new Error('seed scan failed');
    (chain as any).listContextGraphsFromChain = async () => {
      throw failure;
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    await expect(
      agent.discoverContextGraphsFromChain({
        seedIncrementalWatermark: true,
        throwOnChainScanFailure: true,
      }),
    ).rejects.toThrow('seed scan failed');
  }, 15000);

  it('processes partial chain scan prefixes without marking the scan recovered', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    let calls = 0;
    (chain as any).listContextGraphsFromChain = async () => {
      calls += 1;
      const stopped = calls === 1 ? 1_999 : 3_999;
      const failedFrom = calls === 1 ? 2_000 : 4_000;
      const failedTo = calls === 1 ? 3_999 : 5_999;
      const err = new Error(
        `partial ContextGraphNameRegistry scan stopped after block ${stopped}; ` +
          `failed page [${failedFrom}, ${failedTo}]: range too wide`,
      ) as Error & {
        partialResults: ContextGraphOnChain[];
        scannedToBlock: number;
        failedFromBlock: number;
        failedToBlock: number;
      };
      err.name = 'ContextGraphChainScanPartialError';
      err.partialResults = [
        {
          contextGraphId: '0xfeedbeef00000000000000000000000000000000000000000000000000000001',
          name: 'partial-revealed',
          creator: '0x1234',
          accessPolicy: 0,
          blockNumber: 100,
          metadataRevealed: true,
        },
      ];
      err.scannedToBlock = stopped;
      err.failedFromBlock = failedFrom;
      err.failedToBlock = failedTo;
      throw err;
    };
    const entries: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => entries.push({ level: entry.level, message: entry.message }));
    try {
      const result = await createTestAgent({ chainAdapter: chain });
      agent = result.agent;
      await agent.start();

      await expect(agent.discoverContextGraphsFromChain({
        incremental: true,
        throwOnChainScanFailure: true,
      })).rejects.toThrow('partial ContextGraphNameRegistry scan');
      expect(await agent.discoverContextGraphsFromChain({ incremental: true })).toBe(0);
    } finally {
      Logger.setSink(null);
    }

    const entry = agent!.getSubscribedContextGraphs().get('partial-revealed');
    expect(entry).toBeDefined();
    expect(entry!.onChainId).toBe('0xfeedbeef00000000000000000000000000000000000000000000000000000001');
    expect((agent as any).chainContextGraphScanFailure?.count).toBe(2);
    const warnings = entries.filter((entry) =>
      entry.level === 'warn' && entry.message.includes('Chain context graph scan failed'),
    );
    expect(warnings).toHaveLength(1);
    expect(entries.some((entry) =>
      entry.level === 'info' && entry.message.includes('Chain context graph scan recovered'),
    )).toBe(false);
  }, 15000);
});

describe('discoverContextGraphsFromStore', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers curated context graphs from _meta definitions without auto-subscribing', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const curatedId = 'curated-meta-only';
    const contextGraphUri = contextGraphDataGraphUri(curatedId);
    await store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphMetaGraphUri(curatedId) },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Curated Meta Only"', graph: contextGraphMetaGraphUri(curatedId) },
    ]);

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(1);

    const entry = agent.getSubscribedContextGraphs().get(curatedId);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('Curated Meta Only');
    expect(entry!.subscribed).toBe(false);
    // `synced=false` — discovery from the _meta store gives us the
    // definition triple but not actual CG data. `metaSynced=true` is
    // the right flag for "we have the curated _meta allowlist."
    expect(entry!.synced).toBe(false);
    expect(entry!.metaSynced).toBe(true);
  }, 15000);
});

describe('getSubscribedContextGraphs', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('tracks subscriptions from subscribeToContextGraph', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToContextGraph('manual-sub');

    const subs = agent.getSubscribedContextGraphs();
    const entry = subs.get('manual-sub');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
  }, 15000);

  it('tracks subscriptions from createContextGraph', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.createContextGraph({ id: 'created-p', name: 'Created' });

    const subs = agent.getSubscribedContextGraphs();
    const entry = subs.get('created-p');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(true);
    expect(entry!.name).toBe('Created');
  }, 15000);
});

describe('hash-vs-name duplication regression', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('chain discovery then ontology sync produces one merged entry, no ghost 0x contextGraph', async () => {
    const localName = 'merged-contextGraph';
    const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(localName));

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: expectedHash,
        name: localName,
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: true,
      },
    ] satisfies ContextGraphOnChain[]);

    const store = new OxigraphStore();
    const result = await createTestAgent({ chainAdapter: chain, store });
    agent = result.agent;
    await agent.start();

    const chainDiscovered = await agent.discoverContextGraphsFromChain();
    expect(chainDiscovered).toBe(1);

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri(localName);
    await store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${localName}"`, graph: ontologyGraph },
    ]);
    const storeDiscovered = await agent.discoverContextGraphsFromStore();
    expect(storeDiscovered).toBeLessThanOrEqual(1);

    const contextGraphs = await agent.listContextGraphs();
    const matches = contextGraphs.filter(p => p.id === localName || p.id === expectedHash);
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(localName);
    expect(matches[0].subscribed).toBe(true);
    // Chain + ontology discovery only deliver definition metadata —
    // no actual CG data has been pulled from a peer, so `synced`
    // stays false until the catchup runner flips it.
    expect(matches[0].synced).toBe(false);
    expect(matches[0].callerInvolved).toBeUndefined();

    const ghosts = contextGraphs.filter(p => p.id.startsWith('0x'));
    expect(ghosts.length).toBe(0);
  }, 15000);
});

// Direct unit coverage for the post-approval sync method introduced
// alongside `pendingMeta`. Stubs `ensurePeerConnected`,
// `node.libp2p.getConnections`, `runCatchupOverPeers`, and
// `syncContextGraphFromConnectedPeers` directly on the live agent
// instance so we exercise the real branching logic without standing
// up a second libp2p node + catchup pipeline. Mirrors the existing
// `(agent as any).subscribedContextGraphs.set(...)` precedent.
describe('runImmediatePostApprovalSync', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  const CURATOR_PEER = '12D3KooWFakeCuratorPeerForRunImmediatePostApprovalSyncTest';

  function installStubs(a: DKGAgent, opts: {
    ensurePeerConnected?: (pid: string) => Promise<void>;
    connectedPeers?: string[];
    runCatchupResult?: {
      peersSucceeded: number;
      dataSynced: number;
      sharedMemorySynced: number;
      denied: boolean;
    };
    runCatchupThrows?: Error;
    broadcastThrows?: Error;
  }) {
    const calls = {
      ensurePeerConnectedCalls: [] as string[],
      runCatchupCalls: [] as Array<{ cg: string; includeSwm: boolean; peers: string[] }>,
      broadcastCalls: [] as Array<{ cg: string; includeSwm: boolean }>,
    };
    (a as any).ensurePeerConnected = async (pid: string) => {
      calls.ensurePeerConnectedCalls.push(pid);
      if (opts.ensurePeerConnected) await opts.ensurePeerConnected(pid);
    };
    (a as any).node.libp2p.getConnections = () =>
      (opts.connectedPeers ?? []).map((pid) => ({
        remotePeer: { toString: () => pid },
      }));
    (a as any).runCatchupOverPeers = async (
      cg: string,
      includeSwm: boolean,
      peers: Array<{ toString(): string }>,
    ) => {
      calls.runCatchupCalls.push({
        cg,
        includeSwm,
        peers: peers.map((p) => p.toString()),
      });
      if (opts.runCatchupThrows) throw opts.runCatchupThrows;
      return {
        connectedPeers: 1,
        syncCapablePeers: 1,
        peersTried: 1,
        peersSucceeded: opts.runCatchupResult?.peersSucceeded ?? 0,
        dataSynced: opts.runCatchupResult?.dataSynced ?? 0,
        sharedMemorySynced: opts.runCatchupResult?.sharedMemorySynced ?? 0,
        denied: opts.runCatchupResult?.denied ?? false,
        diagnostics: { noProtocolPeers: 0 } as any,
      };
    };
    (a as any).syncContextGraphFromConnectedPeers = async (
      cg: string,
      sopts?: { includeSharedMemory?: boolean },
    ) => {
      calls.broadcastCalls.push({ cg, includeSwm: sopts?.includeSharedMemory ?? false });
      if (opts.broadcastThrows) throw opts.broadcastThrows;
    };
    return calls;
  }

  it('uses curator-direct catchup when curator is connected and skips broadcast on success', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      runCatchupResult: { peersSucceeded: 1, dataSynced: 7, sharedMemorySynced: 11, denied: false },
    });

    await (agent as any).runImmediatePostApprovalSync('test-cg-success', CURATOR_PEER);

    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.runCatchupCalls).toHaveLength(1);
    expect(calls.runCatchupCalls[0]).toMatchObject({
      cg: 'test-cg-success',
      includeSwm: true,
      peers: [CURATOR_PEER],
    });
    expect(calls.broadcastCalls).toHaveLength(0);
  }, 15000);

  it('falls back to broadcast when curator is not in connected peers after ensurePeerConnected', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [],
    });

    await (agent as any).runImmediatePostApprovalSync('test-cg-missing-peer', CURATOR_PEER);

    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toHaveLength(1);
    expect(calls.broadcastCalls[0]).toMatchObject({
      cg: 'test-cg-missing-peer',
      includeSwm: true,
    });
  }, 15000);

  // 🔴 Regression for the Lex-on-PR-#517 round-2 / Codex finding: the
  // join-approved handler must leave `metaSynced: false` (not undefined)
  // alongside `pendingMeta: true`, otherwise the strict-equality safety
  // guards in `shouldCreateImplicitSharedMemoryContextGraph` and the
  // curated gossip pre-meta gate (`metaSynced === false`) silently fall
  // through and a freshly-approved private CG can be inferred as public
  // locally during the window before _meta arrives. This test asserts
  // the guard fires given the exact subscription shape the join-approved
  // handler should produce — catches a future refactor that drops
  // `metaSynced: false` from that call site.
  it('shouldCreateImplicitSharedMemoryContextGraph rejects when pendingMeta+metaSynced:false', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToContextGraph('curated-cg-pendingmeta');
    (agent as any).subscribedContextGraphs.set('curated-cg-pendingmeta', {
      name: 'Curated CG',
      subscribed: true,
      synced: false,
      pendingMeta: true,
      metaSynced: false,
    } satisfies ContextGraphSub);

    await expect(
      (agent as any).shouldCreateImplicitSharedMemoryContextGraph('curated-cg-pendingmeta'),
    ).rejects.toThrow(/awaiting metadata sync/);
  }, 15000);

  // 🔴 Regression for the Lex-on-PR-#517 / Codex catch-block finding.
  // If `ensurePeerConnected` throws (relay flap, dial timeout, abort),
  // the broadcast fallback MUST still run — wrapping curator-direct
  // and broadcast in a single try/catch reintroduces the silent-stall
  // bug this method was added to close.
  it('falls back to broadcast when ensurePeerConnected throws (regression for catch-block bug)', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      ensurePeerConnected: async () => {
        throw new Error('Remote closed connection during opening');
      },
      connectedPeers: [CURATOR_PEER],
    });

    await (agent as any).runImmediatePostApprovalSync('test-cg-throw', CURATOR_PEER);

    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toHaveLength(1);
    expect(calls.broadcastCalls[0]).toMatchObject({
      cg: 'test-cg-throw',
      includeSwm: true,
    });
  }, 15000);
});
