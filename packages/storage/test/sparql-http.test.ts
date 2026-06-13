import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SparqlHttpStore, createTripleStore, type Quad, type SparqlHttpSlowQueryEvent } from '../src/index.js';

let server: Server;
let queryUrl: string;
let updateUrl: string;
const insertedQuads: string[] = [];
/** How many times the server received the `SELECT DISTINCT ?g` listGraphs scan. */
let listGraphsHits = 0;

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
        if (req.url?.startsWith('/query')) {
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
            respond();
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

  it('emits sampled slow-query events with source tags and query fingerprints', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const taggedStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 10,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = taggedStore.query(
      'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
      { source: 'unit test/source' },
    );
    clock = 25;
    await pending;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'unit_test/source',
      operation: 'select',
      elapsedMs: 25,
      thresholdMs: 10,
      endpoint: queryUrl,
    });
    expect(events[0].queryHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].queryBytes).toBeGreaterThan(0);
    expect(events[0]).not.toHaveProperty('sparql');
  });

  it('honors slow-query sample rate zero', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const sampledOutStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      slowQuerySampleRate: 0,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = sampledOutStore.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
      source: 'sampled-out',
    });
    clock = 50;
    await pending;

    expect(events).toHaveLength(0);
  });

  it('does not let slow-query hook failures fail the query', async () => {
    let clock = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      onSlowQuery: () => { throw new Error('sink down'); },
      now: () => clock,
    });

    try {
      const pending = store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
        source: 'throwing-hook',
      });
      clock = 50;
      const result = await pending;
      expect(result.type).toBe('boolean');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('slow query hook failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('redacts endpoint query strings from slow-query telemetry', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const store = new SparqlHttpStore({
      queryEndpoint: `${queryUrl}?token=secret#fragment`,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
      source: 'secret-endpoint',
    });
    clock = 50;
    await pending;

    expect(events).toHaveLength(1);
    expect(events[0].endpoint).toBe(queryUrl);
    expect(events[0].endpoint).not.toContain('secret');
    expect(events[0].endpoint).not.toContain('#fragment');
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

  describe('listGraphs()', () => {
    it('scans directly even when managedByDkg is set; GraphSetIndexStore owns caching', async () => {
      listGraphsHits = 0;
      const store = new SparqlHttpStore({
        queryEndpoint: queryUrl,
        updateEndpoint: updateUrl,
        managedByDkg: true,
      });
      const a = await store.listGraphs();
      const b = await store.listGraphs();
      expect(a).toContain('http://ex.org/g1');
      expect(b).toContain('http://ex.org/g1');
      expect(listGraphsHits).toBe(2);
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
