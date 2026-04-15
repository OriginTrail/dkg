import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SparqlHttpStore, createTripleStore, type Quad } from '../src/index.js';

let server: Server;
let queryUrl: string;
let updateUrl: string;
const insertedQuads: string[] = [];

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
            res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
            res.end(JSON.stringify({
              head: { vars: ['g'] },
              results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
            }));
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

  it('close is a no-op', async () => {
    await store.close();
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
} else {
  describe('SparqlHttpStore live (skipped — set SPARQL_HTTP_TEST_QUERY_URL to run)', () => {
    it.skip('requires a running SPARQL 1.1 endpoint', () => {});
  });
}
