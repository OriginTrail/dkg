// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { invalidateQueryCache } from '../src/ui/api.js';
import { readMemoryGraphPage, fetchMemoryEntity, type MemoryGraphCursor } from '../src/ui/hooks/memory-graph-query.js';
import { memoryQueryDefinitions } from '../src/ui/hooks/memory-query-definition.js';
import { AUTOMATIC_QUERY_MAX_BYTES } from '../src/ui/query-transport.js';

const owner = '0x1111111111111111111111111111111111111111';
const cg = `${owner}/wide-pages`;
const graph = `did:dkg:context-graph:${cg}/_working_memory/${owner}/1`;
let store: OxigraphStore; let engine: DKGQueryEngine;
let queries: string[];
beforeEach(async () => {
  invalidateQueryCache(); store = new OxigraphStore(); engine = new DKGQueryEngine(store); queries = [];
  await store.insert(['0', '1'].map(number => ({
    subject: `urn:dkg:assertion:${cg}:${owner}:${number}`, predicate: 'http://dkg.io/ontology/assertionGraph',
    object: `did:dkg:context-graph:${cg}/_working_memory/${owner}/${number}`, graph: `did:dkg:context-graph:${cg}/_meta`,
  })));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); queries.push(request.sparql);
    const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
    return new Response(JSON.stringify({ result: { type: 'bindings', bindings: result.bindings } }));
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); invalidateQueryCache(); await store.close(); });

describe('memory read limits and response-local blank resources', () => {
  it('shrinks literal-heavy pages under the real byte cap and eventually reads every row once', async () => {
    await store.insert(Array.from({ length: 3000 }, (_, i) => ({
      subject: `urn:chunk:${String(i).padStart(4, '0')}`, predicate: 'urn:content', object: JSON.stringify('x'.repeat(1500)), graph,
    })));
    const seen: string[] = []; let cursor: MemoryGraphCursor | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, cursor });
      if (!page.ok) throw new Error(page.reason);
      expect(page.omittedRelationships).toBe(false);
      expect(page.triples.length).toBeLessThanOrEqual(5000);
      seen.push(...page.triples.map(triple => triple.subject)); cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined(); expect(seen).toHaveLength(3000); expect(new Set(seen).size).toBe(3000);
    const rowReads = queries.filter(query => query.includes('SELECT ?s ?p ?o ?g ?__g'));
    expect(rowReads.some(query => query.endsWith('LIMIT 5000'))).toBe(true);
    expect(rowReads.some(query => query.endsWith('LIMIT 2500'))).toBe(true);
  });
  it('reports a response-limit failure only after the single-row minimum fails', async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const { sparql } = JSON.parse(String(init?.body)); queries.push(sparql);
      return sparql.includes('SELECT DISTINCT')
        ? new Response(JSON.stringify({ result: { bindings: [{ g: graph }] } }))
        : new Response('{}', { headers: { 'Content-Length': String(AUTOMATIC_QUERY_MAX_BYTES + 1) } });
    });
    expect(await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg)).toEqual({ ok: false, reason: 'response-limit' });
    expect(queries.at(-1)).toMatch(/LIMIT 1$/); expect(queries.length).toBeLessThan(16);
  });
  it('uses the clicked blank node’s loaded facts even when unrelated graphs precede it', async () => {
    const unrelated = `did:dkg:context-graph:${cg}/_working_memory/${owner}/0`;
    await store.insert([
      ...Array.from({ length: 1200 }, (_, i) => ({ subject: `_:unrelated${i}`, predicate: 'urn:p', object: '"unrelated"', graph: unrelated })),
      { subject: 'urn:target-parent', predicate: 'urn:child', object: '_:target', graph },
      { subject: '_:target', predicate: 'urn:name', object: '"Clicked blank"', graph },
    ]);
    const page = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true });
    if (!page.ok) throw new Error(page.reason);
    expect(page.omittedRelationships).toBe(false);
    const target = page.triples.find(triple => triple.object === '"Clicked blank"')!.subject;
    const before = queries.length;
    const detail = await fetchMemoryEntity(cg, target, 'wm', false, {
      triples: page.triples.map(triple => ({ ...triple, layer: 'working' as const })), partial: false,
    });
    expect(detail.partial).toBe(false); expect(detail.triples).toHaveLength(2);
    expect(detail.triples.every(triple => triple.graph === graph)).toBe(true);
    expect(queries).toHaveLength(before);
    expect(await fetchMemoryEntity(cg, '_:unknown', 'wm')).toEqual({ triples: [], partial: true });
    expect(queries).toHaveLength(before);
  });
});
