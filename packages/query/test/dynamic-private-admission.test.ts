import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, ChangelogStore, GraphSetIndexStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QUERY_CATALOG_MAX_RESPONSE_BYTES } from '../src/query-store-read-context.js';

const ID = 'private-admission', ROOT = `did:dkg:context-graph:${ID}`;
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/41';
const SCOPE = createGraphKnowledgeAssetScope(UAL, 1);
const PUBLIC = knowledgeAssetLayerGraphUri(ID, MemoryLayer.VerifiableMemory, SCOPE);
const PRIVATE = `${ROOT}/_private/${SCOPE.agentAddress}/${SCOPE.kaNumber}/assertions/1`;
const NAME = 'http://schema.org/name', QUERY = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`;

async function fixture(kind: 'bare' | 'changelog' | 'index-outside' | 'index-inside', abortPrivate = false) {
  const adapter = new OxigraphStore(), controller = new AbortController(), failure = new Error('caller cancelled');
  const calls: Array<{ owned: boolean; sparql: string; options: Parameters<TripleStore['query']>[1] }> = [];
  let owned = false;
  const admission = vi.fn(async (work: () => Promise<unknown>) => {
    owned = true; try { return await work(); } finally { owned = false; }
  });
  const enumeration = vi.fn(() => { throw new Error('Dynamic owned route must use catalog inventory'); });
  const wrapped = new Proxy(adapter, { get(target, key) {
    if (key === 'withQueryReadAdmission') return admission;
    if (key === 'listGraphs' || key === 'listGraphsByPrefix') return enumeration;
    if (key === 'query') return (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      calls.push({ owned, sparql, options });
      if (abortPrivate && sparql.includes('SELECT DISTINCT ?ual')) {
        controller.abort(failure); options?.signal?.throwIfAborted();
      }
      return target.query(sparql, options);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const store = kind === 'bare' ? wrapped : kind === 'changelog' ? new ChangelogStore(wrapped)
    : kind === 'index-outside' ? new GraphSetIndexStore(new ChangelogStore(wrapped))
      : new ChangelogStore(new GraphSetIndexStore(wrapped));
  await adapter.insert([
    ...[[PUBLIC, 'public'], [PRIVATE, 'private'], [`${ROOT}/_private/_working_memory/hidden`, 'draft'], ['did:dkg:context-graph:other/_private', 'foreign']].map(([graph, name]) =>
      ({ graph, subject: 'urn:item', predicate: NAME, object: `"${name}"` })),
    ...Object.entries({ contentScopeVersion: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"`, kaUal: `<${UAL}>`, assertionVersion: '"1"',
      assertionGraph: `<${PUBLIC}>`, privateTripleCount: '"1"', status: '"confirmed"' }).map(([key, object]) =>
      ({ graph: `${ROOT}/_meta`, subject: UAL, predicate: 'http://dkg.io/ontology/' + key, object })),
  ]);
  return { adapter, engine: new DKGQueryEngine(store), calls, admission, enumeration, controller, failure,
    options: { contextGraphId: ID, includeContextGraphPartitions: true, includePrivate: true,
      signal: controller.signal, priority: 'background' as const, source: 'private-admission-test', maxResponseBytes: 4096, maxLiteralHydrationBytes: 4096 } };
}

describe('dynamic private catalog admission', () => {
  it.each(['bare', 'changelog', 'index-outside', 'index-inside'] as const)('keeps discovery and private execution inside one admission through %s', async kind => {
    const f = await fixture(kind);
    try {
      const result = await f.engine.query(QUERY, f.options);
      expect(result.bindings.map(row => row.name).sort()).toEqual(['"private"', '"public"']);
      expect(f.admission).toHaveBeenCalledTimes(1);
      expect(f.enumeration).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(3);
      expect(f.calls.every(call => call.owned && call.options?.signal === f.controller.signal)).toBe(true);
      expect(f.calls[1].sparql).toContain('SELECT DISTINCT ?ual');
      for (const call of f.calls.slice(0, 2)) expect(call.options).toMatchObject({
        maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES, maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
        priority: 'background', source: 'private-admission-test',
      });
      expect(f.calls[2].sparql).toContain(NAME);
      expect(f.calls[2].options).toMatchObject({ maxResponseBytes: 4096, maxLiteralHydrationBytes: 4096,
        priority: 'background', source: 'private-admission-test' });
      f.calls.length = 0; f.admission.mockClear();
      expect((await f.engine.query(QUERY, { ...f.options, includePrivate: false })).bindings.map(row => row.name)).toEqual(['"public"']);
      expect(f.admission).toHaveBeenCalledTimes(1);
      expect(f.calls).toHaveLength(2);
      expect(f.calls.every(call => call.owned)).toBe(true);
    } finally { await f.adapter.close(); }
  });
  it('keeps caller cancellation attached to private metadata reads', async () => {
    const f = await fixture('index-inside', true);
    try {
      await expect(f.engine.query(QUERY, f.options)).rejects.toBe(f.failure);
      expect(f.admission).toHaveBeenCalledTimes(1);
      expect(f.calls).toHaveLength(2);
      expect(f.calls.every(call => call.owned && call.options?.signal === f.controller.signal)).toBe(true);
      expect(f.enumeration).not.toHaveBeenCalled();
    } finally { await f.adapter.close(); }
  });
});
