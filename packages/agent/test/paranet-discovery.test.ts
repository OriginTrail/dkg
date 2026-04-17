import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { DKGAgent, type ContextGraphSub } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SYSTEM_PARANETS, DKG_ONTOLOGY, paranetDataGraphUri } from '@origintrail-official/dkg-core';
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
}) {
  const store = opts?.store ?? new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'ParanetTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: opts?.chainAdapter ?? createEVMAdapter(HARDHAT_KEYS.CORE_OP),
  });
  return { agent, store };
}

describe('ensureContextGraphLocal', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('creates a paranet if it does not exist', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'test-paranet', name: 'Test Paranet' });

    const exists = await agent.contextGraphExists('test-paranet');
    expect(exists).toBe(true);

    const sub = agent.getSubscribedContextGraphs().get('test-paranet');
    expect(sub).toBeDefined();
    expect(sub!.subscribed).toBe(true);
    expect(sub!.synced).toBe(true);
    expect(sub!.name).toBe('Test Paranet');
  }, 15000);

  it('is idempotent — calling twice does not throw or duplicate triples', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'idem-test', name: 'Idempotent' });
    await agent.ensureContextGraphLocal({ id: 'idem-test', name: 'Idempotent' });

    const exists = await agent.contextGraphExists('idem-test');
    expect(exists).toBe(true);

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const countResult = await result.store.query(`
      SELECT (COUNT(*) AS ?c) WHERE {
        GRAPH <${ontologyGraph}> {
          <${paranetDataGraphUri('idem-test')}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}>
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
      description: 'Default paranet: special-chars (test)',
    });

    const exists = await agent.contextGraphExists('special-chars');
    expect(exists).toBe(true);

    const paranets = await agent.listContextGraphs();
    const entry = paranets.find(p => p.id === 'special-chars');
    expect(entry?.description).toBe('Default paranet: special-chars (test)');
  }, 15000);
});

describe('discoverContextGraphsFromStore', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers paranets from ONTOLOGY graph and auto-subscribes', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = paranetDataGraphUri('discovered-paranet');
    await store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Discovered Paranet"', graph: ontologyGraph },
    ]);

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(1);

    const sub = agent.getSubscribedContextGraphs().get('discovered-paranet');
    expect(sub).toBeDefined();
    expect(sub!.subscribed).toBe(true);
    expect(sub!.synced).toBe(true);
    expect(sub!.name).toBe('Discovered Paranet');
  }, 15000);

  it('does not re-discover already known paranets', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'already-known', name: 'Already Known' });

    const discovered = await agent.discoverContextGraphsFromStore();
    expect(discovered).toBe(0);
  }, 15000);

  it('skips system paranets (agents, ontology)', async () => {
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

  it('returns synced paranets with subscribed=true', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureContextGraphLocal({ id: 'synced-paranet', name: 'Synced' });

    const paranets = await agent.listContextGraphs();
    const entry = paranets.find(p => p.id === 'synced-paranet');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(true);
    expect(entry!.name).toBe('Synced');
  }, 15000);

  it('includes subscribed-but-not-synced paranets from registry', async () => {
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

    const paranets = await agent.listContextGraphs();
    const entry = paranets.find(p => p.id === 'chain-only');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(false);
    expect(entry!.name).toBe('Chain Only');
  }, 15000);

  it('marks SPARQL-only paranets (not in registry) as subscribed=false', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = paranetDataGraphUri('unsubscribed');
    await store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Unsubscribed"', graph: ontologyGraph },
    ]);

    const paranets = await agent.listContextGraphs();
    const entry = paranets.find(p => p.id === 'unsubscribed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(false);
    expect(entry!.synced).toBe(true);
  }, 15000);
});

describe('discoverContextGraphsFromChain', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers on-chain paranets with cleartext name and auto-subscribes', async () => {
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

  it('skips hash-only on-chain paranets without metadata', async () => {
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

  it('skips already known on-chain paranets', async () => {
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

  it('chain discovery then ontology sync produces one merged entry, no ghost 0x paranet', async () => {
    const localName = 'merged-paranet';
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

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = paranetDataGraphUri(localName);
    await store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${localName}"`, graph: ontologyGraph },
    ]);
    const storeDiscovered = await agent.discoverContextGraphsFromStore();
    expect(storeDiscovered).toBeLessThanOrEqual(1);

    const paranets = await agent.listContextGraphs();
    const matches = paranets.filter(p => p.id === localName || p.id === expectedHash);
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe(localName);
    expect(matches[0].subscribed).toBe(true);
    expect(matches[0].synced).toBe(true);

    const ghosts = paranets.filter(p => p.id.startsWith('0x'));
    expect(ghosts.length).toBe(0);
  }, 15000);
});
