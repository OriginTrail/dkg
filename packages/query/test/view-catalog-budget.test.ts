import { expect, it } from 'vitest';
import { OxigraphStore, StoreResponseTooLargeError, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

it('reuses view authority once without charging its bytes to the caller result', async () => {
  const adapter = new OxigraphStore(), controller = new AbortController();
  const id = 'view-budget', root = `did:dkg:context-graph:${id}`, name = 'urn:name';
  const graph = `${root}/_verifiable_memory/team-a`, child = `${root}/child`;
  const calls: Array<{ bytes: number; options: Parameters<TripleStore['query']>[1] }> = [];
  const store = new Proxy(adapter, { get(target, key) {
    if (key === 'query') return async (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      const result = await target.query(sparql, options), bytes = Buffer.byteLength(JSON.stringify(result));
      calls.push({ bytes, options });
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
    expect(calls[0]!.bytes).toBeGreaterThan(1024);
    expect(calls[0]!.options).toMatchObject({ signal: controller.signal, priority: 'background', source: options.source });
    expect(calls[0]!.options?.maxResponseBytes).toBeUndefined();
    expect(calls[1]!.options?.maxResponseBytes).toBe(1024);
    calls.length = 0;
    expect((await engine.query(query, { ...options, verifiedGraph: undefined })).bindings.map(row => row.name).sort())
      .toEqual(['"code"', '"visible"']);
    expect(calls).toHaveLength(2);
    await adapter.insert([{ graph, subject: 'urn:large', predicate: name, object: `"${'x'.repeat(2048)}"` }]);
    await expect(engine.query(query, options)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  } finally { await adapter.close(); }
});
