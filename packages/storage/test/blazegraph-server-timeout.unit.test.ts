import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  serverSideQueryTimeoutMillis,
} from '../src/adapters/blazegraph.js';

const HEADER = 'X-BIGDATA-MAX-QUERY-MILLIS';

describe('serverSideQueryTimeoutMillis', () => {
  it('expires server work before the client deadline', () => {
    expect(serverSideQueryTimeoutMillis(30_000)).toBe(28_000);
    expect(serverSideQueryTimeoutMillis(500_000)).toBe(498_000);
  });

  it('never sends zero, which Blazegraph treats as unlimited', () => {
    expect(serverSideQueryTimeoutMillis(6_000)).toBe(4_000);
    expect(serverSideQueryTimeoutMillis(0)).toBe(1);
  });
});

describe('BlazegraphStore server-side timeout header', () => {
  const baseUrl = 'http://blaze.test/sparql';
  let calls: Array<[string | URL | Request, RequestInit | undefined]>;
  let originalFetch: typeof globalThis.fetch;

  function installFetch(
    response: (body: string) => Response,
  ): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([input, init]);
      return response(String(init?.body ?? ''));
    }) as typeof fetch;
  }

  function header(index: number): number | undefined {
    const headers = calls[index]?.[1]?.headers as Record<string, string> | undefined;
    const value = headers?.[HEADER];
    return value === undefined ? undefined : Number(value);
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    installFetch((body) => body.startsWith('SELECT')
      ? new Response(
        JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
      : body.startsWith('CONSTRUCT')
        ? new Response('', { status: 200, headers: { 'Content-Type': 'text/x-nquads' } })
        : new Response(null, { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED;
  });

  it('bounds SELECT, CONSTRUCT, and UPDATE on the server', async () => {
    const store = new BlazegraphStore(baseUrl);
    await store.query('SELECT ?s WHERE { ?s ?p ?o }');
    await store.query('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    await store.update('DELETE WHERE { ?s ?p ?o }');

    expect(calls).toHaveLength(3);
    for (let index = 0; index < calls.length; index += 1) {
      expect(header(index)).toBeGreaterThanOrEqual(1);
      expect(header(index)).toBeLessThanOrEqual(28_000);
    }
  });

  it('derives the bound from the remaining instance deadline', async () => {
    const store = new BlazegraphStore(baseUrl, { timeout: 10_000 });
    await store.query('SELECT ?s WHERE { ?s ?p ?o }');
    expect(header(0)).toBeGreaterThan(7_000);
    expect(header(0)).toBeLessThanOrEqual(8_000);
  });

  it('keeps an operator escape hatch without a restart-time code change', async () => {
    process.env.DKG_BLAZEGRAPH_SERVER_TIMEOUT_DISABLED = '1';
    const store = new BlazegraphStore(baseUrl);
    await store.query('SELECT ?s WHERE { ?s ?p ?o }');
    await store.update('DELETE WHERE { ?s ?p ?o }');
    expect(header(0)).toBeUndefined();
    expect(header(1)).toBeUndefined();
  });
});
