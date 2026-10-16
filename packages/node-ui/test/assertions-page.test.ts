// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { generateAssertionCreatedMetadata } from '../../publisher/dist/metadata.js';
import { listAssertionsPage, fetchAssertionPageCounts } from '../src/ui/assertions-page.js';
import { invalidateQueryCache, listAssertions } from '../src/ui/api.js';
import { fetchMemoryEntity, readMemoryGraphPage } from '../src/ui/hooks/useMemoryEntities.js';
import { memoryQueryDefinitions } from '../src/ui/hooks/memory-query-definition.js';

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
  it.each(['', '^^<http://www.w3.org/2001/XMLSchema#string>', '@en'])('decodes publisher reserved UAL literals with suffix %s without changing graph IRIs', async suffix => {
    const name = 'publisher-reservation'; const id = iri(name);
    const ual = `did:dkg:evm:31337/${owner}/7`;
    const metadata = generateAssertionCreatedMetadata({ contextGraphId: cg, agentAddress: owner,
      assertionName: name, kaNumber: 7, reservedUal: ual, timestamp: new Date('2026-10-14T00:00:00Z') },
      { provenanceEvents: false });
    const graph = metadata.find(quad => quad.predicate === dkg + 'assertionGraph')!.object;
    expect(metadata.find(quad => quad.predicate === dkg + 'reservedUal')!.object).toBe(JSON.stringify(ual));
    await store.insert([
      ...metadata.map(quad => quad.predicate === dkg + 'reservedUal' ? { ...quad, object: quad.object + suffix } : quad),
      { subject: 'urn:record', predicate: 'urn:value', object: '"fact"', graph },
    ]);
    const page = await listAssertionsPage(cg, 'wm');
    expect(page.items).toEqual([{ name, graphUri: id, reservedUal: ual, dataGraphUri: graph, tripleCount: 1 }]);
    expect(page.nextCursor).toBeUndefined(); expect(failures).toEqual([]);
  });
  it('preserves lexical standard SPARQL JSON bindings and graph cursors', async () => {
    const ual = `did:dkg:evm:31337/${owner}/7`; const id = iri('standard'); const graph = content('standard');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ result: { type: 'bindings', bindings: [
      { g: { type: 'uri', value: id }, dg: { type: 'uri', value: graph }, ual: { type: 'literal', value: ual } },
      { g: { type: 'uri', value: iri('standard-later') } },
    ] } })));
    const page = await listAssertionsPage(cg, 'wm', { pageSize: 1, includeCounts: false });
    expect(page.items).toEqual([{ name: 'standard', graphUri: id, dataGraphUri: graph, reservedUal: ual }]);
    expect(page.nextCursor).toBe(id);
  });
  it('uses projected SPARQL JSON cursor keys without reinterpreting their lexical quotes', async () => {
    const graph = content('lexical-cursor');
    const literal = (value: string) => ({ type: 'literal', value });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { bindings: [{ g: { type: 'uri', value: graph } }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { bindings: [{
        g: { type: 'uri', value: graph }, s: { type: 'uri', value: 'urn:cursor' },
        p: { type: 'uri', value: 'urn:value' }, o: literal('"quoted"'),
        __g: literal(graph), __s: literal('I:urn:cursor'), __p: literal('urn:value'),
        __kind: literal('L'), __o: literal('"quoted"'), __lang: literal(''),
        __datatype: literal('http://www.w3.org/2001/XMLSchema#string'),
      }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { bindings: [] } })));
    const page = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { layerLimit: 1 });
    expect(page.ok).toBe(true);
    expect(page.nextCursor).toEqual({ kind: 'row', graph,
      termKey: ['I:urn:cursor', 'urn:value', 'L', '"quoted"', '', 'http://www.w3.org/2001/XMLSchema#string'] });
    expect(page.triples[0].object).toBe(JSON.stringify('"quoted"'));
  });
  it.each(['$&', '$$', '$`', "$'", '$1'])('preserves %s in literal keyset cursors', async token => {
    const graph = content('replacement-cursor');
    await store.insert([
      { subject: iri('replacement-cursor'), predicate: dkg + 'assertionGraph', object: graph, graph: meta },
      ...[token, 'a', 'z'].map(value => ({ subject: 'urn:cursor', predicate: 'urn:value', object: JSON.stringify(value), graph })),
    ]);
    const seen: string[] = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 1, cursor });
      expect(result.ok).toBe(true); seen.push(...result.triples.map(triple => triple.object));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([JSON.stringify(token), '"a"', '"z"']);
    expect(failures).toEqual([]);
  });
  it.each(['$&', '$$', "$'", '$1'])('preserves %s in clicked resource IRIs', async token => {
    await assertion('detail-token'); const target = `urn:resource:${token}`;
    await store.insert([
      { subject: target, predicate: 'http://schema.org/name', object: '"Special resource"', graph: content('detail-token') },
      { subject: 'urn:incoming', predicate: 'urn:links', object: target, graph: content('detail-token') },
    ]);
    const detail = await fetchMemoryEntity(cg, target, 'wm');
    expect(detail.partial).toBe(false);
    expect(detail.triples.map(triple => triple.subject).sort()).toEqual(['urn:incoming', target].sort());
    expect(failures).toEqual([]);
  });
  it('preserves replacement tokens in graph VALUES and graph-boundary continuation', async () => {
    for (const name of ['00', '01', '02', '03', '04$&', '04a', '04z']) await assertion(name);
    const seen: string[] = []; let cursor;
    for (let page = 0; page < 3; page++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 100, cursor });
      expect(result.ok).toBe(true); seen.push(...result.triples.map(triple => triple.subject));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(7); expect(seen).toHaveLength(7);
    expect(failures).toEqual([]);
  });
  it('keeps under-budget blank-node subjects and objects complete, including detail reads', async () => {
    await assertion('blank-edges');
    const graph = content('blank-edges');
    await store.insert(Array.from({ length: 7 }, (_, i) => [
      { subject: `_:subject${i}`, predicate: 'urn:value', object: `"value ${i}"`, graph },
      { subject: 'urn:parent', predicate: 'urn:child', object: `_:subject${i}`, graph },
    ]).flat());
    const triples: Array<{ subject: string; predicate: string; object: string }> = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 20, cursor });
      expect(result.ok).toBe(true);
      triples.push(...result.triples);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(triples).toHaveLength(15);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(15);
    const blank = triples.find(triple => triple.subject.startsWith('_:'))!.subject;
    const reads = requests.length;
    const detail = await fetchMemoryEntity(cg, blank, 'wm', false, { triples: triples.map(triple => ({ ...triple, layer: 'working' as const })), partial: false });
    expect(requests).toHaveLength(reads);
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
    const first = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, cursor: first.nextCursor });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.omittedRelationships).toBe(true);
    expect(result.triples).toHaveLength(5000);
    expect(result.nextCursor).toBeUndefined();
    const blank = result.triples.find(triple => triple.subject.startsWith('_:'))!.subject;
    const reads = requests.length;
    const detail = await fetchMemoryEntity(cg, blank, 'wm', false, {
      triples: result.triples.map(triple => ({ ...triple, layer: 'working' as const })), partial: true,
    });
    expect(detail.partial).toBe(true); expect(detail.triples).toHaveLength(1);
    expect(requests).toHaveLength(reads);
  });
  it('continues small blank components without omissions even when a row page is full', async () => {
    for (let i = 0; i < 7; i++) {
      const name = `mix-${i}`; await assertion(name);
      await store.insert([{ subject: `_:blank${i}`, predicate: 'urn:blank', object: `"${i}"`, graph: content(name) }]);
    }
    const triples = []; let cursor; let incomplete = false;
    for (let i = 0; i < 30; i++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 2, cursor });
      expect(result.ok).toBe(true); expect(result.triples.length).toBeLessThanOrEqual(2);
      incomplete ||= result.omittedRelationships ?? false; triples.push(...result.triples);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(incomplete).toBe(false);
    expect(triples.filter(triple => triple.subject.startsWith('_:'))).toHaveLength(7);
    expect(triples.filter(triple => !triple.subject.startsWith('_:'))).toHaveLength(7);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(triples.length);
  });
  it('continues across bounded graph-inventory pages even when a triple page is not full', async () => {
    for (let i = 0; i < 12; i++) await assertion(`graph-${String(i).padStart(2, '0')}`);
    const sizes: number[] = []; const seen: string[] = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 100, cursor });
      expect(result.ok).toBe(true); sizes.push(result.triples.length);
      seen.push(...result.triples.map(triple => triple.subject));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
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
    const triples: Array<{ subject: string; predicate: string; object: string }> = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 2, cursor });
      expect(result.ok).toBe(true);
      triples.push(...result.triples);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
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
    const bulk = await listAssertions(cg, 'wm', { includeCounts: false });
    expect(bulk.map(item => item.graphUri)).toEqual(items.map(item => item.graphUri));
    expect(requests).toHaveLength(8); // Fresh, 100-assertion pages, no count reads.
    await assertion('zzz-after-cached-page');
    expect((await listAssertions(cg, 'wm', { includeCounts: false })).at(-1)?.name).toBe('zzz-after-cached-page');
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
  it('pages assertions rather than combinations of multi-valued metadata', async () => {
    const id = await assertion('00-multi'); await assertion('01-next'); await assertion('02-last');
    await store.insert([
      { subject: id, predicate: dkg + 'reservedUal', object: '"did:dkg:asset:restamped"', graph: meta },
      { subject: id, predicate: dkg + 'assertionGraph', object: physical('00-multi'), graph: meta },
    ]);
    const first = await listAssertionsPage(cg, 'wm', { pageSize: 2, includeCounts: false });
    const second = await listAssertionsPage(cg, 'wm', { pageSize: 2, cursor: first.nextCursor, includeCounts: false });
    expect(first.items.map(item => item.name)).toEqual(['00-multi', '01-next']);
    expect(second.items.map(item => item.name)).toEqual(['02-last']);
    expect(second.nextCursor).toBeUndefined();
  });
  it('retains a small graph’s blank edges when the following graph fills a row page', async () => {
    await assertion('00-small'); await assertion('01-large');
    await store.insert([
      ...Array.from({ length: 4 }, (_, i) => ({ subject: `_:small${i}`, predicate: 'urn:blank', object: `"${i}"`, graph: content('00-small') })),
      ...Array.from({ length: 24 }, (_, i) => ({ subject: `urn:large:${String(i).padStart(2, '0')}`, predicate: 'urn:value', object: '"large"', graph: content('01-large') })),
    ]);
    const triples = []; let cursor;
    for (let i = 0; i < 20; i++) {
      const page = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true, layerLimit: 10, cursor });
      expect(page.ok).toBe(true);
      triples.push(...page.triples);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(triples.filter(triple => triple.subject.startsWith('_:'))).toHaveLength(4);
    expect(triples).toHaveLength(30);
    expect(new Set(triples.map(triple => JSON.stringify(triple))).size).toBe(30);
  });
});
