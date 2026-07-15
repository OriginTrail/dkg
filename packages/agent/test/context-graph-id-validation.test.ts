import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import {
  DKG_ONTOLOGY,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  NoChainAdapter,
  type ChainAdapter,
} from '@origintrail-official/dkg-chain';
import {
  GraphManager,
  OxigraphStore,
} from '@origintrail-official/dkg-storage';

describe('context graph ID validation', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  const makeAgent = async (
    store: OxigraphStore,
    chainAdapter: ChainAdapter = new NoChainAdapter(),
  ) => DKGAgent.create({
    name: 'ContextGraphIdGuardNode',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter,
    nodeRole: 'core',
    skills: [],
  });

  it('rejects new context graph IDs that alias structural storage partitions', async () => {
    const store = new OxigraphStore();
    agent = await makeAgent(store);

    await expect(
      agent.createContextGraph({ id: 'victim/_meta', name: 'Namespace collision' }),
    ).rejects.toThrow(/reserved storage partition/);

    const result = await store.query(
      'SELECT ?p WHERE { GRAPH ?g { <did:dkg:context-graph:victim/_meta> ?p ?o } }',
    );
    expect(result.type === 'bindings' && result.bindings).toHaveLength(0);
  });

  it('rejects fresh local bootstrap IDs before inserting registration metadata', async () => {
    const store = new OxigraphStore();
    agent = await makeAgent(store);

    await expect(agent.ensureContextGraphLocal({
      id: 'victim/_meta',
      name: 'Namespace collision',
    })).rejects.toThrow(/reserved storage partition/);

    const result = await store.query(
      'SELECT ?p WHERE { GRAPH ?g { <did:dkg:context-graph:victim/_meta> ?p ?o } }',
    );
    expect(result.type === 'bindings' && result.bindings).toHaveLength(0);
  });

  it('rejects direct registration of a pre-existing reserved ID before chain access', async () => {
    const store = new OxigraphStore();
    const id = 'victim/_meta';
    await new GraphManager(store).ensureContextGraph(id);
    await store.insert([{
      subject: `did:dkg:context-graph:${id}`,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: contextGraphMetaUri(id),
    }]);
    const chain = new MockChainAdapter('mock:31337');
    const createOnChainContextGraph = vi.spyOn(chain, 'createOnChainContextGraph');
    agent = await makeAgent(store, chain);

    await expect(agent.registerContextGraph(id))
      .rejects.toThrow(/reserved storage partition/);
    expect(createOnChainContextGraph).not.toHaveBeenCalled();
  });
});
