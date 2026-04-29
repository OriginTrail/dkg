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
        expect(result.bindings[0]['val']).toBe('"42"^^<http://www.w3.org/2001/XMLSchema#integer>');
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

    it('round-trips literals with embedded quotes and newlines', async () => {
      const raw = '{"name":"Alice \\"The Great\\"","bio":"line1\\nline2"}';
      const escaped = escapeNQuads(raw);
      await store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/data',
        object: `"${escaped}"`,
        graph: 'http://ex.org/g',
      }]);

      const result = await store.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }',
      );
      expect(result.type).toBe('quads');
      if (result.type === 'quads') {
        expect(result.quads.length).toBe(1);
        const obj = result.quads[0].object;
        expect(obj).toContain('Alice');
      }
    });

    it('close is idempotent — a second close() resolves without throwing', async () => {
      // Teardown paths (overlapping lifecycle events, double-unmount in UI
      // hosts, shutdown signal racing with manual close) frequently call
      // close() twice. This asserts the contract: the second call must
      // resolve cleanly instead of throwing a "worker terminated" /
      // "connection ended" error that would surface as a teardown failure.
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
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
  // Blazegraph is a stateful, shared service — every test in the
  // conformance suite is built around an empty store, so we must
  // wipe the entire kb namespace before handing the adapter to a
  // new test. The cheapest reliable wipe is `DROP ALL`, which
  // removes every named graph and the default graph in a single
  // SPARQL update. This keeps the conformance suite hermetic
  // across re-runs and across the OxigraphStore baseline (which
  // is naturally per-test because it's in-memory).
  tripleStoreConformanceSuite('BlazegraphStore', async () => {
    const store = new BlazegraphStore(blazeUrl);
    const res = await fetch(blazeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `update=${encodeURIComponent('DROP ALL')}`,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Blazegraph DROP ALL failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return store;
  });
}
// NOTE: previously this branch ran `it.skip('requires a running Blazegraph …', () => {})`
// as a placeholder to surface the skip in the reporter. That empty stub added
// one "skipped" counter but carried no assertion, so it only existed to
// decorate the output. The conformance suite above is what actually exercises
// Blazegraph when `BLAZEGRAPH_URL` is set, so the placeholder was noise —
// removed to keep the suite strictly assertion-backed.

// ---------------------------------------------------------------------------
// Adapter registry / factory tests
// ---------------------------------------------------------------------------

describe('createTripleStore factory', () => {
  it('all built-in backends are registered (factory throws something other than "Unknown TripleStore backend")', async () => {
    // The *registry* contract being tested here is: every built-in
    // backend name is recognized. The construction itself may require
    // options (blazegraph needs `url`, sparql-http needs `queryEndpoint`)
    // or worker artifacts (oxigraph-worker needs the compiled worker
    // impl). So a backend passes this test iff calling `createTripleStore`
    // either succeeds OR throws a *non*-"Unknown TripleStore backend"
    // error.
    //
    // The previous version of this test used `.resolves.not.toThrow()`
    // inside a catch-that-returned-'registered', which made the test
    // effectively assert "a promise settled" — noise. This version
    // asserts the positive contract explicitly and points at the
    // specific failing backend if the registry regresses.
    const backends = ['oxigraph', 'oxigraph-worker', 'blazegraph', 'sparql-http'];
    for (const backend of backends) {
      let outcome: 'constructed' | Error;
      try {
        const store = await createTripleStore({ backend });
        outcome = 'constructed';
        try { await store.close(); } catch { /* close failures not in scope here */ }
      } catch (err) {
        outcome = err as Error;
      }
      if (outcome instanceof Error) {
        expect(
          outcome.message,
          `backend "${backend}" surfaced "Unknown TripleStore backend" — registry regressed`,
        ).not.toMatch(/Unknown TripleStore backend/);
      }
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

  it('oxigraph-worker adapter is registered and round-trips an insert', async () => {
    // The worker adapter resolves `./oxigraph-worker-impl.js` relative to
    // the module loaded at runtime. When vitest runs against raw source
    // without a prior `pnpm build`, that URL lands in `src/adapters/` where
    // only the .ts files live, so the Worker constructor throws
    // "Cannot find module … oxigraph-worker-impl.js".
    //
    // This used to be caught and converted to `ctx.skip()`, which meant a
    // green CI run even when the worker artifact was missing — i.e. a
    // broken build never triggered a test failure. We now FAIL LOUDLY in
    // that case with a remediation hint, so:
    //   • locally, the developer sees "run pnpm build first" instead of a
    //     silent skip;
    //   • in CI, if `pnpm build` was not wired into the lane (or the build
    //     regresses), this test surfaces it as a red failure.
    let store: Awaited<ReturnType<typeof createTripleStore>>;
    try {
      store = await createTripleStore({ backend: 'oxigraph-worker' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Cannot find module') && msg.includes('oxigraph-worker-impl')) {
        throw new Error(
          `oxigraph-worker adapter is not runnable — the compiled ` +
          `oxigraph-worker-impl.js artifact is missing from ` +
          `packages/storage/dist/adapters/. Run ` +
          `\`pnpm --filter @origintrail-official/dkg-storage build\` ` +
          `before running this test. Underlying error: ${msg}`,
        );
      }
      throw err;
    }
    await store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"hi"',
      graph: 'http://ex.org/g',
    }]);
    expect(await store.countQuads()).toBe(1);
    await store.close();
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

  it('generates correct graph URIs (V10 context-graph prefix)', () => {
    expect(gm.dataGraphUri('agent-registry')).toBe('did:dkg:context-graph:agent-registry');
    expect(gm.metaGraphUri('agent-registry')).toBe('did:dkg:context-graph:agent-registry/_meta');
  });

  it('lists context graphs', async () => {
    await store.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'did:dkg:context-graph:test1' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'did:dkg:context-graph:test1/_meta' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"c"', graph: 'did:dkg:context-graph:test2' },
    ]);
    const cgs = await gm.listContextGraphs();
    expect(cgs.sort()).toEqual(['test1', 'test2']);
  });

  it('keeps listSubGraphs as a deprecated compatibility shim', async () => {
    await store.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'did:dkg:context-graph:test1/code' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'did:dkg:context-graph:test1/decisions/_meta' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"c"', graph: 'did:dkg:context-graph:test1/_meta' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"d"', graph: 'did:dkg:context-graph:test1/assertion/agent/name' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"e"', graph: 'did:dkg:context-graph:test2/notes' },
    ]);

    const subGraphs = await gm.listSubGraphs('test1');
    expect(subGraphs.sort()).toEqual(['code', 'decisions']);
  });

  it('drops context graph', async () => {
    await store.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"a"', graph: 'did:dkg:context-graph:x' },
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"b"', graph: 'did:dkg:context-graph:x/_meta' },
    ]);
    await gm.dropContextGraph('x');
    expect(await gm.hasContextGraph('x')).toBe(false);
  });
});

function escapeNQuads(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

describe('N-Quads literal escaping (regression for parser errors)', () => {
  it('OxigraphStore: CONSTRUCT returns valid N-Quads for JSON-like literals', async () => {
    const store = new OxigraphStore();
    const gameStateJson = '{"party":[{"name":"Alice","health":100}],"morale":80}';
    await store.insert([
      {
        subject: 'urn:test:turn:1',
        predicate: 'http://ex.org/gameState',
        object: `"${escapeNQuads(gameStateJson)}"`,
        graph: 'http://ex.org/shared-memory',
      },
      {
        subject: 'urn:test:turn:1',
        predicate: 'http://ex.org/message',
        object: `"${escapeNQuads('Line1\nLine2\r\nLine3')}"`,
        graph: 'http://ex.org/shared-memory',
      },
    ]);

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <http://ex.org/shared-memory> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.length).toBe(2);

    for (const q of result.quads) {
      expect(q.object.startsWith('"')).toBe(true);
    }
    await store.close();
  });

  it('OxigraphStore: re-inserting CONSTRUCT output succeeds (no parser error)', async () => {
    const store = new OxigraphStore();
    const raw = '{"key":"value with \\"quotes\\"","multi":"line1\\nline2"}';
    await store.insert([{
      subject: 'urn:test:entity',
      predicate: 'http://ex.org/data',
      object: `"${escapeNQuads(raw)}"`,
      graph: 'http://ex.org/ws',
    }]);

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <http://ex.org/ws> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;

    const store2 = new OxigraphStore();
    await expect(
      store2.insert(result.quads.map(q => ({ ...q, graph: 'http://ex.org/target' }))),
    ).resolves.not.toThrow();

    expect(await store2.countQuads('http://ex.org/target')).toBe(1);
    await store.close();
    await store2.close();
  });

  it('OxigraphStore: deeply nested JSON round-trips through CONSTRUCT', async () => {
    const store = new OxigraphStore();
    const json = JSON.stringify({
      party: [{ name: 'Alice "The Great"', health: 100, bio: 'line1\nline2' }],
      morale: 80,
    });
    await store.insert([{
      subject: 'urn:test:turn:deep',
      predicate: 'http://ex.org/state',
      object: `"${escapeNQuads(json)}"`,
      graph: 'http://ex.org/ws',
    }]);

    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <http://ex.org/ws> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    if (result.type !== 'quads') return;
    expect(result.quads.length).toBe(1);

    const store2 = new OxigraphStore();
    await expect(
      store2.insert(result.quads.map(q => ({ ...q, graph: 'http://ex.org/target' }))),
    ).resolves.not.toThrow();

    const final = await store2.query(
      'SELECT ?o WHERE { GRAPH <http://ex.org/target> { ?s <http://ex.org/state> ?o } }',
    );
    expect(final.type).toBe('bindings');
    if (final.type === 'bindings') {
      const nquadVal = final.bindings[0]['o'];
      expect(nquadVal).toContain('Alice');
      expect(nquadVal).toContain('The Great');
    }

    await store.close();
    await store2.close();
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
    const contextGraph = 'agent-registry';
    const quads: Quad[] = [
      {
        subject: entity,
        predicate: 'http://ex.org/secret',
        object: '"hidden"',
        graph: '',
      },
    ];
    await ps.storePrivateTriples(contextGraph, entity, quads);
    expect(ps.hasPrivateTriples(contextGraph, entity)).toBe(true);

    const retrieved = await ps.getPrivateTriples(contextGraph, entity);
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

  it('storePrivateTriples with empty quads is a no-op', async () => {
    const entity = 'did:dkg:agent:NoOp';
    await ps.storePrivateTriples('cg-1', entity, []);
    expect(ps.hasPrivateTriples('cg-1', entity)).toBe(false);
  });

  it('hasPrivateTriples returns false before any data is stored', () => {
    expect(ps.hasPrivateTriples('unknown-cg', 'urn:x')).toBe(false);
  });

  it('stores and retrieves private triples with subGraphName', async () => {
    const entity = 'did:dkg:agent:QmSubGraph';
    const quads: Quad[] = [
      { subject: entity, predicate: 'http://ex.org/sg', object: '"subgraph-val"', graph: '' },
    ];
    await ps.storePrivateTriples('cg-sg', entity, quads, 'my-sub');
    expect(ps.hasPrivateTriples('cg-sg', entity, 'my-sub')).toBe(true);
    expect(ps.hasPrivateTriples('cg-sg', entity)).toBe(false);

    const retrieved = await ps.getPrivateTriples('cg-sg', entity, 'my-sub');
    expect(retrieved.length).toBe(1);
    expect(retrieved[0].object).toBe('"subgraph-val"');
  });

  it('deletes private triples with subGraphName', async () => {
    const entity = 'did:dkg:agent:QmSubDel';
    await ps.storePrivateTriples('cg-del', entity, [
      { subject: entity, predicate: 'http://ex.org/p', object: '"x"', graph: '' },
    ], 'sub-del');

    await ps.deletePrivateTriples('cg-del', entity, 'sub-del');
    expect(ps.hasPrivateTriples('cg-del', entity, 'sub-del')).toBe(false);
    const remaining = await ps.getPrivateTriples('cg-del', entity, 'sub-del');
    expect(remaining.length).toBe(0);
  });

  it('clearCache removes in-memory tracker for a context graph', async () => {
    const entity = 'did:dkg:agent:QmCacheClear';
    await ps.storePrivateTriples('cg-cache', entity, [
      { subject: entity, predicate: 'http://ex.org/p', object: '"val"', graph: '' },
    ]);
    expect(ps.hasPrivateTriples('cg-cache', entity)).toBe(true);

    ps.clearCache('cg-cache');
    // In-memory tracker cleared, but data is still in store
    expect(ps.hasPrivateTriples('cg-cache', entity)).toBe(false);
    const inStore = await ps.hasPrivateTriplesInStore('cg-cache', entity);
    expect(inStore).toBe(true);
  });

  it('hasPrivateTriplesInStore returns false when no data exists', async () => {
    const result = await ps.hasPrivateTriplesInStore('empty-cg', 'urn:nothing');
    expect(result).toBe(false);
  });

  it('multiple entities can coexist in the same context graph', async () => {
    const e1 = 'did:dkg:agent:Multi1';
    const e2 = 'did:dkg:agent:Multi2';

    await ps.storePrivateTriples('cg-multi', e1, [
      { subject: e1, predicate: 'http://ex.org/p', object: '"v1"', graph: '' },
    ]);
    await ps.storePrivateTriples('cg-multi', e2, [
      { subject: e2, predicate: 'http://ex.org/p', object: '"v2"', graph: '' },
    ]);

    expect(ps.hasPrivateTriples('cg-multi', e1)).toBe(true);
    expect(ps.hasPrivateTriples('cg-multi', e2)).toBe(true);

    await ps.deletePrivateTriples('cg-multi', e1);
    expect(ps.hasPrivateTriples('cg-multi', e1)).toBe(false);
    expect(ps.hasPrivateTriples('cg-multi', e2)).toBe(true);
  });
});
