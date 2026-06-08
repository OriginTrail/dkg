import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SparqlHttpStore, createTripleStore, type Quad } from '../src/index.js';
import { LIST_GRAPHS_CACHE_TTL_MS } from '../src/adapters/sparql-http.js';

let server: Server;
let queryUrl: string;
let updateUrl: string;
const insertedQuads: string[] = [];
/** How many times the server received the `SELECT DISTINCT ?g` listGraphs scan. */
let listGraphsHits = 0;
/** When set, the server holds every listGraphs response until this resolves. */
let listGraphsGate: Promise<void> | null = null;

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const decoded = decodeURIComponent(body);
        if (req.url === '/update') {
          insertedQuads.push(decoded);
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.url === '/query') {
          if (decoded.includes('ASK')) {
            res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
            res.end(JSON.stringify({ boolean: true }));
            return;
          }
          if (decoded.includes('COUNT(*)')) {
            res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
            res.end(JSON.stringify({
              head: { vars: ['c'] },
              results: { bindings: [{ c: { type: 'literal', value: '1' } }] },
            }));
            return;
          }
          if (decoded.includes('DISTINCT') && decoded.includes('?g')) {
            listGraphsHits++;
            const respond = () => {
              res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
              res.end(JSON.stringify({
                head: { vars: ['g'] },
                results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
              }));
            };
            // Optionally hold the response so a test can keep a scan in flight.
            if (listGraphsGate) void listGraphsGate.then(respond);
            else respond();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
          res.end(JSON.stringify({
            head: { vars: ['name'] },
            results: { bindings: [{ name: { type: 'literal', value: 'Alice' } }] },
          }));
          return;
        }
        if (req.url === '/error-update') {
          res.writeHead(500);
          res.end('Server Error');
          return;
        }
        if (req.url === '/error-query') {
          res.writeHead(500);
          res.end('Error');
          return;
        }
        res.writeHead(404);
        res.end('Not Found');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      queryUrl = `http://127.0.0.1:${port}/query`;
      updateUrl = `http://127.0.0.1:${port}/update`;
      resolve();
    });
  });
}

describe('SparqlHttpStore (test server)', () => {
  let store: SparqlHttpStore;

  beforeAll(async () => {
    await startTestServer();
    store = new SparqlHttpStore({ queryEndpoint: queryUrl, updateEndpoint: updateUrl });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('insert sends INSERT DATA to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(insertedQuads.length).toBeGreaterThan(0);
    expect(insertedQuads.some(q => q.includes('INSERT'))).toBe(true);
  });

  it('query SELECT sends query to query endpoint and parses bindings', async () => {
    const result = await store.query(
      'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['name']).toBe('"Alice"');
    }
  });

  it('query ASK returns boolean', async () => {
    const result = await store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }');
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('delete sends DELETE DATA to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.delete([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('countQuads sends COUNT query and returns number', async () => {
    const n = await store.countQuads('http://ex.org/g');
    expect(n).toBe(1);
  });

  it('hasGraph sends ASK and returns boolean', async () => {
    const has = await store.hasGraph('http://ex.org/g');
    expect(has).toBe(true);
  });

  it('listGraphs returns graph URIs from SELECT DISTINCT ?g', async () => {
    const graphs = await store.listGraphs();
    expect(graphs).toContain('http://ex.org/g1');
  });

  it('dropGraph sends DROP SILENT GRAPH to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.dropGraph('http://ex.org/g1');
    expect(insertedQuads.some(q => q.includes('DROP'))).toBe(true);
  });

  it('deleteByPattern sends DELETE WHERE to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.deleteByPattern({ subject: 'http://ex.org/s', graph: 'http://ex.org/g' });
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('deleteBySubjectPrefix sends DELETE with FILTER STRSTARTS', async () => {
    insertedQuads.length = 0;
    await store.deleteBySubjectPrefix('http://ex.org/g', 'http://ex.org/');
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('uses single URL for both endpoints when updateEndpoint omitted', async () => {
    const singleUrl = queryUrl;
    const s = new SparqlHttpStore({ queryEndpoint: singleUrl });
    const has = await s.hasGraph('http://ex.org/g');
    expect(typeof has).toBe('boolean');
  });

  it('throws on insert when server returns non-OK', async () => {
    const port = (server.address() as { port: number }).port;
    const badStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: `http://127.0.0.1:${port}/error-update`,
    });
    await expect(
      badStore.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"x"', graph: '' }]),
    ).rejects.toThrow(/insert failed/);
  });

  it('throws on query when server returns non-OK', async () => {
    const port = (server.address() as { port: number }).port;
    const badStore = new SparqlHttpStore({
      queryEndpoint: `http://127.0.0.1:${port}/error-query`,
      updateEndpoint: updateUrl,
    });
    await expect(badStore.query('SELECT ?x WHERE { ?x ?y ?z }')).rejects.toThrow(/query failed/);
  });

  it('close is a no-op and stays idempotent — follow-up ops still work against the same endpoint', async () => {
    // SparqlHttpStore is stateless over HTTP, so close() is effectively a
    // no-op. The contract this test locks in: (1) close never throws and
    // resolves cleanly, (2) calling close multiple times is safe, (3) because
    // close doesn't tear down any persistent resource, a follow-up query
    // still succeeds against the same endpoint. This catches regressions
    // where someone accidentally wires close() to tear down a shared agent
    // or to set a disposed flag that would break reuse of the same instance.
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();

    const result = await store.query('SELECT ?x WHERE { ?x ?y ?z } LIMIT 1');
    expect(result.type).toBe('bindings');
  });

  // R6-A: on a daemon-owned (managed) endpoint, listGraphs() is served from an
  // in-memory cache invalidated on writes — eliminating the data-proportional
  // `SELECT DISTINCT ?g` full scan that the 30s host-mode reconcile (and
  // on-demand CG enumeration) would otherwise re-run every cycle on an idle,
  // data-rich node. External (non-managed) endpoints must NOT cache, since an
  // outside writer could add a graph we never see.
  describe('listGraphs() cache (R6-A)', () => {
    const managedStore = () =>
      new SparqlHttpStore({ queryEndpoint: queryUrl, updateEndpoint: updateUrl, managedByDkg: true });
    const g = (graph: string) =>
      [{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph }];

    it('managed endpoint serves repeated listGraphs() from cache (one scan)', async () => {
      listGraphsHits = 0;
      const store = managedStore();
      const a = await store.listGraphs();
      const b = await store.listGraphs();
      expect(a).toContain('http://ex.org/g1');
      expect(b).toContain('http://ex.org/g1');
      expect(listGraphsHits).toBe(1); // second call hit the cache, not the server
    });

    it.each(['insert', 'delete', 'deleteByPattern', 'dropGraph', 'deleteBySubjectPrefix'] as const)(
      'invalidates the cache on %s so the next listGraphs() re-scans',
      async (method) => {
        listGraphsHits = 0;
        const store = managedStore();
        await store.listGraphs();
        await store.listGraphs();
        expect(listGraphsHits).toBe(1); // warm

        switch (method) {
          case 'insert': await store.insert(g('http://ex.org/g2')); break;
          case 'delete': await store.delete(g('http://ex.org/g')); break;
          case 'deleteByPattern': await store.deleteByPattern({ graph: 'http://ex.org/g' }); break;
          case 'dropGraph': await store.dropGraph('http://ex.org/g'); break;
          case 'deleteBySubjectPrefix': await store.deleteBySubjectPrefix('http://ex.org/g', 'http://ex.org/'); break;
        }

        await store.listGraphs();
        expect(listGraphsHits).toBe(2); // write invalidated the cache
      },
    );

    it('does NOT cache for a non-managed (external) endpoint', async () => {
      listGraphsHits = 0;
      const store = new SparqlHttpStore({ queryEndpoint: queryUrl, updateEndpoint: updateUrl });
      await store.listGraphs();
      await store.listGraphs();
      expect(listGraphsHits).toBe(2); // every call queries the server
    });

    it('re-scans after the cache TTL expires, so a store outage cannot be masked forever', async () => {
      listGraphsHits = 0;
      let clock = 1_000_000;
      const store = new SparqlHttpStore({
        queryEndpoint: queryUrl,
        updateEndpoint: updateUrl,
        managedByDkg: true,
        now: () => clock,
      });
      await store.listGraphs();
      await store.listGraphs();
      expect(listGraphsHits).toBe(1); // within TTL: served from cache

      clock += LIST_GRAPHS_CACHE_TTL_MS + 1; // advance past the TTL
      await store.listGraphs();
      expect(listGraphsHits).toBe(2); // expired: re-validated against the store
    });

    it('coalesces concurrent cold-cache callers onto a single scan', async () => {
      // Without in-flight coalescing, simultaneous callers (reconcile + metrics
      // CG-count + status) on a cold/expired cache each issue their own
      // `SELECT DISTINCT ?g` — duplicate full scans, the load this fix removes.
      listGraphsHits = 0;
      const store = managedStore();
      const [a, b, c] = await Promise.all([
        store.listGraphs(),
        store.listGraphs(),
        store.listGraphs(),
      ]);
      expect(a).toContain('http://ex.org/g1');
      expect(b).toContain('http://ex.org/g1');
      expect(c).toContain('http://ex.org/g1');
      expect(listGraphsHits).toBe(1); // all three shared one in-flight scan
    });

    it('a write during an in-flight scan forces the next caller to re-scan, not join stale work', async () => {
      // Read-your-writes: if a scan is in flight and a write invalidates the
      // cache before it resolves, a caller arriving after the write must start
      // a fresh scan rather than join the pre-write in-flight one.
      listGraphsHits = 0;
      let release!: () => void;
      listGraphsGate = new Promise<void>((r) => { release = r; });
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const store = managedStore();
      try {
        const p1 = store.listGraphs();             // caller 1: scan in flight (held by gate)
        await delay(30);                           // request reaches the server (hits=1)
        await store.insert(g('http://ex.org/g2')); // write invalidates the cache (gen bump)
        const p2 = store.listGraphs();             // caller 2: must NOT join the pre-write scan
        await delay(30);                           // caller 2 issues its own request (hits=2)
        release();
        await Promise.all([p1, p2]);
        expect(listGraphsHits).toBe(2);            // post-write caller ran a fresh scan
      } finally {
        listGraphsGate = null;
      }
    });

    it('returns a defensive copy that cannot mutate the cached set', async () => {
      listGraphsHits = 0;
      const store = managedStore();
      const first = await store.listGraphs();
      first.push('http://ex.org/injected');
      const second = await store.listGraphs();
      expect(second).not.toContain('http://ex.org/injected');
      expect(listGraphsHits).toBe(1); // second served from cache, copy was independent
    });
  });
});

const liveQueryUrl = process.env.SPARQL_HTTP_TEST_QUERY_URL;
const liveUpdateUrl = process.env.SPARQL_HTTP_TEST_UPDATE_URL ?? liveQueryUrl;

if (liveQueryUrl && liveUpdateUrl) {
  describe('SparqlHttpStore (live endpoint)', () => {
    const factory = () =>
      createTripleStore({
        backend: 'sparql-http',
        options: { queryEndpoint: liveQueryUrl, updateEndpoint: liveUpdateUrl },
      });

    it('inserts and queries quads', async () => {
      const store = await factory();
      const quads: Quad[] = [{
        subject: 'http://ex.org/test/alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'http://ex.org/test/g',
      }];
      await store.insert(quads);
      const result = await store.query(
        'SELECT ?name WHERE { GRAPH <http://ex.org/test/g> { <http://ex.org/test/alice> <http://schema.org/name> ?name } }',
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]['name']).toBe('"Alice"');
      }
      await store.deleteByPattern({ graph: 'http://ex.org/test/g' });
      await store.close();
    });
  });
}
// NOTE: previously this else branch registered an empty
// `it.skip('requires a running SPARQL 1.1 endpoint', () => {})` just to
// surface a skip line in the reporter. That stub had no assertion and
// wasn't exercising anything — removed. The live-endpoint `describe` above
// only runs when `SPARQL_HTTP_TEST_QUERY_URL` is set; otherwise the mock
// server tests above give full coverage of the adapter's HTTP contract.
