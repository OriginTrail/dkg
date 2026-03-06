import { describe, it, expect, afterEach } from 'vitest';
import { DKGAgent, type ParanetSub } from '../src/index.js';
import { OxigraphStore } from '@dkg/storage';
import { SYSTEM_PARANETS, DKG_ONTOLOGY, paranetDataGraphUri } from '@dkg/core';
import { MockChainAdapter, type ParanetOnChain } from '@dkg/chain';

class MockChainWithParanets extends MockChainAdapter {
  private readonly onChainList: ParanetOnChain[];

  constructor(list: ParanetOnChain[] = []) {
    super();
    this.onChainList = list;
  }

  override async listParanetsFromChain(): Promise<ParanetOnChain[]> {
    return this.onChainList;
  }
}

async function createTestAgent(opts?: {
  chainAdapter?: MockChainAdapter | MockChainWithParanets;
  store?: OxigraphStore;
}) {
  const store = opts?.store ?? new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'ParanetTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: opts?.chainAdapter ?? new MockChainAdapter(),
  });
  return { agent, store };
}

describe('ensureParanetLocal', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('creates a paranet if it does not exist', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureParanetLocal({ id: 'test-paranet', name: 'Test Paranet' });

    const exists = await agent.paranetExists('test-paranet');
    expect(exists).toBe(true);

    const sub = agent.getSubscribedParanets().get('test-paranet');
    expect(sub).toBeDefined();
    expect(sub!.subscribed).toBe(true);
    expect(sub!.synced).toBe(true);
    expect(sub!.name).toBe('Test Paranet');
  }, 15000);

  it('is idempotent — calling twice does not throw or duplicate triples', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureParanetLocal({ id: 'idem-test', name: 'Idempotent' });
    await agent.ensureParanetLocal({ id: 'idem-test', name: 'Idempotent' });

    const exists = await agent.paranetExists('idem-test');
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
    const chain = new MockChainAdapter();
    // Pre-create on chain so ensureParanetLocal hits the "already exists" path
    await chain.createParanet({ name: 'pre-existing', accessPolicy: 0 });

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    // Should not throw
    await agent.ensureParanetLocal({ id: 'pre-existing', name: 'Pre Existing' });

    const exists = await agent.paranetExists('pre-existing');
    expect(exists).toBe(true);

    const sub = agent.getSubscribedParanets().get('pre-existing');
    expect(sub?.subscribed).toBe(true);
    expect(sub?.synced).toBe(true);
  }, 15000);

  it('handles descriptions with special characters without parser errors', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    // Colons, slashes, parentheses — should not break nquads serialization
    await agent.ensureParanetLocal({
      id: 'special-chars',
      name: 'Special Chars',
      description: 'Default paranet: special-chars (test)',
    });

    const exists = await agent.paranetExists('special-chars');
    expect(exists).toBe(true);

    const paranets = await agent.listParanets();
    const entry = paranets.find(p => p.id === 'special-chars');
    expect(entry?.description).toBe('Default paranet: special-chars (test)');
  }, 15000);
});

describe('discoverParanetsFromStore', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers paranets from ONTOLOGY graph and auto-subscribes', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    // Manually insert a paranet definition into the ontology graph
    // (simulating what sync would deliver)
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = paranetDataGraphUri('discovered-paranet');
    await store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Discovered Paranet"', graph: ontologyGraph },
    ]);

    const discovered = await agent.discoverParanetsFromStore();
    expect(discovered).toBe(1);

    const sub = agent.getSubscribedParanets().get('discovered-paranet');
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

    await agent.ensureParanetLocal({ id: 'already-known', name: 'Already Known' });

    const discovered = await agent.discoverParanetsFromStore();
    expect(discovered).toBe(0);
  }, 15000);

  it('skips system paranets (agents, ontology)', async () => {
    const store = new OxigraphStore();
    const result = await createTestAgent({ store });
    agent = result.agent;
    await agent.start();

    // System paranets are already in the store from genesis
    const discovered = await agent.discoverParanetsFromStore();
    expect(discovered).toBe(0);
  }, 15000);
});

describe('listParanets merge', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('returns synced paranets with subscribed=true', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.ensureParanetLocal({ id: 'synced-paranet', name: 'Synced' });

    const paranets = await agent.listParanets();
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

    // Simulate a chain-discovered paranet (subscribed but no triples)
    agent.subscribeToParanet('chain-only');
    // Manually set the registry entry to not-synced
    (agent as any).subscribedParanets.set('chain-only', {
      name: 'Chain Only',
      subscribed: true,
      synced: false,
      onChainId: '0xabc123',
    });

    const paranets = await agent.listParanets();
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

    // Insert triples directly (simulating a peer-synced paranet we didn't subscribe to)
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = paranetDataGraphUri('unsubscribed');
    await store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Unsubscribed"', graph: ontologyGraph },
    ]);

    const paranets = await agent.listParanets();
    const entry = paranets.find(p => p.id === 'unsubscribed');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(false);
    expect(entry!.synced).toBe(true);
  }, 15000);
});

describe('discoverParanetsFromChain', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('discovers on-chain paranets and auto-subscribes', async () => {
    const chain = new MockChainWithParanets([
      {
        paranetId: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 100,
        metadataRevealed: false,
      },
    ]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverParanetsFromChain();
    expect(discovered).toBe(1);

    const subs = agent.getSubscribedParanets();
    const found = [...subs.entries()].find(([, s]) =>
      s.onChainId === '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
    );
    expect(found).toBeDefined();
    expect(found![1].subscribed).toBe(true);
    expect(found![1].synced).toBe(false);
  }, 15000);

  it('skips already known on-chain paranets', async () => {
    const chain = new MockChainWithParanets([
      {
        paranetId: '0xaaa',
        creator: '0x1234',
        accessPolicy: 0,
        blockNumber: 50,
        metadataRevealed: false,
      },
    ]);

    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    // Pre-populate the registry with the same onChainId
    (agent as any).subscribedParanets.set('known', {
      name: 'Known',
      subscribed: true,
      synced: true,
      onChainId: '0xaaa',
    });

    const discovered = await agent.discoverParanetsFromChain();
    expect(discovered).toBe(0);
  }, 15000);

  it('returns 0 when chain adapter has no listParanetsFromChain', async () => {
    const chain = new MockChainAdapter();
    // MockChainAdapter does have the method, but returns [].
    const result = await createTestAgent({ chainAdapter: chain });
    agent = result.agent;
    await agent.start();

    const discovered = await agent.discoverParanetsFromChain();
    expect(discovered).toBe(0);
  }, 15000);
});

describe('getSubscribedParanets', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('tracks subscriptions from subscribeToParanet', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    agent.subscribeToParanet('manual-sub');

    const subs = agent.getSubscribedParanets();
    const entry = subs.get('manual-sub');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
  }, 15000);

  it('tracks subscriptions from createParanet', async () => {
    const result = await createTestAgent();
    agent = result.agent;
    await agent.start();

    await agent.createParanet({ id: 'created-p', name: 'Created' });

    const subs = agent.getSubscribedParanets();
    const entry = subs.get('created-p');
    expect(entry).toBeDefined();
    expect(entry!.subscribed).toBe(true);
    expect(entry!.synced).toBe(true);
    expect(entry!.name).toBe('Created');
  }, 15000);
});
