import { afterEach, expect, it, vi } from 'vitest';
import { BlazegraphStore, OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

afterEach(() => vi.unstubAllGlobals());

it('reads child authority larger than the caller HTTP result cap without granting child access', async () => {
  const backing = new OxigraphStore();
  const store = new BlazegraphStore('http://fixture.invalid/sparql');
  const id = 'child-budget', root = `did:dkg:context-graph:${id}`;
  const child = `${root}/_verifiable_memory/child`, predicate = 'urn:value';
  let catalogBytes = 0, resultBytes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const sparql = String(init.body), result = await backing.query(sparql);
    if (result.type === 'quads') throw new Error('SELECT/ASK fixture only');
    const body = JSON.stringify(result.type === 'boolean' ? { boolean: result.value } : {
      head: { vars: [...new Set(result.bindings.flatMap(row => Object.keys(row)))] },
      results: { bindings: result.bindings.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error('Expected a serialized RDF term');
        return [key, value.startsWith('"')
          ? { type: 'literal', value: JSON.parse(value) }
          : { type: 'uri', value }];
      }))) },
    });
    if (sparql.includes('SELECT DISTINCT ?ctxGraph')) catalogBytes = Buffer.byteLength(body);
    if (sparql.includes(`SELECT ?value`)) resultBytes = Buffer.byteLength(body);
    return new Response(body, { headers: { 'content-type': 'application/sparql-results+json' } });
  }));
  try {
    await backing.insert([
      { graph: root, subject: 'urn:parent', predicate, object: '"visible"' },
      { graph: `${child}/_verifiable_memory/private`, subject: 'urn:child', predicate, object: '"secret"' },
      ...[child, ...Array.from({ length: 100 }, (_, n) => `${root}/registered-child-${n}`)].map(uri => ({
        graph: `${uri}/_meta`, subject: uri,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph',
      })),
    ]);
    const engine = new DKGQueryEngine(store);
    const query = `SELECT ?value WHERE { ?s <${predicate}> ?value }`;
    const options = { contextGraphId: id, view: 'verifiable-memory' as const, maxResponseBytes: 2048 };
    expect((await engine.query(query, options)).bindings).toEqual([{ value: '"visible"' }]);
    expect(catalogBytes).toBeGreaterThan(options.maxResponseBytes);
    expect(resultBytes).toBeLessThan(options.maxResponseBytes);
    await backing.insert([{ graph: root, subject: 'urn:large', predicate, object: `"${'x'.repeat(4096)}"` }]);
    await expect(engine.query(query, options)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  } finally { await store.close(); await backing.close(); }
});

it('keeps child authority reads attached to caller cancellation', async () => {
  const store = new BlazegraphStore('http://fixture.invalid/sparql');
  const controller = new AbortController();
  let entered!: () => void, release!: (response: Response) => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(String(init.body)).toContain('SELECT DISTINCT ?ctxGraph');
    const request = new Promise<Response>((resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      void response.then(resolve, reject);
    });
    entered(); return request;
  });
  vi.stubGlobal('fetch', fetcher);
  const run = new DKGQueryEngine(store).query('SELECT ?s WHERE { ?s ?p ?o }', {
    contextGraphId: 'cancel-child', view: 'verifiable-memory', verifiedGraph: 'a',
    maxResponseBytes: 1024, signal: controller.signal,
  });
  const outcome = expect(run).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await reading; controller.abort(); await outcome;
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    release(new Response(JSON.stringify({ head: { vars: ['ctxGraph'] }, results: { bindings: [] } })));
    await store.close();
  }
});
