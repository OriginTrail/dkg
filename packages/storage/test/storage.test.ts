import { describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphStore,
  BlazegraphStore,
  GraphManager,
  PrivateContentStore,
  createTripleStore,
  registerTripleStoreAdapter,
  type Quad,
  type TripleStore,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared TripleStore conformance suite — runs against every backend
// ---------------------------------------------------------------------------

function tripleStoreConformanceSuite(name: string, factory: () => Promise<TripleStore>) {
  describe(`TripleStore conformance: ${name}`, () => {
    let store: TripleStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('inserts and queries quads', async () => {
      const quads: Quad[] = [
        {
          subject: 'http://ex.org/alice',
          predicate: 'http://schema.org/name',
          object: '"Alice"',
          graph: 'http://ex.org/g1',
        },
      ];
      await store.insert(quads);
      const result = await store.query(
        'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]['name']).toBe('"Alice"');
      }
    });

    it('deletes quads', async () => {
      const q: Quad = {
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"val"',
        graph: 'http://ex.org/g',
      };
      await store.insert([q]);
      expect(await store.countQuads()).toBeGreaterThanOrEqual(1);
      await store.delete([q]);
      expect(await store.countQuads('http://ex.org/g')).toBe(0);
    });

    it('deleteByPattern removes matching quads', async () => {
      await store.insert([
        { subject: 'http://ex.org/s1', predicate: 'http://ex.org/p', object: '"a"', graph: 'http://ex.org/g' },
        { subject: 'http://ex.org/s2', predicate: 'http://ex.org/p', object: '"b"', graph: 'http://ex.org/g' },
      ]);
      const removed = await store.deleteByPattern({ subject: 'http://ex.org/s1' });
      expect(removed).toBe(1);
      expect(await store.countQuads('http://ex.org/g')).toBe(1);
    });

    it('deleteBySubjectPrefix', async () => {
      const g = 'http://ex.org/g';
      await store.insert([
        { subject: 'did:dkg:agent:Bot', predicate: 'http://schema.org/name', object: '"Bot"', graph: g },
        { subject: 'did:dkg:agent:Bot/.well-known/genid/o1', predicate: 'http://ex.org/p', object: '"x"', graph: g },
        { subject: 'did:dkg:agent:Other', predicate: 'http://ex.org/p', object: '"y"', graph: g },
      ]);
      const removed = await store.deleteBySubjectPrefix(g, 'did:dkg:agent:Bot');
      expect(removed).toBe(2);
      expect(await store.countQuads(g)).toBe(1);
    });

    it('listGraphs', async () => {
      await store.insert([
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'http://ex.org/g1' },
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'http://ex.org/g2' },
      ]);
      const graphs = await store.listGraphs();
      expect(graphs.sort()).toContain('http://ex.org/g1');
      expect(graphs.sort()).toContain('http://ex.org/g2');
    });

    it('dropGraph', async () => {
      await store.insert([
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'http://ex.org/g1' },
      ]);
      expect(await store.hasGraph('http://ex.org/g1')).toBe(true);
      await store.dropGraph('http://ex.org/g1');
      expect(await store.hasGraph('http://ex.org/g1')).toBe(false);
    });

    it('handles typed literals', async () => {
      await store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/count',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: 'http://ex.org/g',
      }]);
      const result = await store.query(
        'SELECT ?val WHERE { GRAPH <http://ex.org/g> { ?s <http://ex.org/count> ?val } }',
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings[0]['val']).toContain('42');
      }
    });

    it('countQuads with and without graph filter', async () => {
      await store.insert([
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'http://ex.org/g1' },
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'http://ex.org/g2' },
      ]);
      expect(await store.countQuads('http://ex.org/g1')).toBe(1);
      expect(await store.countQuads()).toBeGreaterThanOrEqual(2);
    });

    it('close is idempotent', async () => {
      await store.close();
      await store.close();
    });
  });
}

// Run conformance suite against OxigraphStore (direct constructor)
tripleStoreConformanceSuite('OxigraphStore (direct)', async () => new OxigraphStore());

// Run conformance suite against OxigraphStore via factory (validates adapter registration)
tripleStoreConformanceSuite('OxigraphStore (factory)', async () => createTripleStore({ backend: 'oxigraph' }));

// BlazegraphStore conformance runs only when Blazegraph is reachable.
// Set BLAZEGRAPH_URL=http://127.0.0.1:9999/bigdata/namespace/test/sparql to enable.
const blazeUrl = process.env.BLAZEGRAPH_URL;
if (blazeUrl) {
  tripleStoreConformanceSuite('BlazegraphStore', async () => new BlazegraphStore(blazeUrl));
} else {
  describe('BlazegraphStore (skipped — set BLAZEGRAPH_URL to run)', () => {
    it.skip('requires a running Blazegraph instance', () => {});
  });
}

// ---------------------------------------------------------------------------
// Adapter registry / factory tests
// ---------------------------------------------------------------------------

describe('createTripleStore factory', () => {
  it('all built-in backends are registered', async () => {
    const backends = ['oxigraph', 'oxigraph-worker', 'blazegraph', 'sparql-http'];
    for (const backend of backends) {
      await expect(
        createTripleStore({ backend }).catch((err: Error) => {
          if (err.message.includes('Unknown TripleStore backend')) throw err;
          return 'registered';
        }),
      ).resolves.not.toThrow();
    }
  });

  it('creates oxigraph store via registry', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    await store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"test"',
      graph: 'http://ex.org/g',
    }]);
    expect(await store.countQuads()).toBe(1);
    await store.close();
  });

  it('blazegraph adapter is registered', async () => {
    await expect(createTripleStore({ backend: 'blazegraph' })).rejects.toThrow(
      'options.url',
    );
  });

  it('sparql-http adapter is registered and requires queryEndpoint', async () => {
    await expect(createTripleStore({ backend: 'sparql-http' })).rejects.toThrow(
      'queryEndpoint',
    );
    await expect(
      createTripleStore({ backend: 'sparql-http', options: {} }),
    ).rejects.toThrow('queryEndpoint');
  });

  it('oxigraph-worker adapter is registered', async () => {
    try {
      const store = await createTripleStore({ backend: 'oxigraph-worker' });
      await store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"hi"',
        graph: 'http://ex.org/g',
      }]);
      expect(await store.countQuads()).toBe(1);
      await store.close();
    } catch (err: unknown) {
      // Worker file may not exist when running tests against uncompiled source
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Cannot find module') && msg.includes('oxigraph-worker-impl')) {
        expect(true).toBe(true);
        return;
      }
      throw err;
    }
  });

  it('throws on unknown backend', async () => {
    await expect(createTripleStore({ backend: 'unknown' })).rejects.toThrow(
      'Unknown TripleStore backend',
    );
  });

  it('custom adapter can be registered and used', async () => {
    const calls: string[] = [];
    registerTripleStoreAdapter('test-custom', async () => ({
      insert: async () => { calls.push('insert'); },
      delete: async () => {},
      deleteByPattern: async () => 0,
      query: async () => ({ type: 'bindings' as const, bindings: [] }),
      hasGraph: async () => false,
      createGraph: async () => {},
      dropGraph: async () => {},
      listGraphs: async () => [],
      deleteBySubjectPrefix: async () => 0,
      countQuads: async () => calls.length,
      close: async () => {},
    }));

    const store = await createTripleStore({ backend: 'test-custom' });
    await store.insert([]);
    expect(calls).toEqual(['insert']);
    expect(await store.countQuads()).toBe(1);
  });
});

describe('GraphManager', () => {
  let store: TripleStore;
  let gm: GraphManager;

  beforeEach(() => {
    store = new OxigraphStore();
    gm = new GraphManager(store);
  });

  it('generates correct graph URIs', () => {
    expect(gm.dataGraphUri('agent-registry')).toBe('did:dkg:paranet:agent-registry');
    expect(gm.metaGraphUri('agent-registry')).toBe('did:dkg:paranet:agent-registry/_meta');
  });

  it('lists paranets', async () => {
    await store.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'did:dkg:paranet:test1' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'did:dkg:paranet:test1/_meta' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"c"', graph: 'did:dkg:paranet:test2' },
    ]);
    const paranets = await gm.listParanets();
    expect(paranets.sort()).toEqual(['test1', 'test2']);
  });

  it('drops paranet', async () => {
    await store.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'did:dkg:paranet:x' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'did:dkg:paranet:x/_meta' },
    ]);
    await gm.dropParanet('x');
    expect(await gm.hasParanet('x')).toBe(false);
  });
});

describe('PrivateContentStore', () => {
  let store: TripleStore;
  let gm: GraphManager;
  let ps: PrivateContentStore;

  beforeEach(() => {
    store = new OxigraphStore();
    gm = new GraphManager(store);
    ps = new PrivateContentStore(store, gm);
  });

  it('stores and retrieves private triples', async () => {
    const entity = 'did:dkg:agent:QmBot';
    const paranet = 'agent-registry';
    const quads: Quad[] = [
      {
        subject: entity,
        predicate: 'http://ex.org/secret',
        object: '"hidden"',
        graph: '',
      },
    ];
    await ps.storePrivateTriples(paranet, entity, quads);
    expect(ps.hasPrivateTriples(paranet, entity)).toBe(true);

    const retrieved = await ps.getPrivateTriples(paranet, entity);
    expect(retrieved.length).toBe(1);
    expect(retrieved[0].subject).toBe(entity);
    expect(retrieved[0].object).toBe('"hidden"');
  });

  it('deletes private triples', async () => {
    const entity = 'did:dkg:agent:QmBot';
    await ps.storePrivateTriples('p1', entity, [
      { subject: entity, predicate: 'http://ex.org/p', object: '"val"', graph: '' },
    ]);
    await ps.deletePrivateTriples('p1', entity);
    expect(ps.hasPrivateTriples('p1', entity)).toBe(false);
    const remaining = await ps.getPrivateTriples('p1', entity);
    expect(remaining.length).toBe(0);
  });
});
