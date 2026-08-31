import { describe, expect, it } from 'vitest';

import {
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromBaseUrl,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  normalizeBlazegraphNamespaceApiUrl,
} from '../src/blazegraph-namespace-manager.js';

const NAMESPACE_API_URL = 'http://127.0.0.1:9999/bigdata/namespace';

describe('BlazegraphNamespaceManager', () => {
  it('ensures an existing namespace without issuing a create', async () => {
    const calls: Array<Readonly<{ method: string; url: string }>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(Object.freeze({ method: init?.method ?? 'GET', url: String(input) }));
      return new Response('', { status: 200 });
    };
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      fetchImpl,
      requestTimeoutMs: 100,
    });

    await expect(manager.ensure('selected-cg')).resolves.toEqual({
      created: false,
      sparqlUrl: 'http://127.0.0.1:9999/bigdata/namespace/selected-cg/sparql',
    });
    expect(calls).toEqual([{
      method: 'GET',
      url: 'http://127.0.0.1:9999/bigdata/namespace/selected-cg/sparql/properties',
    }]);
  });

  it('starts the complete handle plan concurrently and disposes every handle concurrently', async () => {
    const pendingCreates: Array<() => void> = [];
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          pendingCreates.push(() => resolve(new Response('', { status: 201 })));
        });
      }
      if (init?.method === 'DELETE') {
        activeDeletes += 1;
        maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
        await Promise.resolve();
        activeDeletes -= 1;
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected method ${String(init?.method)}`);
    };
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      fetchImpl,
      requestTimeoutMs: 100,
    });
    const acquiring = manager.acquireMany(['author', 'receiver-a', 'receiver-b']);
    await waitFor(() => pendingCreates.length === 3);
    pendingCreates.forEach((resolve) => resolve());
    const handles = await acquiring;

    expect(handles.map((handle) => handle.namespace)).toEqual([
      'author',
      'receiver-a',
      'receiver-b',
    ]);
    await manager.disposeAll(handles);
    expect(maxActiveDeletes).toBe(3);
  });

  it.each(['.', '..'])('rejects URL dot segment %j before any fetch', async (namespace) => {
    let fetchCount = 0;
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response('', { status: 200 });
      },
    });
    expect(() => manager.namespaceUrl(namespace)).toThrow(/Blazegraph namespace .* is invalid/u);
    await expect(manager.acquireMany([namespace])).rejects.toThrow(
      /Blazegraph namespace .* is invalid/u,
    );
    expect(fetchCount).toBe(0);
  });

  it('uses one codec contract for URL generation and XML rendering', async () => {
    const bodies: string[] = [];
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response('', { status: 201 });
      },
    });
    expect(manager.namespaceUrl('accepted-name')).toBe(
      `${NAMESPACE_API_URL}/accepted-name`,
    );
    await expect(manager.acquireMany(['accepted-name'])).resolves.toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(
      '<entry key="com.bigdata.rdf.sail.namespace">accepted-name</entry>',
    );
    expect(() => manager.namespaceUrl('author:probe')).toThrow(
      /Blazegraph namespace .* is invalid/u,
    );
    await expect(manager.acquireMany(['author:probe'])).rejects.toThrow(
      /Blazegraph namespace .* is invalid/u,
    );
  });

  it.each([
    ['HTTP 500', async () => new Response('', { status: 500 })],
    ['a rejected request', async () => { throw new Error('inspection unavailable'); }],
  ] as const)('does not create after %s during namespace inspection', async (_label, inspect) => {
    const methods: string[] = [];
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      fetchImpl: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return inspect();
      },
    });
    await expect(manager.ensure('selected-cg')).rejects.toThrow();
    expect(methods).toEqual(['GET']);
  });

  it('retries rollback cleanup after a transient DELETE failure', async () => {
    let deleteCalls = 0;
    const manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: NAMESPACE_API_URL,
      requestTimeoutMs: 100,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') throw new Error('create response lost');
        if (init?.method === 'DELETE') {
          deleteCalls += 1;
          return new Response('', { status: deleteCalls === 1 ? 500 : 404 });
        }
        throw new Error(`unexpected method ${String(init?.method)}`);
      },
    });
    await expect(manager.acquireMany(['author'])).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError
        && error.message === 'Blazegraph namespace setup failed'
        && error.errors.length === 1
        && error.errors[0] instanceof Error
        && error.errors[0].message === 'create response lost',
    );
    expect(deleteCalls).toBe(2);
  });

  it('normalizes only explicit supported Blazegraph URL shapes', () => {
    expect(normalizeBlazegraphNamespaceApiUrl(`${NAMESPACE_API_URL}/`)).toBe(
      NAMESPACE_API_URL,
    );
    expect(blazegraphNamespaceApiUrlFromSparqlEndpoint(
      `${NAMESPACE_API_URL}/kb/sparql`,
    )).toBe(NAMESPACE_API_URL);
    expect(blazegraphNamespaceApiUrlFromBaseUrl('http://127.0.0.1:9999')).toBe(
      NAMESPACE_API_URL,
    );
    expect(() => normalizeBlazegraphNamespaceApiUrl(
      'http://127.0.0.1:9999/custom-api',
    )).toThrow(/must end with \/bigdata\/namespace/u);
    expect(() => blazegraphNamespaceApiUrlFromSparqlEndpoint(
      'http://127.0.0.1:9999/custom-api',
    )).toThrow(/must end with/u);
    expect(() => blazegraphNamespaceApiUrlFromBaseUrl(
      'http://127.0.0.1:9999/custom-api',
    )).toThrow(/must not contain a path/u);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not become true');
}
