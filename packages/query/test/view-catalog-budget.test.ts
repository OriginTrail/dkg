import { afterEach, expect, it, vi } from 'vitest';
import { BlazegraphStore, OxigraphStore, StoreResponseTooLargeError, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QUERY_CATALOG_MAX_RESPONSE_BYTES } from '../src/query-store-read-context.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps fresh view authority outside the caller result byte budget', async () => {
  const adapter = new OxigraphStore(), controller = new AbortController();
  const id = 'view-budget', root = `did:dkg:context-graph:${id}`, name = 'urn:name';
  const graph = `${root}/_verifiable_memory/team-a`, child = `${root}/child`;
  const calls: Array<{ sparql: string; bytes: number; options: Parameters<TripleStore['query']>[1] }> = [];
  const store = new Proxy(adapter, { get(target, key) {
    if (key === 'query') return async (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      const result = await target.query(sparql, options), bytes = Buffer.byteLength(JSON.stringify(result));
      calls.push({ sparql, bytes, options });
      if (options?.maxResponseBytes !== undefined && bytes > options.maxResponseBytes)
        throw new StoreResponseTooLargeError(options.maxResponseBytes, bytes);
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const options = { contextGraphId: id, view: 'verifiable-memory' as const, verifiedGraph: 'team-a',
    signal: controller.signal, priority: 'background' as const, source: 'view-budget-test', maxResponseBytes: 1024 };
  try {
    await adapter.insert([
      { graph, subject: 'urn:item', predicate: name, object: '"visible"' },
      ...Array.from({ length: 100 }, (_, n) => ({ graph: `${root}/_meta`, subject: `urn:asset:${n}`,
        predicate: 'http://dkg.io/ontology/assertionGraph', object: `${root}/_verifiable_memory/unrelated/${n}` })),
      ...['code', 'child'].flatMap(sub => [
        { graph: `${root}/_meta`, subject: `${root}/${sub}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
        { graph: `${root}/_meta`, subject: `${root}/${sub}`, predicate: 'http://schema.org/name', object: `"${sub}"` },
        { graph: `${root}/${sub}/_verifiable_memory/a/1`, subject: `urn:${sub}`, predicate: name, object: `"${sub}"` },
      ]),
      { graph: `${child}/_meta`, subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph' },
    ]);
    const engine = new DKGQueryEngine(store), query = `SELECT ?name WHERE { ?s <${name}> ?name }`;
    expect((await engine.query(query, options)).bindings).toEqual([{ name: '"visible"' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.bytes).toBeLessThan(1024);
    expect(calls[0]!.sparql).not.toContain('?assertionGraph');
    expect(calls[0]!.sparql).not.toContain('GRAPH ?graph');
    expect(calls[0]!.options).toMatchObject({ signal: controller.signal, priority: 'background', source: options.source });
    expect(calls[0]!.options?.maxResponseBytes).toBe(QUERY_CATALOG_MAX_RESPONSE_BYTES);
    expect(calls[1]!.options?.maxResponseBytes).toBe(1024);
    calls.length = 0;
    expect((await engine.query(query, { ...options, verifiedGraph: undefined })).bindings.map(row => row.name).sort())
      .toEqual(['"code"', '"visible"']);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.sparql).toContain('?ctxGraph');
    expect(calls[1]!.options?.maxResponseBytes).toBe(QUERY_CATALOG_MAX_RESPONSE_BYTES);
    await adapter.insert([{ graph, subject: 'urn:large', predicate: name, object: `"${'x'.repeat(2048)}"` }]);
    await expect(engine.query(query, options)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  } finally { await adapter.close(); }
});

it.each(['view', 'dynamic'] as const)('bounds streamed %s catalog bytes before decoding or running the caller', async route => {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let produced = 0;
  const cancel = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { produced += chunk.byteLength; controller.enqueue(chunk); }, cancel,
  }), { headers: { 'content-type': 'application/sparql-results+json' } }));
  vi.stubGlobal('fetch', fetcher);
  const store = new BlazegraphStore('http://fixture.invalid/sparql');
  try {
    const engine = new DKGQueryEngine(store);
    const options = route === 'view'
      ? { contextGraphId: 'bounded', view: 'verifiable-memory' as const, verifiedGraph: 'a' }
      : { contextGraphId: 'bounded', includeContextGraphPartitions: true };
    const query = route === 'dynamic' ? 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }' : 'SELECT ?s WHERE { ?s ?p ?o }';
    await expect(engine.query(query, { ...options, maxResponseBytes: 1024 }))
      .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES });
    const request = fetcher.mock.calls[0] as unknown as [unknown, RequestInit];
    const catalogQuery = String(request[1].body);
    expect(catalogQuery).toContain(route === 'dynamic' ? '?assertionGraph' : '?ctxGraph');
    if (route === 'dynamic') expect(catalogQuery).toContain('http://schema.org/name');
    expect(fetcher).toHaveBeenCalledOnce(); // The caller query never ran.
    expect(cancel).toHaveBeenCalledOnce();
    expect(produced).toBeLessThanOrEqual(QUERY_CATALOG_MAX_RESPONSE_BYTES + 2 * chunk.byteLength);
  } finally { await store.close(); }
});
