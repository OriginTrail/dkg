// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { listAssertionsPage, fetchAssertionPageCounts } from '../src/ui/assertions-page.js';
import { invalidateQueryCache } from '../src/ui/api.js';
import { fetchMemoryEntity, readMemoryGraphPage } from '../src/ui/hooks/useMemoryEntities.js';

const owner = '0x1111111111111111111111111111111111111111';
const cg = `${owner}/jpb-data`;
const root = `did:dkg:context-graph:${cg}`;
const meta = `${root}/_meta`;
const dkg = 'http://dkg.io/ontology/';
const iri = (name: string, sg?: string) => `urn:dkg:assertion:${cg}:${sg ? sg + ':' : ''}${owner}:${name}`;
const physical = (name: string, sg?: string) => `${root}/${sg ? sg + '/' : ''}assertion/${owner}/${name}`;
const content = (name: string, sg?: string) => `${root}/${sg ? sg + '/' : ''}_working_memory/${owner}/${name}`;
let store: OxigraphStore;
let engine: DKGQueryEngine;
let requests: Array<{ sparql: string; contextGraphId: string; includeContextGraphPartitions?: boolean }>;
let failures: string[];

async function assertion(name: string, layer = 'WM', sg?: string, alias = true) {
  const id = iri(name, sg); const graph = content(name, sg);
  await store.insert([
    { subject: id, predicate: dkg + 'memoryLayer', object: JSON.stringify(layer), graph: meta },
    { subject: id, predicate: dkg + 'assertionGraph', object: graph, graph: meta },
    { subject: id, predicate: dkg + 'reservedUal', object: `did:dkg:asset:${name}`, graph: meta },
    { subject: `urn:record:${name}`, predicate: 'urn:test:value', object: '"example"', graph },
    ...(alias ? [{ subject: physical(name, sg), predicate: dkg + 'memoryLayer', object: JSON.stringify(layer), graph: meta }] : []),
  ]);
  return id;
}

beforeEach(() => {
  invalidateQueryCache(); requests = []; failures = []; store = new OxigraphStore(); engine = new DKGQueryEngine(store);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); requests.push(request);
    try {
      const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
      return new Response(JSON.stringify({ result: { type: 'bindings', bindings: result.bindings } }));
    } catch (error) { failures.push(String(error)); throw error; }
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); invalidateQueryCache(); await store.close(); });

describe('assertion pages against the native scoped query engine', () => {
  it('keeps under-budget blank-node subjects and objects complete, including detail reads', async () => {
    await assertion('blank-edges');
    const graph = content('blank-edges');
    await store.insert(Array.from({ length: 7 }, (_, i) => [
      { subject: `_:subject${i}`, predicate: 'urn:value', object: `"value ${i}"`, graph },
      { subject: 'urn:parent', predicate: 'urn:child', object: `_:subject${i}`, graph },
    ]).flat());
    const query = `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ${JSON.stringify(root + '/_working_memory/')})) }`;
    const triples: Array<{ subject: string; predicate: string; object: string }> = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await readMemoryGraphPage(query, cg, { includeContextGraphPartitions: true, layerLimit: 20, cursor });
      expect(result.ok).toBe(true);
      triples.push(...result.triples);
      if (!result.truncated) break;
      cursor = result.cursor;
    }
    expect(triples).toHaveLength(15);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(15);
    const blank = triples.find(triple => triple.subject.startsWith('_:'))!.subject;
    const detail = await fetchMemoryEntity(cg, blank, 'wm');
    expect(detail.partial).toBe(false);
    expect(detail.triples).toHaveLength(2);
    expect(detail.triples.every(triple => triple.subject === blank || triple.object === blank)).toBe(true);
    expect(failures).toEqual([]);
  });
  it('filters hidden meta assertions before the page boundary when catalogs are enabled', async () => {
    for (let i = 0; i < 5; i++) await assertion(`aaa-hidden-${i}`, 'WM', 'meta');
    await assertion('query-catalog-visible', 'WM', 'meta');
    await assertion('visible');
    const first = await listAssertionsPage(cg, 'wm', { pageSize: 1, includeQueryCatalog: true });
    const second = await listAssertionsPage(cg, 'wm', { pageSize: 1, includeQueryCatalog: true, cursor: first.nextCursor });
    expect([...first.items, ...second.items].map(item => item.name).sort()).toEqual(['query-catalog-visible', 'visible']);
    expect(second.nextCursor).toBeUndefined();
  });
  it('bounds an oversized blank component and explicitly reports incomplete memory', async () => {
    await assertion('large-blank');
    await store.insert(Array.from({ length: 5001 }, (_, i) => ({
      subject: `_:large${i}`, predicate: 'urn:value', object: `"${i}"`, graph: content('large-blank'),
    })));
    const query = `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ${JSON.stringify(root + '/_working_memory/')})) }`;
    const result = await readMemoryGraphPage(query, cg, { includeContextGraphPartitions: true });
    expect(result.ok).toBe(true); expect(result.incomplete).toBe(true);
    expect(result.triples.length).toBeLessThanOrEqual(5000);
    expect(requests.filter(request => request.sparql.includes('FILTER(isBlank(?s) || isBlank(?o))')).every(request => /LIMIT\s+5000\s*$/.test(request.sparql))).toBe(true);
    const detail = await fetchMemoryEntity(cg, result.triples.find(triple => triple.subject.startsWith('_:'))!.subject, 'wm');
    expect(detail.partial).toBe(true); expect(detail.triples.length).toBeLessThanOrEqual(1000);
    expect(requests.at(-1)!.sparql).toMatch(/LIMIT\s+1001\s*$/);
  });
  it('explicitly flags omitted blank edges while continuing bounded nonblank pages', async () => {
    for (let i = 0; i < 7; i++) {
      const name = `mix-${i}`; await assertion(name);
      await store.insert([{ subject: `_:blank${i}`, predicate: 'urn:blank', object: `"${i}"`, graph: content(name) }]);
    }
    const query = `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ${JSON.stringify(root + '/_working_memory/')})) }`;
    const triples = []; let cursor; let incomplete = false;
    for (let i = 0; i < 10; i++) {
      const result = await readMemoryGraphPage(query, cg, { includeContextGraphPartitions: true, layerLimit: 2, cursor });
      expect(result.ok).toBe(true); expect(result.triples.length).toBeLessThanOrEqual(2);
      incomplete ||= result.incomplete ?? false; triples.push(...result.triples);
      if (!result.truncated) break;
      cursor = result.cursor;
    }
    expect(incomplete).toBe(true);
    expect(triples.filter(triple => !triple.subject.startsWith('_:'))).toHaveLength(7);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(triples.length);
  });
  it('continues across bounded graph-inventory pages even when a triple page is not full', async () => {
    for (let i = 0; i < 12; i++) await assertion(`graph-${String(i).padStart(2, '0')}`);
    const query = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ' + JSON.stringify(root + '/_working_memory/') + ')) }';
    const sizes: number[] = []; const seen: string[] = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await readMemoryGraphPage(query, cg, { includeContextGraphPartitions: true, layerLimit: 100, cursor });
      expect(result.ok).toBe(true); sizes.push(result.triples.length);
      seen.push(...result.triples.map(triple => triple.subject));
      if (!result.truncated) break;
      cursor = result.cursor;
    }
    expect(sizes).toEqual([5, 5, 2]);
    expect(new Set(seen).size).toBe(12);
  });
  it('seeks through graph rows without skipping datatype/language variants', async () => {
    await assertion('seek');
    await store.insert([
      { subject: 'urn:seek', predicate: 'urn:value', object: '"1"', graph: content('seek') },
      { subject: 'urn:seek', predicate: 'urn:value', object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: content('seek') },
      { subject: 'urn:seek', predicate: 'urn:value', object: '"1"@en', graph: content('seek') },
      { subject: 'urn:seek', predicate: 'urn:value', object: '"1"@fr', graph: content('seek') },
    ]);
    const query = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ' + JSON.stringify(root + '/_working_memory/') + ')) }';
    const triples: Array<{ subject: string; predicate: string; object: string }> = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await readMemoryGraphPage(query, cg, { includeContextGraphPartitions: true, layerLimit: 2, cursor });
      expect(result.ok).toBe(true);
      triples.push(...result.triples);
      if (!result.truncated) break;
      cursor = result.cursor;
    }
    expect(triples).toHaveLength(5);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(5);
    expect(triples.filter(triple => triple.subject === 'urn:seek').map(triple => triple.object)).toEqual(expect.arrayContaining([
      '"1"', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', '"1"@en', '"1"@fr',
    ]));
    expect(requests.every(request => !/\bOFFSET\b/.test(request.sparql))).toBe(true);
  });
  it('can render membership before requesting slower visible-page counts', async () => {
    await assertion('one'); await assertion('two');
    const page = await listAssertionsPage(cg, 'wm', { includeCounts: false });
    expect(page.items).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(page.items.every(item => item.tripleCount === undefined)).toBe(true);
    const counts = await fetchAssertionPageCounts(cg, page.items);
    expect(counts).toEqual({ [iri('one')]: 1, [iri('two')]: 1 });
    expect(requests).toHaveLength(2);
  });
  it('reads a clicked resource directly across KAs without admitting foreign-context details', async () => {
    await assertion('other'); await assertion('late-page');
    const target = 'urn:order:42';
    await store.insert([
      { subject: target, predicate: 'http://schema.org/name', object: '"Order 42"', graph: content('late-page') },
      { subject: 'urn:step', predicate: 'urn:forOrder', object: target, graph: content('other') },
      { subject: target, predicate: 'http://schema.org/name', object: '"FOREIGN"', graph: `${root}-foreign/_working_memory/${owner}/1` },
    ]);
    const detail = await fetchMemoryEntity(cg, target, 'wm');
    expect(detail.partial).toBe(false);
    expect(detail.triples).toHaveLength(2);
    expect(detail.triples.some(triple => triple.object.includes('FOREIGN'))).toBe(false);
    expect(detail.triples.some(triple => triple.subject === 'urn:step')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].sparql).toContain('LIMIT 1001');
  });
  it('pages every canonical KA once and counts only the visible page', async () => {
    for (let i = 0; i < 105; i++) await assertion(String(i).padStart(3, '0'));
    const first = await listAssertionsPage(cg, 'wm');
    const second = await listAssertionsPage(cg, 'wm', { cursor: first.nextCursor });
    const third = await listAssertionsPage(cg, 'wm', { cursor: second.nextCursor });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 5]);
    expect(third.nextCursor).toBeUndefined();
    expect(failures).toEqual([]);
    const items = [...first.items, ...second.items, ...third.items];
    expect(new Set(items.map(item => item.graphUri)).size).toBe(105);
    expect(items.filter(item => item.tripleCount !== 1 || item.reservedUal !== `did:dkg:asset:${item.name}`).slice(0, 2)).toEqual([]);
    expect(requests.filter(request => request.sparql.includes('COUNT(*)')).map(request =>
      (request.sparql.match(/<urn:dkg:assertion:/g) ?? []).length)).toEqual([50, 50, 5]);
    expect(requests.filter(request => !request.sparql.includes('COUNT(*)')).every(request => request.sparql.endsWith('LIMIT 51'))).toBe(true);
    await listAssertionsPage(cg, 'wm');
    expect(requests).toHaveLength(6);
  });
  it('preserves legacy markers, colon-containing names, and opt-in catalog visibility', async () => {
    await assertion('input:order:42', 'WM', 'production');
    await assertion('query-catalog-test', 'WM', 'meta');
    await assertion('profile-hidden', 'WM', 'meta');
    await store.insert([{ subject: physical('legacy'), predicate: dkg + 'memoryLayer', object: '"WM"', graph: meta }]);
    await store.insert([{ subject: `${root}/meta/assertion/legacy-peer/query-catalog-legacy`, predicate: dkg + 'memoryLayer', object: '"WM"', graph: meta }]);
    const first = await listAssertionsPage(cg, 'wm');
    expect(first.items.map(item => item.name).sort()).toEqual(['input:order:42', 'legacy']);
    const catalogs = await listAssertionsPage(cg, 'wm', { includeQueryCatalog: true });
    expect(catalogs.items.map(item => item.name).sort()).toEqual(['input:order:42', 'legacy', 'query-catalog-legacy', 'query-catalog-test']);
  });
  it('suppresses published SWM aliases after the canonical pointer moves to shared storage', async () => {
    const published = await assertion('published', 'SWM');
    const live = await assertion('live', 'SWM');
    await store.delete([{ subject: published, predicate: dkg + 'assertionGraph', object: content('published'), graph: meta }]);
    await store.insert([
      { subject: published, predicate: dkg + 'assertionGraph', object: `${root}/_shared_memory`, graph: meta },
      { subject: published, predicate: dkg + 'vmCurrentAssertion', object: 'urn:published:version', graph: meta },
    ]);
    expect((await listAssertionsPage(cg, 'swm', { pageSize: 1 })).items.map(item => item.graphUri)).toEqual([live]);
    expect(requests).toHaveLength(1);
  });
  it('does not count foreign-context data through a metadata pointer', async () => {
    const id = iri('foreign-pointer');
    const graph = `${root}-foreign/_working_memory/${owner}/1`;
    await store.insert([
      { subject: id, predicate: dkg + 'memoryLayer', object: '"WM"', graph: meta },
      { subject: id, predicate: dkg + 'assertionGraph', object: graph, graph: meta },
      { subject: 'urn:private', predicate: 'urn:p', object: '"SECRET"', graph },
    ]);
    const page = await listAssertionsPage(cg, 'wm');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].tripleCount).toBeUndefined();
  });
});
