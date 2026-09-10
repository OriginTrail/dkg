import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";

function recorder<A extends unknown[], R>(impl: (...a: A) => R) {
  const calls: A[] = [];
  const fn = (...a: A): R => {
    calls.push(a);
    return impl(...a);
  };
  return Object.assign(fn, { calls });
}
import { DKGAgent, type ContextGraphSub, type ContextGraphSubscriptionStore } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { OxigraphStore, SharedMemoryLiteralBlobStore, SparqlHttpStore, registerTripleStoreAdapter, type TripleStore, type TripleStoreConfig } from '@origintrail-official/dkg-storage';
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

function sparqlHttpStoreBackedBy(backing: OxigraphStore): TripleStore {
  const store = new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:9999/sparql' }) as TripleStore;
  Object.defineProperty(store, 'queryCancellation', {
    value: 'interruptible',
    configurable: true,
  });
  const methods: Array<keyof TripleStore> = [
    'insert',
    'delete',
    'deleteByPattern',
    'query',
    'hasGraph',
    'createGraph',
    'dropGraph',
    'listGraphs',
    'deleteBySubjectPrefix',
    'countQuads',
    'close',
  ];
  for (const method of methods) {
    (store as any)[method] = (backing as any)[method].bind(backing);
  }
  return store;
}

async function createTestAgent(opts?: {
  chainAdapter?: ChainAdapter;
  store?: TripleStore;
  storeConfig?: TripleStoreConfig;
  contextGraphSubscriptionStore?: ContextGraphSubscriptionStore;
}) {
  const agent = await DKGAgent.create({
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name: 'ContextGraphTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    ...(opts?.store ? { store: opts.store } : {}),
    ...(opts?.storeConfig ? { storeConfig: opts.storeConfig } : {}),
    chainAdapter: opts?.chainAdapter ?? createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: opts?.contextGraphSubscriptionStore,
  });
  return { agent, store: opts?.store ?? agent.store };
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

    const allowlistSpy = recorder(async () => {
      throw new Error('allowlist lookup should be skipped for curator');
    });
    (agent as any).callerIsAllowlistedAgentParticipant = allowlistSpy;

    const probe = await agent.probeContextGraphWritePreflight(contextGraphId, {
      callerAgentAddress: caller,
    });

    expect(probe).toMatchObject({
      exists: true,
      declarationFound: true,
      accessPolicy: 'private',
      callerAuthorized: true,
    });
    expect(allowlistSpy.calls).toEqual([]);
  }, 15000);

  it('does not scan loadAll during exact write preflight when indexed subscription load is unavailable', async () => {
    const loadAll = recorder(async () => {
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

    expect(loadAll.calls).toEqual([]);
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
    const publicMetaProof = await result.store.query(`ASK WHERE {
      GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
        <${contextGraphDataGraphUri(contextGraphId)}>
          <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> ;
          <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "public" .
      }
    }`);
    expect(publicMetaProof).toEqual({ type: 'boolean', value: true });
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
      onChainId: '701',
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

  it('keeps phantom-candidate subscriptions when local content probe times out', async () => {
    const result = await createTestAgent({ store: sparqlHttpStoreBackedBy(new OxigraphStore()) });
    agent = result.agent;
    await agent.start();

    (agent as any).setContextGraphSubscription('slow-local-content-cg', {
      name: 'Slow Local Content',
      subscribed: true,
      synced: false,
    } satisfies ContextGraphSub, { persist: false });
    (agent as any).contextGraphHasLocalContent = recorder(async (contextGraphId: string) => {
      if (contextGraphId === 'slow-local-content-cg') {
        return new Promise<boolean>(() => {});
      }
      return false;
    });

    const contextGraphs = await agent.listContextGraphs();
    const entry = contextGraphs.find(p => p.id === 'slow-local-content-cg');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('Slow Local Content');
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
    const store = sparqlHttpStoreBackedBy(new OxigraphStore());
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

    (agent as any).getContextGraphOnChainId = recorder(async (id: string) => {
      if (id === 'broken-enrichment-row') return new Promise<undefined>(() => {});
      return undefined;
    });

    const contextGraphs = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(contextGraphs.find(p => p.id === 'healthy-enrichment-row')).toBeDefined();
    expect(contextGraphs.find(p => p.id === 'broken-enrichment-row')).toBeDefined();
  }, 15000);

  it('drops subscribed rows from scoped output when policy enrichment times out', async () => {
    const store = sparqlHttpStoreBackedBy(new OxigraphStore());
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
    (store as any).query = recorder(async (query: string) => {
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
    const firstEntry = first.find(p => p.id === id);
    expect(firstEntry).toBeDefined();
    expect(firstEntry!.name).toBe('Remote Meta Cache');
    expect(firstEntry!.accessPolicy).toBeUndefined();

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
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Remote Meta Cache Synced"',
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
    const secondEntry = second.find(p => p.id === id);
    expect(secondEntry).toBeDefined();
    expect(secondEntry!.name).toBe('Remote Meta Cache Synced');
    expect(secondEntry!.accessPolicy).toBe('public');
  }, 15000);

  it('invalidates pending-meta cached rows when meta sync flags refresh', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'pending-meta-refresh-cache-cg';
    (agent as any).setContextGraphSubscription(id, {
      name: 'Pending Meta Cache',
      subscribed: true,
      synced: false,
      pendingMeta: true,
      metaSynced: false,
    } satisfies ContextGraphSub, { persist: false });

    const first = await agent.listContextGraphs({ callerAgentAddress: null });
    const firstEntry = first.find(p => p.id === id);
    expect(firstEntry).toBeDefined();
    expect(firstEntry!.name).toBe('Pending Meta Cache');

    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    await result.store.insert([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: metaGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Pending Meta Cache Synced"',
        graph: metaGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: metaGraph,
      },
    ]);

    await (agent as any).refreshMetaSyncedFlags([id]);

    const second = await agent.listContextGraphs({ callerAgentAddress: null });
    const secondEntry = second.find(p => p.id === id);
    expect(secondEntry).toBeDefined();
    expect(secondEntry!.name).toBe('Pending Meta Cache Synced');
    expect(secondEntry!.accessPolicy).toBe('public');
  }, 15000);

  it('keeps map-state tail rows in scoped output when legacy privacy lookup confirms public', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'policy-unknown-tail-cg';
    (agent as any).subscribedContextGraphs.set(id, {
      name: 'Policy Unknown Tail',
      subscribed: true,
      synced: false,
      onChainId: '702',
    } satisfies ContextGraphSub);

    const scoped = await agent.listContextGraphs({ callerAgentAddress: ethers.Wallet.createRandom().address });
    expect(scoped.find(p => p.id === id)).toBeDefined();

    const explicitNoWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(explicitNoWallet.find(p => p.id === id)).toBeDefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === id)).toBeDefined();
  }, 15000);

  it('skips legacy privacy fallback for unscoped owner list rows', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'unscoped-no-legacy-fallback';
    (agent as any).setContextGraphSubscription(id, {
      name: 'Unscoped No Legacy Fallback',
      subscribed: true,
      synced: false,
      onChainId: '703',
    } satisfies ContextGraphSub, { persist: false });

    const isPrivateOrig = (agent as any).isPrivateContextGraph.bind(agent);
    const legacyPrivacy = recorder((...a: unknown[]) => isPrivateOrig(...a));
    (agent as any).isPrivateContextGraph = legacyPrivacy;
    const rows = await agent.listContextGraphs();
    expect(rows.find(p => p.id === id)).toBeDefined();
    expect(legacyPrivacy.calls.filter(([contextGraphId]) => contextGraphId === id)).toHaveLength(0);
  }, 15000);

  it('drops storage-only rows from scoped output when policy enrichment times out', async () => {
    const store = sparqlHttpStoreBackedBy(new OxigraphStore());
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
    (store as any).query = recorder(async (query: string) => {
      if (query.includes('SELECT ?p ?o WHERE') && query.includes('did:dkg:context-graph:policy-unknown-storage')) {
        return new Promise<any>(() => {});
      }
      return originalQuery(query);
    });

    const explicitNoWallet = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(explicitNoWallet.find(p => p.id === 'policy-unknown-storage')).toBeUndefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === 'policy-unknown-storage')).toBeDefined();
  }, 15000);

  it('drops stale public discovery seeds from scoped output when authoritative projection lookup times out', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalAuthBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 25,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
      value: 25,
      configurable: true,
    });
    try {
      const assertScopedTimeoutDropsRow = async (callerAgentAddress: string | null) => {
        const store = sparqlHttpStoreBackedBy(new OxigraphStore());
        const result = await createTestAgent({ store });
        agent = result.agent;
        await agent.start();
        try {
          const id = 'projection-timeout-stale-public-private';
          const uri = contextGraphDataGraphUri(id);
          const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
          const metaGraph = contextGraphMetaGraphUri(id);
          await store.insert([
            {
              subject: uri,
              predicate: DKG_ONTOLOGY.RDF_TYPE,
              object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
              graph: ontologyGraph,
            },
            {
              subject: uri,
              predicate: DKG_ONTOLOGY.SCHEMA_NAME,
              object: '"Projection Timeout Stale Public"',
              graph: ontologyGraph,
            },
            {
              subject: uri,
              predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
              object: '"public"',
              graph: ontologyGraph,
            },
            {
              subject: uri,
              predicate: DKG_ONTOLOGY.RDF_TYPE,
              object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
              graph: metaGraph,
            },
            {
              subject: uri,
              predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
              object: '"private"',
              graph: metaGraph,
            },
          ]);

          const originalQuery = store.query.bind(store);
          let blockedProjectionReads = 0;
          (store as any).query = recorder(async (query: string, options?: any) => {
            if (
              blockedProjectionReads === 0
              && query.includes('SELECT ?p ?o WHERE')
              && query.includes(`<${metaGraph}>`)
              && query.includes(`<${uri}> ?p ?o`)
            ) {
              blockedProjectionReads += 1;
              return new Promise<any>(() => {});
            }
            return originalQuery(query, options);
          });

          const rows = await agent.listContextGraphs({ callerAgentAddress });
          expect(rows.find(p => p.id === id)).toBeUndefined();
          expect(blockedProjectionReads).toBe(1);
          expect((agent as any).listContextGraphsCache.size).toBe(0);
        } finally {
          await result.agent.stop().catch(() => {});
          if (agent === result.agent) {
            agent = undefined;
          }
        }
      };

      await assertScopedTimeoutDropsRow(null);
      await assertScopedTimeoutDropsRow(ethers.Wallet.createRandom().address);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
        value: originalAuthBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('preserves private discovery seeds when authoritative projection lookup times out', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 25,
      configurable: true,
    });
    try {
      const result = await createTestAgent();
      const localAgent = result.agent;
      agent = localAgent;
      await localAgent.start();

      const id = 'projection-timeout-private-seed';
      const uri = contextGraphDataGraphUri(id);
      const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
      await result.store.insert([
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: agentsGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Projection Timeout Private Seed"',
          graph: agentsGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: agentsGraph,
        },
      ]);

      const originalGetCgMeta = localAgent.getCgMeta.bind(localAgent);
      let blockedProjectionReads = 0;
      const getCgMetaSpy = recorder(async (
        contextGraphId: string,
        options?: { signal?: AbortSignal },
      ) => {
        if (contextGraphId === id && blockedProjectionReads === 0) {
          blockedProjectionReads += 1;
          return new Promise<any>(() => {});
        }
        return originalGetCgMeta(contextGraphId, options);
      });
      (localAgent as any).getCgMeta = getCgMetaSpy;
      const rows = await localAgent.listContextGraphs();
      expect(rows.find(p => p.id === id)).toBeUndefined();
      expect(blockedProjectionReads).toBe(1);
      expect((localAgent as any).listContextGraphsCache.size).toBe(0);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('keeps storage-only rows in scoped output when legacy privacy lookup confirms public', async () => {
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
    expect(explicitNoWallet.find(p => p.id === 'policy-absent-storage')).toBeDefined();

    const ownerLocal = await agent.listContextGraphs();
    expect(ownerLocal.find(p => p.id === 'policy-absent-storage')).toBeDefined();
  }, 15000);

  it('preserves legacy allowlist privacy for scoped list callers without explicit policy', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const id = 'legacy-allowlist-no-policy';
    const member = ethers.Wallet.createRandom().address;
    const stranger = ethers.Wallet.createRandom().address;
    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    await store.insert([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: metaGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Legacy Allowlist"',
        graph: metaGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${member}"`,
        graph: metaGraph,
      },
    ]);
    (agent as any).subscribedContextGraphs.set(id, {
      name: 'Legacy Allowlist',
      subscribed: true,
      synced: true,
    } satisfies ContextGraphSub);

    const memberRows = await agent.listContextGraphs({ callerAgentAddress: member });
    const memberEntry = memberRows.find(p => p.id === id);
    expect(memberEntry).toBeDefined();
    expect(memberEntry!.callerInvolved).toBe(true);

    const strangerRows = await agent.listContextGraphs({ callerAgentAddress: stranger });
    expect(strangerRows.find(p => p.id === id)).toBeUndefined();

    const noWalletRows = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(noWalletRows.find(p => p.id === id)).toBeUndefined();
  }, 15000);

  it('omits callerInvolved instead of reporting false when public allowlist lookup times out', async () => {
    const store = sparqlHttpStoreBackedBy(new OxigraphStore());
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const id = 'public-allowlist-timeout';
    const caller = ethers.Wallet.createRandom().address;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const uri = contextGraphDataGraphUri(id);
    await store.insert([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Public Allowlist Timeout"',
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);

    const originalAllowlist = agent.callerIsAllowlistedAgentParticipant.bind(agent);
    (agent as any).callerIsAllowlistedAgentParticipant = recorder(async (contextGraphId: string, wallet: string) => {
      if (contextGraphId === id && ethers.getAddress(wallet) === ethers.getAddress(caller)) {
        return new Promise<boolean>(() => {});
      }
      return originalAllowlist(contextGraphId, wallet);
    });

    const rows = await agent.listContextGraphs({ callerAgentAddress: caller });
    const entry = rows.find(p => p.id === id);
    expect(entry).toBeDefined();
    expect(entry!.callerInvolved).toBeUndefined();
  }, 15000);

  it('bypasses list cache when the configured TTL is zero', async () => {
    const originalTtl = DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
      value: 0,
      configurable: true,
    });
    try {
      const result = await createTestAgent();
      agent = result.agent;
      await agent.start();
      const store = result.store;

      const id = 'zero-cache-ttl-cg';
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const uri = contextGraphDataGraphUri(id);
      await store.insert([
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Zero Cache TTL"',
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);

      const originalQuery = store.query.bind(store);
      let definitionScans = 0;
      (store as any).query = recorder(async (query: string) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access')) {
          definitionScans += 1;
        }
        return originalQuery(query);
      });

      expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
      expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
      expect(definitionScans).toBe(2);
      expect((agent as any).listContextGraphsCache.size).toBe(0);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
        value: originalTtl,
        configurable: true,
      });
    }
  }, 15000);

  it('bypasses list cache for injected unmanaged external stores', async () => {
    const backing = new OxigraphStore();
    const store = sparqlHttpStoreBackedBy(backing);
    const result = await createTestAgent({
      store,
      storeConfig: {
        backend: 'oxigraph',
      },
    });
    agent = result.agent;
    await agent.start();

    const id = 'external-store-no-cache-cg';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const uri = contextGraphDataGraphUri(id);
    await store.insert([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"External Store No Cache"',
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);

    const originalQuery = store.query.bind(store);
    let definitionScans = 0;
    (store as any).query = recorder(async (query: string, options?: any) => {
      if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access')) {
        definitionScans += 1;
      }
      return originalQuery(query, options);
    });

    expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
    expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
    expect(definitionScans).toBe(2);
    expect((agent as any).listContextGraphsCache.size).toBe(0);
  }, 15000);

  it('bypasses list cache for unknown configured store backends', async () => {
    const backend = 'test-remote-list-cache-backend';
    registerTripleStoreAdapter(backend, async () => new OxigraphStore());
    const created = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ContextGraphTestAgent',
      listenPort: 0,
      listenHost: '127.0.0.1',
      storeConfig: { backend },
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      rfc64CatalogActivation: { enabled: false },
    });
    agent = created;
    await agent.start();

    const id = 'unknown-backend-no-cache-cg';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const uri = contextGraphDataGraphUri(id);
    await agent.store.insert([
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Unknown Backend No Cache"',
        graph: ontologyGraph,
      },
      {
        subject: uri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);

    const originalQuery = agent.store.query.bind(agent.store);
    let definitionScans = 0;
    (agent.store as any).query = recorder(async (query: string, options?: any) => {
      if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access')) {
        definitionScans += 1;
      }
      return originalQuery(query, options);
    });

    expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
    expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
    expect(definitionScans).toBe(2);
    expect((agent as any).listContextGraphsCache.size).toBe(0);
  }, 15000);

  it('bypasses list cache for injected local wrapper stores', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-list-cache-'));
    try {
      const store = new SharedMemoryLiteralBlobStore(new OxigraphStore(), { blobDir, thresholdBytes: 1 });
      const result = await createTestAgent({ store });
      agent = result.agent;
      await agent.start();
      expect((agent as any).listContextGraphsCacheAllowed()).toBe(false);

      const id = 'wrapped-local-cache-cg';
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const uri = contextGraphDataGraphUri(id);
      await store.insert([
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Wrapped Local Cache"',
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);

      const originalQuery = store.query.bind(store);
      let definitionScans = 0;
      (store as any).query = recorder(async (query: string, options?: any) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access')) {
          definitionScans += 1;
        }
        return originalQuery(query, options);
      });

      expect((await agent.listContextGraphs()).find(p => p.id === id)).toBeDefined();
      expect((await agent.listContextGraphs()).find(p => p.id === id)).toBeDefined();
      expect(definitionScans).toBe(2);
      expect((agent as any).listContextGraphsCache.size).toBe(0);
    } finally {
      await rm(blobDir, { recursive: true, force: true });
    }
  }, 15000);

  it('invalidates cached list rows after delete and drop graph writes', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();
    const agentStore = (agent as any).store as TripleStore;

    const renamedId = 'delete-invalidates-list-cache-cg';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const renamedUri = contextGraphDataGraphUri(renamedId);
    await result.store.insert([
      {
        subject: renamedUri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: renamedUri,
        predicate: DKG_ONTOLOGY.SCHEMA_NAME,
        object: '"Delete Invalidates List Cache"',
        graph: ontologyGraph,
      },
      {
        subject: renamedUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);

    const first = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(first.find(p => p.id === renamedId)?.name).toBe('Delete Invalidates List Cache');

    await agentStore.deleteByPattern({
      graph: ontologyGraph,
      subject: renamedUri,
      predicate: DKG_ONTOLOGY.SCHEMA_NAME,
    });

    const second = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(second.find(p => p.id === renamedId)?.name).toBe(renamedId);

    const droppedId = 'drop-invalidates-list-cache-cg';
    const droppedGraph = contextGraphDataGraphUri(droppedId);
    await result.store.insert([{
      subject: `${droppedGraph}#seed`,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: droppedGraph,
    }]);

    expect((await agent.listContextGraphs()).find(p => p.id === droppedId)).toBeDefined();

    await agentStore.dropGraph(droppedGraph);

    expect((await agent.listContextGraphs()).find(p => p.id === droppedId)).toBeUndefined();
  }, 15000);

  it('does not list empty named graphs created by graph ensure calls', async () => {
    const originalTtl = DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
      value: 0,
      configurable: true,
    });
    try {
      const result = await createTestAgent();
      agent = result.agent;
      await agent.start();

      const id = 'empty-created-graph-cg';
      await result.store.createGraph(contextGraphDataGraphUri(id));

      expect((await agent.listContextGraphs()).find(p => p.id === id)).toBeUndefined();
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
        value: originalTtl,
        configurable: true,
      });
    }
  }, 15000);

  it('expires cached list rows using monotonic time when wall clock moves backwards', async () => {
    const originalTtl = DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
      value: 50,
      configurable: true,
    });
    const originalDateNow = Date.now;
    let dateNowValue = 10_000;
    Date.now = recorder(() => dateNowValue);
    try {
      const result = await createTestAgent();
      agent = result.agent;
      await agent.start();
      const store = result.store;

      const id = 'monotonic-list-cache-cg';
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const uri = contextGraphDataGraphUri(id);
      await store.insert([
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Monotonic List Cache"',
          graph: ontologyGraph,
        },
        {
          subject: uri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);

      let monotonicNow = 1_000;
      (agent as any).listContextGraphsCacheNow = recorder(() => monotonicNow);
      const originalQuery = store.query.bind(store);
      let definitionScans = 0;
      (store as any).query = recorder(async (query: string, options?: any) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access')) {
          definitionScans += 1;
        }
        return originalQuery(query, options);
      });

      expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
      dateNowValue = 1;
      monotonicNow += 51;
      expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === id)).toBeDefined();
      expect(definitionScans).toBe(2);
    } finally {
      Date.now = originalDateNow;
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', {
        value: originalTtl,
        configurable: true,
      });
    }
  }, 15000);

  it('uses a catalog scan budget that is independent from the per-row enrichment budget', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalScanBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
      value: 80,
      configurable: true,
    });
    try {
      const store = new OxigraphStore();
      const result = await createTestAgent({ store });
      agent = result.agent;
      await agent.start();

      const id = 'slow-catalog-scan-cg';
      const uri = contextGraphDataGraphUri(id);
      const originalQuery = store.query.bind(store);
      (store as any).query = recorder(async (query: string, options?: any) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem')) {
          await new Promise(resolve => setTimeout(resolve, 20));
          return {
            type: 'bindings',
            bindings: [{
              ctxGraph: uri,
              name: '"Slow Catalog Scan"',
              access: '"public"',
            }],
          } as any;
        }
        return originalQuery(query, options);
      });

      const rows = await agent.listContextGraphs({ callerAgentAddress: null });
      expect(rows.find(p => p.id === id)).toBeDefined();
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
        value: originalScanBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('aborts budgeted catalog scans after timeout', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalScanBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    try {
      const store = sparqlHttpStoreBackedBy(new OxigraphStore());
      const result = await createTestAgent({ store });
      agent = result.agent;
      await agent.start();

      const originalQuery = store.query.bind(store);
      let sawAbort = false;
      let scanSettled: Promise<void> | undefined;
      (store as any).query = recorder(async (query: string, options?: any) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem')) {
          scanSettled = new Promise(resolve => setTimeout(resolve, 20));
          await scanSettled;
          sawAbort = options?.signal?.aborted === true;
          return { type: 'bindings', bindings: [] } as any;
        }
        return originalQuery(query, options);
      });

      await expect(agent.listContextGraphs({ callerAgentAddress: null }))
        .rejects.toThrow('ontology/agents definition scan');
      await scanSettled;
      expect(sawAbort).toBe(true);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
        value: originalScanBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('rejects when the budgeted storage graph scan times out', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalScanBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    try {
      const store = sparqlHttpStoreBackedBy(new OxigraphStore());
      const result = await createTestAgent({ store });
      agent = result.agent;
      await agent.start();

      let sawAbort = false;
      let scanSettled: Promise<void> | undefined;
      (store as any).listGraphs = recorder(async (options?: any) => {
        scanSettled = new Promise(resolve => setTimeout(resolve, 20));
        await scanSettled;
        sawAbort = options?.signal?.aborted === true;
        return [];
      });

      await expect(agent.listContextGraphs({ callerAgentAddress: null }))
        .rejects.toThrow('storage context graph scan');
      await scanSettled;
      expect(sawAbort).toBe(true);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
        value: originalScanBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('does not downgrade synchronous pre-dispatch store reads', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalScanBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    try {
      const store = new OxigraphStore();
      const result = await createTestAgent({ store });
      agent = result.agent;
      await agent.start();

      const id = 'pre-dispatch-budget-cg';
      const uri = contextGraphDataGraphUri(id);
      const originalQuery = store.query.bind(store);
      (store as any).query = recorder(async (query: string, options?: any) => {
        if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem')) {
          const startedAt = performance.now();
          while (performance.now() - startedAt < 8) {
            // Simulate the default native Oxigraph path blocking the event loop.
          }
          expect(options?.signal?.aborted).toBe(false);
          return {
            type: 'bindings',
            bindings: [{
              ctxGraph: uri,
              name: '"Pre Dispatch Budget"',
              access: '"public"',
            }],
          } as any;
        }
        return originalQuery(query, options);
      });

      const rows = await agent.listContextGraphs({ callerAgentAddress: null });
      expect(rows.find(p => p.id === id)).toBeDefined();
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS', {
        value: originalScanBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('still applies auth budget to async membership work on pre-dispatch stores', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalAuthBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    try {
      const result = await createTestAgent({ store: new OxigraphStore() });
      agent = result.agent;
      await agent.start();

      const id = 'pre-dispatch-auth-budget-cg';
      const member = ethers.Wallet.createRandom().address;
      await agent.createContextGraph({
        id,
        name: 'Pre Dispatch Auth Budget',
        accessPolicy: 1,
        allowedAgents: [agent.getDefaultAgentAddress()!],
      });

      const originalAllowlist = agent.callerIsAllowlistedAgentParticipant.bind(agent);
      let targetCalls = 0;
      let signalSeen: AbortSignal | undefined;
      (agent as any).callerIsAllowlistedAgentParticipant = recorder(async (contextGraphId: string, caller: string, options?: { signal?: AbortSignal }) => {
        if (contextGraphId === id && ethers.getAddress(caller) === ethers.getAddress(member)) {
          targetCalls += 1;
          signalSeen = options?.signal;
          return new Promise<boolean>(() => {});
        }
        return originalAllowlist(contextGraphId, caller, options);
      });

      const timeout = { timedOut: true as const };
      const rows = await Promise.race([
        agent.listContextGraphs({ callerAgentAddress: member }),
        new Promise<typeof timeout>(resolve => setTimeout(() => resolve(timeout), 100)),
      ]);

      expect(rows).not.toBe(timeout);
      if (rows === timeout) return;
      expect(rows.find(p => p.id === id)).toBeUndefined();
      expect(targetCalls).toBe(1);
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
        value: originalAuthBudget,
        configurable: true,
      });
    }
  }, 15000);

  it('does not cache private membership misses when allowlist lookup degrades', async () => {
    const result = await createTestAgent({ store: sparqlHttpStoreBackedBy(new OxigraphStore()) });
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
    (agent as any).callerIsAllowlistedAgentParticipant = recorder(async (contextGraphId: string, caller: string) => {
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

  it('does not cache wallet-scoped visibility when membership comes from live chain identity state', async () => {
    const chainAdapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const result = await createTestAgent({ chainAdapter });
    agent = result.agent;
    await agent.start();

    const id = 'chain-auth-cache-cg';
    const member = ethers.Wallet.createRandom().address;
    const identityId = 424242n;
    let registered = true;
    let registrationCalls = 0;
    (chainAdapter as any).isOperationalWalletRegistered = recorder(async (actualIdentityId: bigint, actualAddress: string) => {
      registrationCalls += 1;
      expect(actualIdentityId).toBe(identityId);
      expect(ethers.getAddress(actualAddress)).toBe(ethers.getAddress(member));
      await new Promise(resolve => setTimeout(resolve, 20));
      return registered;
    });

    await agent.createContextGraph({
      id,
      name: 'Chain Auth Cache',
      accessPolicy: 1,
      allowedAgents: [agent.getDefaultAgentAddress()!],
    });
    await result.store.insert([{
      subject: contextGraphDataGraphUri(id),
      predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID,
      object: `"${identityId.toString()}"`,
      graph: contextGraphMetaGraphUri(id),
    }]);

    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    const originalAuthBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
      value: 80,
      configurable: true,
    });
    try {
      const before = await agent.listContextGraphs({ callerAgentAddress: member });
      expect(before.find(p => p.id === id)).toBeDefined();
      expect(registrationCalls).toBe(1);

      registered = false;
      const after = await agent.listContextGraphs({ callerAgentAddress: member });
      expect(after.find(p => p.id === id)).toBeUndefined();
      expect(registrationCalls).toBe(2);
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS', {
        value: originalAuthBudget,
        configurable: true,
      });
    }
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

    (agent as any).callerIsAllowlistedAgentParticipant = recorder(async (contextGraphId: string, caller: string) => {
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
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const originalQuery = result.store.query.bind(result.store);
    let releaseDefinitionScan: (() => void) | undefined;
    const definitionScanGate = new Promise<void>((resolve) => {
      releaseDefinitionScan = resolve;
    });
    let definitionScans = 0;
    (result.store as any).query = recorder(async (query: string, options?: any) => {
      if (query.includes('SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem')) {
        definitionScans += 1;
        if (definitionScans === 1) {
          await definitionScanGate;
        }
      }
      return originalQuery(query, options);
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
    await result.store.insert([
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
      onChainId: '704',
    } satisfies ContextGraphSub, { persist: false });

    const afterInvalidation = await agent.listContextGraphs({ callerAgentAddress: null });
    expect(definitionScans).toBe(2);
    expect(afterInvalidation.find(p => p.id === 'cache-invalidated-cg')).toBeDefined();
  }, 15000);

  it('does not rewrite the caller-provided store when binding list cache invalidation', async () => {
    const store = new OxigraphStore();
    const originalInsert = store.insert;
    const originalDelete = store.delete;
    const originalQuery = store.query;

    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    expect(store.insert).toBe(originalInsert);
    expect(store.delete).toBe(originalDelete);
    expect(store.query).toBe(originalQuery);
    expect((agent as any).store).not.toBe(store);
    expect((agent as any).store.innerStore).toBe(store);
  }, 15000);

  it('listContextGraphs applies the same privacy rules to AGENTS-declared private CGs', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const id = 'agents-declared-private';
    const myWallet = agent.getDefaultAgentAddress()!;
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);
    await result.store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Agents Declared Private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${myWallet}`, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${myWallet}"`, graph: metaGraph },
    ]);

    const otherWallet = ethers.Wallet.createRandom().address;
    expect((await agent.listContextGraphs()).find(p => p.id === id)).toBeUndefined();
    expect((await agent.listContextGraphs({ callerAgentAddress: otherWallet })).find(p => p.id === id)).toBeUndefined();
    const visible = (await agent.listContextGraphs({ callerAgentAddress: myWallet })).find(p => p.id === id);
    expect(visible).toBeDefined();
    expect(visible?.accessPolicy).toBe('private');
  }, 15000);

  it('listContextGraphs projection mode preserves AGENTS privacy and root _meta discovery', async () => {
    const previous = process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION;
    process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION = '1';
    try {
      const result = await createTestAgent();
      agent = result.agent;
      await agent.start();

      const privateId = 'projection-list-agents-private';
      const gateOnlyId = 'projection-list-gate-only-private';
      const metaOnlyId = 'projection-list-meta-only';
      const policyUnknownId = 'projection-list-policy-unknown';
      const implicitPublicId = 'projection-list-implicit-public';
      const myWallet = agent.getDefaultAgentAddress()!;
      const privateUri = contextGraphDataGraphUri(privateId);
      const gateOnlyUri = contextGraphDataGraphUri(gateOnlyId);
      const metaOnlyUri = contextGraphDataGraphUri(metaOnlyId);
      const policyUnknownUri = contextGraphDataGraphUri(policyUnknownId);
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
      const privateMetaGraph = contextGraphMetaGraphUri(privateId);
      const gateOnlyMetaGraph = contextGraphMetaGraphUri(gateOnlyId);
      await result.store.insert([
        { subject: privateUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Projection Agents Private"', graph: agentsGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${myWallet}`, graph: agentsGraph },
        { subject: privateUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${myWallet}"`, graph: privateMetaGraph },
        { subject: gateOnlyUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
        { subject: gateOnlyUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Projection Gate Only Private"', graph: agentsGraph },
        { subject: gateOnlyUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${myWallet}"`, graph: gateOnlyMetaGraph },
        { subject: metaOnlyUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphMetaGraphUri(metaOnlyId) },
        { subject: metaOnlyUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Projection Meta Only"', graph: contextGraphMetaGraphUri(metaOnlyId) },
        { subject: policyUnknownUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
        { subject: policyUnknownUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Projection Unknown Policy"', graph: agentsGraph },
        { subject: policyUnknownUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"membersOnly"', graph: agentsGraph },
        { subject: 'urn:projection-list-policy-unknown:root', predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Policy Unknown"', graph: contextGraphSharedMemoryUri(policyUnknownId) },
      ]);
      await agent.share(implicitPublicId, [
        {
          subject: 'urn:projection-list-implicit-public:root',
          predicate: DKG_ONTOLOGY.SCHEMA_NAME,
          object: '"Projection Implicit Public"',
          graph: '',
        },
      ], { callerAgentAddress: myWallet });

      const unscoped = await agent.listContextGraphs();
      expect(unscoped.find(p => p.id === privateId)).toBeUndefined();
      expect(unscoped.find(p => p.id === gateOnlyId)).toBeUndefined();
      expect(unscoped.find(p => p.id === metaOnlyId)?.name).toBe('Projection Meta Only');
      expect(unscoped.find(p => p.id === policyUnknownId)?.accessPolicy).toBe('membersOnly');
      expect((await agent.listContextGraphs({ callerAgentAddress: null })).find(p => p.id === policyUnknownId)).toBeUndefined();

      const otherWallet = ethers.Wallet.createRandom().address;
      expect((await agent.listContextGraphs({ callerAgentAddress: otherWallet })).find(p => p.id === privateId)).toBeUndefined();
      expect((await agent.listContextGraphs({ callerAgentAddress: otherWallet })).find(p => p.id === gateOnlyId)).toBeUndefined();
      expect((await agent.listContextGraphs({ callerAgentAddress: otherWallet })).find(p => p.id === policyUnknownId)).toBeUndefined();

      const visible = (await agent.listContextGraphs({ callerAgentAddress: myWallet })).find(p => p.id === privateId);
      expect(visible).toBeDefined();
      expect(visible?.accessPolicy).toBe('private');
      expect(visible?.callerInvolved).toBe(true);
      const gateVisible = (await agent.listContextGraphs({ callerAgentAddress: myWallet })).find(p => p.id === gateOnlyId);
      expect(gateVisible).toBeDefined();
      expect(gateVisible?.accessPolicy).toBe('private');
      expect(gateVisible?.callerInvolved).toBe(true);
      const implicitPublic = (await agent.listContextGraphs({ callerAgentAddress: myWallet })).find(p => p.id === implicitPublicId);
      expect(implicitPublic).toBeDefined();
      expect(implicitPublic?.accessPolicy).toBe('public');
      expect(implicitPublic?.callerInvolved).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION;
      } else {
        process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION = previous;
      }
    }
  }, 15000);

  it('listContextGraphs projection mode reuses the graph index and cached projected metadata', async () => {
    const previous = process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION;
    process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION = '1';
    try {
      const result = await createTestAgent();
      agent = result.agent;
      await agent.start();

      const owner = agent.getDefaultAgentAddress()!;
      await agent.ensureContextGraphLocal({
        id: 'projection-list-perf-public',
        name: 'Projection List Perf Public',
      });
      await agent.createContextGraph({
        id: 'projection-list-perf-private',
        name: 'Projection List Perf Private',
        accessPolicy: 1,
        allowedAgents: [owner],
      });

      const listGraphsOrig = (result.store as any).listGraphs.bind(result.store);
      const listGraphsSpy = recorder((...a: unknown[]) => listGraphsOrig(...a));
      (result.store as any).listGraphs = listGraphsSpy;
      const listGraphsByPrefixOrig = (result.store as any).listGraphsByPrefix.bind(result.store);
      const listGraphsByPrefixSpy = recorder((...a: unknown[]) => listGraphsByPrefixOrig(...a));
      (result.store as any).listGraphsByPrefix = listGraphsByPrefixSpy;
      const queryOrig = (result.store as any).query.bind(result.store);
      const querySpy = recorder((...a: unknown[]) => queryOrig(...a));
      (result.store as any).query = querySpy;
      const projectionRecordQueries = () => querySpy.calls.filter(([query]) => {
        const text = String(query);
        return text.includes('SELECT ?p ?o WHERE') ||
          text.includes('SELECT ?subGraph ?name ?createdBy ?createdAt ?description WHERE');
      }).length;
      const unboundMetaDiscoveryScans = () => querySpy.calls.filter(([query]) => {
        const text = String(query);
        return text.includes('GRAPH ?g') && !text.includes('VALUES ?g');
      }).length;

      await agent.listContextGraphs({ callerAgentAddress: owner });
      const firstListGraphsCalls = listGraphsSpy.calls.length;
      const firstPrefixCalls = listGraphsByPrefixSpy.calls.length;
      const firstProjectionRecordQueries = projectionRecordQueries();

      await agent.listContextGraphs({ callerAgentAddress: owner });

      expect(firstPrefixCalls).toBeGreaterThan(0);
      expect(listGraphsByPrefixSpy.calls.length).toBeGreaterThan(firstPrefixCalls);
      expect(listGraphsSpy.calls.length).toBe(firstListGraphsCalls);
      expect(projectionRecordQueries()).toBe(firstProjectionRecordQueries);
      expect(unboundMetaDiscoveryScans()).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION;
      } else {
        process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION = previous;
      }
    }
  }, 15000);
});

describe('discoverContextGraphsFromChain', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('catalogues revealed on-chain context graphs without subscribing or persisting them', async () => {
    const persisted = new Map<string, any>();
    const subscriptionStore: ContextGraphSubscriptionStore = {
      loadAll: async () => [...persisted.values()],
      save: async (record) => {
        persisted.set(record.id, { ...record });
      },
      delete: async (contextGraphId) => {
        persisted.delete(contextGraphId);
      },
    };
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '801',
        name: 'test-revealed',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: true,
      },
    ] satisfies ContextGraphOnChain[]);

    const result = await createTestAgent({
      chainAdapter: chain,
      contextGraphSubscriptionStore: subscriptionStore,
    });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain();
    expect(discovered).toBe(1);

    const subs = agent.getSubscribedContextGraphs();
    const entry = subs.get('test-revealed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(false);
    expect(entry!.synced).toBe(false);
    expect(entry!.onChainId).toBe('801');
    expect((agent as any).config.syncContextGraphs ?? []).not.toContain('test-revealed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted.has('test-revealed')).toBe(false);

    agent.subscribeToContextGraph('test-revealed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.getSubscribedContextGraphs().get('test-revealed')?.subscribed).toBe(true);
    expect((agent as any).config.syncContextGraphs ?? []).toContain('test-revealed');
    expect(persisted.get('test-revealed')).toMatchObject({
      id: 'test-revealed',
      subscribed: true,
      syncScoped: true,
    });
  }, 15000);

  it('skips revealed curated chain entries when not curator', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: '803',
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
        contextGraphId: '802',
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
        contextGraphId: '804',
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
      onChainId: '804',
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
    const listCalls: unknown[] = [];
    const scanCalls: unknown[] = [];
    (chain as any).listContextGraphsFromChain = async (_fromBlock?: number, options?: unknown) => {
      listCalls.push(options);
      return [];
    };
    (chain as any).scanContextGraphRegistryPages = async function* (options: unknown) {
      scanCalls.push(options);
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ mode: 'incremental' })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ mode: 'incremental', pageBudget: 7 })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ mode: 'seedFull' })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({
      mode: 'seedFromCursor',
      pageBudget: 11,
    })).toBe(0);

    expect(listCalls).toEqual([
      undefined,
    ]);
    expect(scanCalls).toEqual([
      { mode: 'incremental' },
      { mode: 'incremental', pageBudget: 7 },
      { mode: 'seedFull' },
      { mode: 'seedFromCursor', pageBudget: 11 },
    ]);
  }, 15000);

  it('keeps legacy chain discovery scan options as explicit cursor-mode aliases', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const scanCalls: unknown[] = [];
    (chain as any).listContextGraphsFromChain = async () => [];
    (chain as any).scanContextGraphRegistryPages = async function* (options: unknown) {
      scanCalls.push(options);
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain({ incremental: true })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ incremental: true, pageBudget: 5 })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({ seedIncrementalWatermark: true })).toBe(0);
    expect(await agent.discoverContextGraphsFromChain({
      seedIncrementalWatermark: true,
      resumeFromCursor: true,
      pageBudget: 6,
    })).toBe(0);

    expect(scanCalls).toEqual([
      { mode: 'incremental' },
      { mode: 'incremental', pageBudget: 5 },
      { mode: 'seedFull' },
      { mode: 'seedFromCursor', pageBudget: 6 },
    ]);
  }, 15000);

  it('falls back to legacy list scan options for adapters without the paged scanner', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const listCalls: unknown[] = [];
    const entries: ContextGraphOnChain[] = [
      {
        contextGraphId: '810',
        name: 'legacy-list-incremental',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: true,
      },
      {
        contextGraphId: '811',
        name: 'legacy-list-seed',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 200,
        metadataRevealed: true,
      },
    ];
    (chain as any).listContextGraphsFromChain = async (_fromBlock?: number, options?: unknown) => {
      listCalls.push(options);
      return [entries[listCalls.length - 1]];
    };
    (chain as any).scanContextGraphRegistryPages = undefined;

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain({
      incremental: true,
      pageBudget: 5,
    })).toBe(1);
    expect(await agent.discoverContextGraphsFromChain({
      seedIncrementalWatermark: true,
    })).toBe(1);

    expect(listCalls).toEqual([
      { incremental: true, pageBudget: 5 },
      { seedIncrementalWatermark: true },
    ]);
    expect(agent.getSubscribedContextGraphs().get('legacy-list-incremental')?.subscribed).toBe(false);
    expect(agent.getSubscribedContextGraphs().get('legacy-list-seed')?.subscribed).toBe(false);
  }, 15000);

  it('applies cursor scan pages once and acknowledges after local discovery work', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const contextGraphId = '821';
    const revealed: ContextGraphOnChain = {
      contextGraphId,
      name: 'paged-revealed',
      creator: '0x1234',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    };
    const scanCalls: unknown[] = [];
    const ackedCounts: number[] = [];
    (chain as any).listContextGraphsFromChain = async () => [];
    (chain as any).scanContextGraphRegistryPages = async function* (options: unknown) {
      scanCalls.push(options);
      yield {
        contextGraphs: [revealed],
        ack: async () => {
          ackedCounts.push(1);
        },
      };
      yield {
        contextGraphs: [revealed],
        ack: async () => {
          ackedCounts.push(2);
        },
      };
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverContextGraphsFromChain({
      mode: 'seedFromCursor',
      pageBudget: 1,
    });

    expect(discovered).toBe(1);
    expect(scanCalls).toEqual([{ mode: 'seedFromCursor', pageBudget: 1 }]);
    expect(ackedCounts).toEqual([1, 2]);
    const entry = agent.getSubscribedContextGraphs().get('paged-revealed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(false);
    expect(entry!.onChainId).toBe(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri('paged-revealed');
    const onChainIdBinding = await result.store.query(`
      ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${contextGraphId}" .
        }
      }
    `);
    expect(onChainIdBinding.type).toBe('boolean');
    if (onChainIdBinding.type === 'boolean') {
      expect(onChainIdBinding.value).toBe(true);
    }
  }, 15000);

  it('propagates cursor scan page apply failures without acknowledging progress', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const revealed: ContextGraphOnChain = {
      contextGraphId: '822',
      name: 'apply-failure-revealed',
      creator: '0x1234',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    };
    let acked = 0;
    (chain as any).listContextGraphsFromChain = async () => [];
    (chain as any).scanContextGraphRegistryPages = async function* () {
      yield {
        contextGraphs: [revealed],
        ack: async () => {
          acked += 1;
        },
      };
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();
    const originalInsert = result.store.insert.bind(result.store);
    (result.store as any).insert = async (quads: Parameters<typeof originalInsert>[0]) => {
      if (quads.some((quad) => quad.predicate === `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`)) {
        throw new Error('local on-chain id insert failed');
      }
      return originalInsert(quads);
    };

    await expect(agent.discoverContextGraphsFromChain({ mode: 'incremental' }))
      .rejects.toThrow('local on-chain id insert failed');
    expect(acked).toBe(0);
    expect((agent as any).chainContextGraphScanFailure).toBeUndefined();
  }, 15000);

  it('retries cursor pages after partial local apply without acknowledging until RDF binding exists', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const contextGraphId = '823';
    const revealed: ContextGraphOnChain = {
      contextGraphId,
      name: 'retry-safe-revealed',
      creator: '0x1234',
      accessPolicy: 0,
      blockNumber: 100,
      metadataRevealed: true,
    };
    let acked = 0;
    (chain as any).listContextGraphsFromChain = async () => [];
    (chain as any).scanContextGraphRegistryPages = async function* () {
      yield {
        contextGraphs: [revealed],
        ack: async () => {
          acked += 1;
        },
      };
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();
    const originalInsert = result.store.insert.bind(result.store);
    let failOnChainIdInsert = true;
    (result.store as any).insert = async (quads: Parameters<typeof originalInsert>[0]) => {
      if (
        failOnChainIdInsert &&
        quads.some((quad) => quad.predicate === `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`)
      ) {
        failOnChainIdInsert = false;
        throw new Error('transient local on-chain id insert failed');
      }
      return originalInsert(quads);
    };

    await expect(agent.discoverContextGraphsFromChain({ mode: 'incremental' }))
      .rejects.toThrow('transient local on-chain id insert failed');
    expect(acked).toBe(0);
    expect(agent.getSubscribedContextGraphs().get('retry-safe-revealed')).toBeUndefined();
    (agent as any).setContextGraphSubscription('retry-safe-revealed', {
      name: 'retry-safe-revealed',
      subscribed: true,
      synced: false,
      metaSynced: false,
      onChainId: contextGraphId,
    });

    await expect(agent.discoverContextGraphsFromChain({ mode: 'incremental' }))
      .resolves.toBe(1);
    expect(acked).toBe(1);
    expect(agent.getSubscribedContextGraphs().get('retry-safe-revealed')?.onChainId)
      .toBe(contextGraphId);

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri('retry-safe-revealed');
    const onChainIdBinding = await result.store.query(`
      ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${contextGraphId}" .
        }
      }
    `);
    expect(onChainIdBinding.type).toBe('boolean');
    if (onChainIdBinding.type === 'boolean') {
      expect(onChainIdBinding.value).toBe(true);
    }
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
    (chain as any).scanContextGraphRegistryPages = async function* () {
      throw failure;
    };

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    expect(await agent.discoverContextGraphsFromChain()).toBe(0);
    await expect(
      agent.discoverContextGraphsFromChain({
        mode: 'seedFull',
        throwOnChainScanFailure: true,
      }),
    ).rejects.toThrow('seed scan failed');
  }, 15000);

  it('processes partial chain scan prefixes without marking the scan recovered', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    let calls = 0;
    (chain as any).listContextGraphsFromChain = async () => [];
    (chain as any).scanContextGraphRegistryPages = async function* () {
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
          contextGraphId: '824',
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
      yield {
        contextGraphs: err.partialResults,
        ack: async () => {},
      };
      throw err;
    };
    const entries: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => entries.push({ level: entry.level, message: entry.message }));
    try {
      const result = await createTestAgent({ chainAdapter: chain });
      agent = result.agent;
      await agent.start();

      await expect(agent.discoverContextGraphsFromChain({
        mode: 'seedFull',
        throwOnChainScanFailure: true,
      })).rejects.toThrow('partial ContextGraphNameRegistry scan');
      expect(await agent.discoverContextGraphsFromChain({ mode: 'incremental' })).toBe(0);
    } finally {
      Logger.setSink(null);
    }

    const entry = agent!.getSubscribedContextGraphs().get('partial-revealed');
    expect(entry).toBeDefined();
    expect(entry!.onChainId).toBe('824');
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
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: contextGraphMetaGraphUri(curatedId) },
    ]);

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(1);

    const entry = agent.getSubscribedContextGraphs().get(curatedId);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('Curated Meta Only');
    expect(entry!.subscribed).toBe(false);
    expect((agent as any).config.syncContextGraphs ?? []).not.toContain(curatedId);
    // Discovery itself does not certify authenticated metadata. The existing
    // refreshMetaSyncedFlags path is the single authority that promotes this
    // after confirming the local _meta state.
    expect(entry!.synced).toBe(false);
    expect(entry!.metaSynced).toBe(false);
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

  it('chain discovery then ontology sync produces one merged entry, no on-chain-id ghost', async () => {
    const localName = 'merged-contextGraph';
    const onChainId = '825';
    const onChainNameHash = ethers.keccak256(ethers.toUtf8Bytes(localName));

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const resolveContextGraphIdByNameHash = recorder(async (candidate: string) => {
      return candidate === onChainNameHash.toLowerCase()
        ? BigInt(onChainId)
        : null;
    });
    (chain as any).resolveContextGraphIdByNameHash = resolveContextGraphIdByNameHash;
    (chain as any).listContextGraphsFromChain = async () => ([
      {
        contextGraphId: onChainNameHash,
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
    expect(resolveContextGraphIdByNameHash.calls).toContainEqual([
      onChainNameHash.toLowerCase(),
    ]);

    const contextGraphs = await agent.listContextGraphs();
    const matches = contextGraphs.filter(
      p => p.id === localName || p.id === onChainId || p.id === onChainNameHash,
    );
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(localName);
    expect(matches[0].subscribed).toBe(false);
    // Chain + ontology discovery only deliver definition metadata —
    // no actual CG data has been pulled from a peer, so `synced`
    // stays false until the catchup runner flips it.
    expect(matches[0].synced).toBe(false);
    expect(matches[0].callerInvolved).toBeUndefined();

    const ghosts = contextGraphs.filter(
      p => p.id === onChainId || p.id === onChainNameHash,
    );
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
    ensureAdmitted?: (pid: string) => boolean | Promise<boolean>;
    ensurePeerConnected?: (pid: string) => Promise<void>;
    connectedPeers?: string[];
    runCatchupResult?: {
      peersSucceeded: number;
      dataSynced: number;
      sharedMemorySynced: number;
      sharedMemoryCompletedCleanly?: boolean;
      denied: boolean;
    };
    runCatchupResults?: Array<{
      peersSucceeded: number;
      dataSynced: number;
      sharedMemorySynced: number;
      sharedMemoryCompletedCleanly?: boolean;
      denied: boolean;
    }>;
    runCatchupThrows?: Error;
    broadcastThrows?: Error;
    refreshMetaResults?: Array<boolean | Error>;
  }) {
    const calls = {
      ensureAdmittedCalls: [] as string[],
      ensurePeerConnectedCalls: [] as string[],
      refreshMetaCalls: [] as Array<{
        cg: string;
        peer?: string;
        force?: boolean;
        approvedAgentAddress?: string;
        expectedDelegateePeerId?: string;
      }>,
      runCatchupCalls: [] as Array<{ cg: string; includeSwm: boolean; peers: string[] }>,
      broadcastCalls: [] as Array<{ cg: string; includeSwm: boolean }>,
    };
    (a as any).networkAdmissionCoordinator.ensureAdmitted = async (pid: string) => {
      calls.ensureAdmittedCalls.push(pid);
      return opts.ensureAdmitted ? opts.ensureAdmitted(pid) : true;
    };
    (a as any).ensurePeerConnected = async (pid: string) => {
      calls.ensurePeerConnectedCalls.push(pid);
      if (opts.ensurePeerConnected) await opts.ensurePeerConnected(pid);
    };
    (a as any).node.libp2p.getConnections = () =>
      (opts.connectedPeers ?? []).map((pid) => ({
        remotePeer: { toString: () => pid },
      }));
    let metaConfirmed = false;
    (a as any).refreshMetaFromCurator = async (
      cg: string,
      refreshOpts?: {
        trustedCuratorPeerId?: string;
        force?: boolean;
        memberProof?: {
          approvedAgentAddress: string;
          expectedDelegateePeerId?: string;
        };
      },
    ) => {
      calls.refreshMetaCalls.push({
        cg,
        peer: refreshOpts?.trustedCuratorPeerId,
        force: refreshOpts?.force,
        approvedAgentAddress: refreshOpts?.memberProof?.approvedAgentAddress,
        expectedDelegateePeerId: refreshOpts?.memberProof?.expectedDelegateePeerId,
      });
      const outcome = opts.refreshMetaResults?.[calls.refreshMetaCalls.length - 1] ?? true;
      if (outcome instanceof Error) throw outcome;
      if (outcome) metaConfirmed = true;
      return outcome;
    };
    (a as any).hasConfirmedMetaState = async () => metaConfirmed;
    (a as any).refreshMetaSyncedFlags = async () => undefined;
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
      const sequencedResult = opts.runCatchupResults?.[calls.runCatchupCalls.length - 1];
      const configuredResult = sequencedResult ?? opts.runCatchupResult;
      return {
        connectedPeers: 1,
        syncCapablePeers: 1,
        peersTried: 1,
        peersSucceeded: configuredResult?.peersSucceeded ?? 0,
        dataSynced: configuredResult?.dataSynced ?? 0,
        sharedMemorySynced: configuredResult?.sharedMemorySynced ?? 0,
        sharedMemoryCompletedCleanly:
          configuredResult?.sharedMemoryCompletedCleanly ?? false,
        denied: configuredResult?.denied ?? false,
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

    (agent as any).localApprovedAgentByCG.set(
      'test-cg-success',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-success', CURATOR_PEER);

    expect(calls.ensureAdmittedCalls).toEqual([CURATOR_PEER]);
    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.refreshMetaCalls).toEqual([{
      cg: 'test-cg-success',
      peer: CURATOR_PEER,
      force: true,
      approvedAgentAddress: agent.getDefaultAgentAddress()?.toLowerCase(),
      expectedDelegateePeerId: agent.peerId,
    }]);
    expect(calls.runCatchupCalls).toHaveLength(1);
    expect(calls.runCatchupCalls[0]).toMatchObject({
      cg: 'test-cg-success',
      includeSwm: true,
      peers: [CURATOR_PEER],
    });
    expect(calls.broadcastCalls).toHaveLength(0);
  }, 15000);

  it('retries curator directly while graph-aligned durable progress is increasing', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      runCatchupResults: [
        {
          peersSucceeded: 0,
          dataSynced: 32_000,
          sharedMemorySynced: 50_000,
          sharedMemoryCompletedCleanly: true,
          denied: false,
        },
        { peersSucceeded: 1, dataSynced: 18_000, sharedMemorySynced: 0, denied: false },
      ],
    });
    (agent as any).localApprovedAgentByCG.set(
      'test-cg-bounded-progress',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-bounded-progress', CURATOR_PEER);

    expect(calls.runCatchupCalls).toEqual([
      { cg: 'test-cg-bounded-progress', includeSwm: true, peers: [CURATOR_PEER] },
      { cg: 'test-cg-bounded-progress', includeSwm: false, peers: [CURATOR_PEER] },
    ]);
    expect(calls.broadcastCalls).toHaveLength(0);
  }, 15000);

  it('keeps requesting SWM after partial inserts until the curator completes it cleanly', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      runCatchupResults: [
        {
          peersSucceeded: 0,
          dataSynced: 32_000,
          sharedMemorySynced: 50_000,
          sharedMemoryCompletedCleanly: false,
          denied: false,
        },
        {
          peersSucceeded: 1,
          dataSynced: 18_000,
          sharedMemorySynced: 10_000,
          sharedMemoryCompletedCleanly: true,
          denied: false,
        },
      ],
    });
    (agent as any).localApprovedAgentByCG.set(
      'test-cg-partial-swm',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-partial-swm', CURATOR_PEER);

    expect(calls.runCatchupCalls).toEqual([
      { cg: 'test-cg-partial-swm', includeSwm: true, peers: [CURATOR_PEER] },
      { cg: 'test-cg-partial-swm', includeSwm: true, peers: [CURATOR_PEER] },
    ]);
    expect(calls.broadcastCalls).toHaveLength(0);
  }, 15000);

  it('stops curator-direct retries and falls back when a round makes no progress', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      runCatchupResults: [
        { peersSucceeded: 0, dataSynced: 32_000, sharedMemorySynced: 50_000, denied: false },
        { peersSucceeded: 0, dataSynced: 0, sharedMemorySynced: 0, denied: false },
      ],
    });
    (agent as any).localApprovedAgentByCG.set(
      'test-cg-no-progress',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-no-progress', CURATOR_PEER);

    expect(calls.runCatchupCalls).toHaveLength(2);
    expect(calls.broadcastCalls).toEqual([{
      cg: 'test-cg-no-progress',
      includeSwm: true,
    }]);
  }, 15000);

  it('falls back to broadcast when curator is not in connected peers after ensurePeerConnected', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [],
    });

    (agent as any).localApprovedAgentByCG.set(
      'test-cg-missing-peer',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-missing-peer', CURATOR_PEER);

    expect(calls.ensureAdmittedCalls).toEqual([CURATOR_PEER]);
    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toHaveLength(1);
    expect(calls.broadcastCalls[0]).toMatchObject({
      cg: 'test-cg-missing-peer',
      includeSwm: true,
    });
  }, 15000);

  it('retries metadata and falls back after curator data succeeds without authoritative metadata', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      refreshMetaResults: [false, false],
      runCatchupResult: { peersSucceeded: 1, dataSynced: 7, sharedMemorySynced: 11, denied: false },
    });
    (agent as any).localApprovedAgentByCG.set(
      'test-cg-missing-authoritative-meta',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync(
      'test-cg-missing-authoritative-meta',
      CURATOR_PEER,
    );

    expect(calls.refreshMetaCalls).toHaveLength(2);
    expect(calls.runCatchupCalls).toHaveLength(1);
    expect(calls.broadcastCalls).toEqual([{
      cg: 'test-cg-missing-authoritative-meta',
      includeSwm: true,
    }]);
  }, 15000);

  it('falls back to broadcast when the curator metadata refresh throws', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      connectedPeers: [CURATOR_PEER],
      refreshMetaResults: [new Error('curator metadata unavailable')],
      runCatchupResult: { peersSucceeded: 1, dataSynced: 7, sharedMemorySynced: 11, denied: false },
    });
    (agent as any).localApprovedAgentByCG.set(
      'test-cg-refresh-throws',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-refresh-throws', CURATOR_PEER);

    expect(calls.refreshMetaCalls).toHaveLength(1);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toEqual([{
      cg: 'test-cg-refresh-throws',
      includeSwm: true,
    }]);
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
  it('falls back to broadcast when curator fails network admission', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    const calls = installStubs(agent, {
      ensureAdmitted: async () => false,
      connectedPeers: [CURATOR_PEER],
      runCatchupResult: { peersSucceeded: 1, dataSynced: 7, sharedMemorySynced: 11, denied: false },
    });

    (agent as any).localApprovedAgentByCG.set(
      'test-cg-admission-denied',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-admission-denied', CURATOR_PEER);

    expect(calls.ensureAdmittedCalls).toEqual([CURATOR_PEER]);
    expect(calls.ensurePeerConnectedCalls).toHaveLength(0);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toHaveLength(1);
    expect(calls.broadcastCalls[0]).toMatchObject({
      cg: 'test-cg-admission-denied',
      includeSwm: true,
    });
  }, 15000);

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

    (agent as any).localApprovedAgentByCG.set(
      'test-cg-throw',
      agent.getDefaultAgentAddress()?.toLowerCase(),
    );

    await (agent as any).runImmediatePostApprovalSync('test-cg-throw', CURATOR_PEER);

    expect(calls.ensureAdmittedCalls).toEqual([CURATOR_PEER]);
    expect(calls.ensurePeerConnectedCalls).toEqual([CURATOR_PEER]);
    expect(calls.runCatchupCalls).toHaveLength(0);
    expect(calls.broadcastCalls).toHaveLength(1);
    expect(calls.broadcastCalls[0]).toMatchObject({
      cg: 'test-cg-throw',
      includeSwm: true,
    });
  }, 15000);
});
