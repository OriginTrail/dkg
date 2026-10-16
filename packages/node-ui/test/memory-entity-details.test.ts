// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { invalidateQueryCache } from '../src/ui/api.js';
import { useMemoryEntityDetails } from '../src/ui/hooks/useMemoryEntityDetails.js';
import { buildMemoryEntities, fetchMemoryEntity, type MemoryData, type MemoryLayerKey } from '../src/ui/hooks/useMemoryEntities.js';
import { readMemoryGraphPage } from '../src/ui/hooks/memory-graph-query.js';
import { memoryQueryDefinitions } from '../src/ui/hooks/memory-query-definition.js';

vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: () => {} }));
vi.mock('../src/ui/hooks/useMemoryEntities.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/hooks/useMemoryEntities.js')>();
  return { ...actual, fetchMemoryEntity: vi.fn(actual.fetchMemoryEntity) };
});
const owner = '0x1111111111111111111111111111111111111111';
const cg = `${owner}/resource-details`;
const graph = `did:dkg:context-graph:${cg}/_working_memory/${owner}/1`;
const swm = `did:dkg:context-graph:${cg}/_shared_memory`;
const name = 'http://schema.org/name';
let store: OxigraphStore; let root: Root; let container: HTMLDivElement; let memory: MemoryData;
let read: ReturnType<typeof useMemoryEntityDetails>; let queries: string[];

function Probe({ uri, layer = 'wm' }: { uri: string; layer?: MemoryLayerKey }) {
  read = useMemoryEntityDetails(cg, uri, layer, false, memory);
  return React.createElement('div', null, read.entity?.label);
}
const render = async (uri: string, layer: MemoryLayerKey = 'wm') => {
  await act(async () => root.render(React.createElement(Probe, { uri, layer })));
  for (let i = 0; i < 100 && read.loading; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(read.loading).toBe(false); expect(read.error).toBeNull();
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(fetchMemoryEntity).mockClear();
  invalidateQueryCache(); store = new OxigraphStore(); queries = [];
  const engine = new DKGQueryEngine(store);
  await store.insert([
    { subject: `urn:dkg:assertion:${cg}:${owner}:1`, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: `did:dkg:context-graph:${cg}/_meta` },
    { subject: 'urn:parent', predicate: name, object: '"Parent"', graph },
    { subject: 'urn:parent', predicate: 'urn:child', object: '_:child', graph },
    { subject: '_:child', predicate: name, object: '"Child"', graph },
    { subject: '_:child', predicate: 'urn:child', object: '_:grandchild', graph },
    { subject: '_:grandchild', predicate: name, object: '"Grandchild"', graph },
    { subject: `urn:dkg:assertion:${cg}:${owner}:shared`, predicate: 'http://dkg.io/ontology/assertionGraph', object: swm, graph: `did:dkg:context-graph:${cg}/_meta` },
    { subject: 'urn:parent', predicate: name, object: '"Shared parent"', graph: swm },
  ]);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); queries.push(request.sparql);
    const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
    // Legal SPARQL responses need not reuse blank labels between queries.
    const bindings = result.bindings?.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'string' && value.startsWith('_:') ? `_:response-${queries.length}-${value.slice(2)}` : value])));
    return new Response(JSON.stringify({ result: { type: 'bindings', bindings } }));
  }));
  const page = await readMemoryGraphPage(memoryQueryDefinitions(cg)[0], cg, { includeContextGraphPartitions: true });
  if (!page.ok) throw new Error(page.reason);
  const allTriples = page.triples.map(triple => ({ ...triple, layer: 'working' as const }));
  const entities = buildMemoryEntities(allTriples);
  memory = { entities, entityList: [...entities.values()], allTriples, graphTriples: page.triples,
    trustMap: new Map(), counts: { wm: entities.size, swm: 0, vm: 0, total: entities.size },
    loading: false, error: null, partial: false, layerStatus: { wm: 'ok', swm: 'ok', vm: 'ok' },
    refresh: () => {}, hasMore: false, canRetry: false, loadMore: () => {}, pageError: null, limitMessage: null };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.unstubAllGlobals(); invalidateQueryCache(); await store.close();
});

describe('resource detail response ownership', () => {
  it('replaces stale labels and deleted links with a complete successful resource response', async () => {
    await store.deleteByPattern({ subject: 'urn:parent', graph });
    await store.insert([{ subject: 'urn:parent', predicate: name, object: '"Updated parent"', graph }]);
    memory = { ...memory, error: 'preview refresh failed', allTriples: [...memory.allTriples.map(triple =>
      triple.subject === 'urn:parent' ? { ...triple, subject: '<urn:parent>' } : triple),
      { subject: 'urn:referrer', predicate: 'urn:reference', object: '<urn:parent>', graph, layer: 'working' },
      { subject: 'urn:referrer', predicate: name, object: '"Unrelated source"', graph, layer: 'working' },
    ] };
    const unrelated = memory.entities.get('urn:parent')!.connections[0].targetUri;
    await render('<urn:parent>');
    expect(read.entity!.label).toBe('Updated parent'); expect(read.entity!.connections).toHaveLength(0);
    expect(read.triples.some(triple => triple.subject === unrelated)).toBe(true);
    expect(read.entities.get('urn:referrer')!.label).toBe('Unrelated source');
    expect(read.entities.get('urn:referrer')!.connections).toHaveLength(0);
  });
  it('removes a deleted resource after a successful empty read instead of reviving the stale fallback', async () => {
    await store.deleteByPattern({ subject: 'urn:parent', graph });
    await render('urn:parent');
    expect(read.entity).toBeNull(); expect(read.entities.has('urn:parent')).toBe(false);
    expect(read.triples.some(triple => triple.subject === 'urn:parent' || triple.object === 'urn:parent')).toBe(false);
  });
  it('prefers fresh labels but retains unconfirmed preview links when the detail read is truncated', async () => {
    vi.mocked(fetchMemoryEntity).mockResolvedValueOnce({
      triples: [{ subject: 'urn:parent', predicate: name, object: '"Updated parent"', graph, layer: 'working' }],
      partial: true, blankGraphs: [],
    });
    await render('urn:parent');
    expect(read.entity!.label).toBe('Updated parent'); expect(read.partial).toBe(true);
    expect(read.entity!.connections.some(link => link.targetUri.startsWith('_:'))).toBe(true);
  });
  it('retains preview facts with an explicit error when no detail response succeeded', async () => {
    vi.mocked(fetchMemoryEntity).mockRejectedValueOnce(new Error('detail unavailable'));
    await act(async () => root.render(React.createElement(Probe, { uri: 'urn:parent' })));
    expect(read.loading).toBe(false); expect(read.error).toBe('detail unavailable');
    expect(read.entity!.label).toBe('Parent'); expect(read.entity!.connections).toHaveLength(1);
  });
  it('shows one blank child and retains its originating facts through deeper navigation', async () => {
    const previewChild = memory.entities.get('urn:parent')!.connections[0].targetUri;
    await render('urn:parent');
    expect(read.entity!.connections).toHaveLength(1);
    const child = read.entity!.connections[0].targetUri;
    expect(child).not.toBe(previewChild);
    expect(read.entities.has(previewChild)).toBe(false);
    expect(read.triples.filter(triple => triple.subject === 'urn:parent' && triple.predicate === 'urn:child')).toHaveLength(1);
    expect(read.triples.every(triple => triple.graph === graph)).toBe(true);
    const before = queries.length;
    const iriReads = vi.mocked(fetchMemoryEntity).mock.calls.length;
    await render(child);
    expect(read.entity!.label).toBe('Child');
    expect(read.entity!.connections).toHaveLength(1);
    await render(read.entity!.connections[0].targetUri);
    expect(read.entity!.label).toBe('Grandchild'); expect(read.partial).toBe(false);
    await render(previewChild);
    expect(read.entity!.label).toBe('Child');
    expect(queries).toHaveLength(before);
    expect(fetchMemoryEntity).toHaveBeenCalledTimes(iriReads);
  });
  it('opens a preview blank directly without scheduling an asynchronous detail read', async () => {
    const child = memory.entities.get('urn:parent')!.connections[0].targetUri;
    const before = queries.length;
    await render(child);
    expect(read.entity!.label).toBe('Child');
    expect(fetchMemoryEntity).not.toHaveBeenCalled(); expect(queries).toHaveLength(before);
  });
  it('invalidates captured facts when changing layers and reports an unavailable detail refresh', async () => {
    await render('urn:parent');
    const child = read.entity!.connections[0].targetUri;
    await render('urn:parent', 'swm');
    expect(read.entity!.label).toBe('Shared parent'); expect(read.entity!.trustLevel).toBe('shared');
    expect(read.entities.has(child)).toBe(false);
    expect(read.triples.every(triple => triple.layer === 'shared')).toBe(true);
    invalidateQueryCache(cg);
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"offline"}', { status: 503 }));
    await act(async () => read.refresh());
    expect(read.error).toBeTruthy(); expect(read.entity!.label).toBe('Shared parent');
  });
  it('keeps a warm response failure with its own blank facts, not unrelated preview labels', async () => {
    const previewChild = memory.entities.get('urn:parent')!.connections[0].targetUri;
    await render('urn:parent');
    const child = read.entity!.connections[0].targetUri;
    invalidateQueryCache(cg);
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"offline"}', { status: 503 }));
    await act(async () => read.refresh());
    expect(read.error).toBeTruthy(); expect(read.entity!.label).toBe('Parent');
    // Both selections use retained facts, without starting even a synthetic read.
    const calls = vi.mocked(fetchMemoryEntity).mock.calls.length;
    await act(async () => root.render(React.createElement(Probe, { uri: child })));
    expect(read.entity!.label).toBe('Child'); expect(read.error).toBeTruthy();
    await render(previewChild);
    expect(read.entity!.label).toBe('Child');
    await act(async () => read.refresh());
    expect(fetchMemoryEntity).toHaveBeenCalledTimes(calls); expect(read.error).toBeNull();
  });
  it('drops the captured response after the preview changes rather than reusing its old blank labels', async () => {
    await render('urn:parent'); const child = read.entity!.connections[0].targetUri;
    memory = { ...memory, allTriples: [] };
    await render(child);
    expect(read.entity).toBeNull(); expect(read.entities.has(child)).toBe(false);
  });
  it.each([1000, 1001])('bounds an indexed detail read containing %i relationships', async count => {
    await store.insert(Array.from({ length: count }, (_, i) => ({
      subject: 'urn:wide', predicate: 'urn:links', object: `urn:target:${i}`, graph,
    })));
    const before = queries.length;
    await render('urn:wide');
    expect(read.entity!.connections).toHaveLength(1000);
    expect(read.triples.filter(triple => triple.subject === 'urn:wide')).toHaveLength(1000);
    expect(read.partial).toBe(count > 1000);
    expect(queries).toHaveLength(before + 1);
    expect(queries.at(-1)).toContain('LIMIT 1001');
  });
  it.each([1000, 1001])('bounds a captured blank detail response containing %i relationships', async count => {
    // One direct edge discovers the blank graph; the bounded recapture owns all labels.
    // Use a separate graph so the existing parent/child fixture cannot change the cutoff.
    const wideGraph = `${graph}-wide`;
    await store.insert([
      { subject: `urn:dkg:assertion:${cg}:${owner}:wide`, predicate: 'http://dkg.io/ontology/assertionGraph', object: wideGraph, graph: `did:dkg:context-graph:${cg}/_meta` },
      { subject: 'urn:isolated-wide', predicate: 'urn:child', object: '_:isolated', graph: wideGraph },
      ...Array.from({ length: count - 1 }, (_, i) => ({
        subject: '_:isolated', predicate: 'urn:links', object: `urn:isolated-target:${i}`, graph: wideGraph,
      })),
    ]);
    const before = queries.length;
    await render('urn:isolated-wide');
    const child = read.entity!.connections[0].targetUri;
    expect(read.entities.get(child)!.connections).toHaveLength(999);
    expect(read.triples.filter(triple => triple.graph === wideGraph)).toHaveLength(1000);
    expect(read.partial).toBe(count > 1000);
    expect(queries).toHaveLength(before + 2);
    expect(queries.at(-1)).toContain('LIMIT 1001');
    await render(child);
    expect(read.partial).toBe(count > 1000);
    expect(queries).toHaveLength(before + 2);
  });
});
