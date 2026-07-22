/**
 * Server-side query timeout (X-BIGDATA-MAX-QUERY-MILLIS) — unit tests.
 *
 * Store-survivability build (2026-07-18 mainnet wedge): every adapter
 * call carries a 30s client AbortController but the fleet's Blazegraph
 * ships web.xml queryTimeout=0, so abandoned queries kept executing
 * server-side and stacked orphan working sets until the heap died. The
 * adapter now derives a per-request server-side bound from the SAME
 * operation deadline (slightly below the client deadline) so the server
 * kills its own work before the client walks away.
 *
 * Mocked-fetch idiom follows blazegraph.unit.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BlazegraphStore,
  serverSideQueryTimeoutMillis,
} from '../src/adapters/blazegraph.js';

const HEADER = 'X-BIGDATA-MAX-QUERY-MILLIS';

describe('serverSideQueryTimeoutMillis', () => {
  it('is the remaining budget minus the 2s client-abort margin', () => {
    expect(serverSideQueryTimeoutMillis(30_000)).toBe(28_000);
    expect(serverSideQueryTimeoutMillis(500_000)).toBe(498_000);
  });

  it('floors at 5s so a nearly-elapsed deadline never sends 0 (= unlimited)', () => {
    expect(serverSideQueryTimeoutMillis(6_000)).toBe(5_000);
    expect(serverSideQueryTimeoutMillis(0)).toBe(5_000);
    expect(serverSideQueryTimeoutMillis(-100)).toBe(5_000);
  });
});

describe('BlazegraphStore server-timeout header (mocked HTTP)', () => {
  const baseUrl = 'http://blaze.test/sparql';

  let fetchCalls: [input: string | URL | Request, init?: RequestInit][];
  let originalFetch: typeof globalThis.fetch;

  function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = (async (input: any, init?: any) => {
      fetchCalls.push([input, init]);
      return handler(input, init);
    }) as typeof fetch;
  }

  function headerOf(call: [unknown, RequestInit?]): number | null {
    const raw = (call[1]?.headers as Record<string, string> | undefined)?.[HEADER];
    return raw === undefined ? null : Number(raw);
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    setFetch(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED;
  });

  it('SELECT carries the header, derived from the default 30s operation deadline', async () => {
    setFetch(async () => new Response(
      JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    await s.query('SELECT ?s WHERE { ?s ?p ?o }');
    const value = headerOf(fetchCalls[0]);
    expect(value).not.toBeNull();
    // <= deadline - 2000, >= floor; computed AFTER scheduler admission so
    // a little budget has already elapsed by fetch time.
    expect(value!).toBeLessThanOrEqual(28_000);
    expect(value!).toBeGreaterThanOrEqual(5_000);
    expect(value!).toBeGreaterThan(20_000);
  });

  it('CONSTRUCT carries the header', async () => {
    setFetch(async () => new Response(
      '<http://s> <http://p> "o" <http://g> .\n',
      { status: 200, headers: { 'Content-Type': 'text/x-nquads' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    await s.query('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    const value = headerOf(fetchCalls[0]);
    expect(value).not.toBeNull();
    expect(value!).toBeLessThanOrEqual(28_000);
    expect(value!).toBeGreaterThanOrEqual(5_000);
  });

  it('UPDATE carries the header (harmless if 2.1.5 ignores it on updates)', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.update('DELETE WHERE { ?s ?p ?o }');
    const value = headerOf(fetchCalls[0]);
    expect(value).not.toBeNull();
    expect(value!).toBeLessThanOrEqual(28_000);
    expect(value!).toBeGreaterThanOrEqual(5_000);
  });

  it('insert does NOT carry the header (bulk N-Quads endpoint, not a query)', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      { subject: 'http://s', predicate: 'http://p', object: '"o"', graph: 'http://g' },
    ]);
    expect(headerOf(fetchCalls[0])).toBeNull();
  });

  it('derives from the instance deadline, not a constant (10s timeout → ~8s header)', async () => {
    setFetch(async () => new Response(
      JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl, { timeout: 10_000 });
    await s.query('SELECT ?s WHERE { ?s ?p ?o }');
    const value = headerOf(fetchCalls[0]);
    expect(value!).toBeLessThanOrEqual(8_000);
    expect(value!).toBeGreaterThan(7_000);
  });

  it('DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED=1 removes the header on every path', async () => {
    process.env.DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED = '1';
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('SELECT')) {
        return new Response(
          JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (body.startsWith('CONSTRUCT')) {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/x-nquads' } });
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    await s.query('SELECT ?s WHERE { ?s ?p ?o }');
    await s.query('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    await s.update('DELETE WHERE { ?s ?p ?o }');
    expect(fetchCalls).toHaveLength(3);
    for (const call of fetchCalls) {
      expect(headerOf(call)).toBeNull();
    }
  });

  it('the escape hatch is read per call — flipping it mid-process takes effect', async () => {
    setFetch(async () => new Response(
      JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    await s.query('SELECT ?s WHERE { ?s ?p ?o }');
    expect(headerOf(fetchCalls[0])).not.toBeNull();
    process.env.DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED = '1';
    await s.query('SELECT ?s WHERE { ?s ?p ?o }');
    expect(headerOf(fetchCalls[1])).toBeNull();
  });
});
