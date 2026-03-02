/**
 * Tests for SparqlHttpStore.
 *
 * 1. Unit tests with mocked fetch — no real server required.
 * 2. Optional live conformance: set SPARQL_HTTP_TEST_QUERY_URL (and optionally
 *    SPARQL_HTTP_TEST_UPDATE_URL) to run the conformance suite against a real
 *    endpoint (e.g. Oxigraph server or Blazegraph).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SparqlHttpStore, createTripleStore, type Quad } from '../src/index.js';

const QUERY_URL = 'http://127.0.0.1:9999/query';
const UPDATE_URL = 'http://127.0.0.1:9999/update';

describe('SparqlHttpStore (mocked fetch)', () => {
  let store: SparqlHttpStore;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  function mockQueryResponse(body: object, ok = true) {
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    });
  }

  function mockUpdateResponse(ok = true) {
    return new Response(undefined, { status: ok ? 200 : 500 });
  }

  beforeEach(() => {
    store = new SparqlHttpStore({ queryEndpoint: QUERY_URL, updateEndpoint: UPDATE_URL });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = (init?.body as string) ?? '';
      const bodyDecoded = body ? decodeURIComponent(body) : '';
      if (urlStr.includes('/update') || (urlStr === UPDATE_URL && body.includes('update='))) {
        return Promise.resolve(mockUpdateResponse());
      }
      if (urlStr.includes('/query') || urlStr === QUERY_URL) {
        if (bodyDecoded.includes('ASK')) {
          return Promise.resolve(mockQueryResponse({ boolean: true }));
        }
        if (bodyDecoded.includes('COUNT(*)')) {
          return Promise.resolve(mockQueryResponse({
            head: { vars: ['c'] },
            results: { bindings: [{ c: { type: 'literal', value: '1' } }] },
          }));
        }
        if (bodyDecoded.includes('DISTINCT') && bodyDecoded.includes('?g')) {
          return Promise.resolve(mockQueryResponse({
            head: { vars: ['g'] },
            results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
          }));
        }
        return Promise.resolve(mockQueryResponse({
          head: { vars: ['name'] },
          results: { bindings: [{ name: { type: 'literal', value: 'Alice' } }] },
        }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('insert sends INSERT DATA to update endpoint', async () => {
    await store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      UPDATE_URL,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/update=.*INSERT/),
      }),
    );
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
    expect(fetchMock).toHaveBeenCalledWith(
      QUERY_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'application/sparql-results+json' }),
      }),
    );
  });

  it('query ASK returns boolean', async () => {
    const result = await store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }');
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('delete sends DELETE DATA to update endpoint', async () => {
    await store.delete([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      UPDATE_URL,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringMatching(/update=.*DELETE/),
      }),
    );
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
    await store.dropGraph('http://ex.org/g1');
    expect(fetchMock).toHaveBeenCalledWith(
      UPDATE_URL,
      expect.objectContaining({
        body: expect.stringMatching(/update=.*DROP/),
      }),
    );
  });

  it('deleteByPattern sends DELETE WHERE to update endpoint', async () => {
    await store.deleteByPattern({ subject: 'http://ex.org/s', graph: 'http://ex.org/g' });
    expect(fetchMock).toHaveBeenCalledWith(
      UPDATE_URL,
      expect.objectContaining({
        body: expect.stringContaining('DELETE'),
      }),
    );
  });

  it('deleteBySubjectPrefix sends DELETE with FILTER STRSTARTS', async () => {
    await store.deleteBySubjectPrefix('http://ex.org/g', 'http://ex.org/');
    expect(fetchMock).toHaveBeenCalledWith(
      UPDATE_URL,
      expect.objectContaining({
        body: expect.stringContaining('DELETE'),
      }),
    );
  });

  it('uses single URL for both endpoints when updateEndpoint omitted', async () => {
    const singleUrl = 'http://127.0.0.1:7878/sparql';
    const s = new SparqlHttpStore({ queryEndpoint: singleUrl });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(mockQueryResponse({ boolean: false }));
    await s.hasGraph('http://ex.org/g');
    expect(fetchMock).toHaveBeenCalledWith(
      singleUrl,
      expect.any(Object),
    );
    fetchMock.mockResolvedValue(mockUpdateResponse());
    await s.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"x"', graph: '' }]);
    expect(fetchMock).toHaveBeenCalledWith(singleUrl, expect.any(Object));
  });

  it('throws on insert when server returns non-OK', async () => {
    fetchMock.mockResolvedValueOnce(mockUpdateResponse(false));
    await expect(
      store.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"x"', graph: '' }]),
    ).rejects.toThrow(/insert failed/);
  });

  it('throws on query when server returns non-OK', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Error', { status: 500 }));
    await expect(store.query('SELECT ?x WHERE { ?x ?y ?z }')).rejects.toThrow(/query failed/);
  });

  it('close is a no-op', async () => {
    await store.close();
  });
});

// Optional: run conformance against a real SPARQL endpoint (e.g. Oxigraph server).
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
        expect(String(result.bindings[0]['name'])).toContain('Alice');
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
