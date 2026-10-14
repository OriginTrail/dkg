// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { invalidateQueryCache } from '../src/ui/api.js';
import { useMemoryEntities, type MemoryData } from '../src/ui/hooks/useMemoryEntities.js';
import { MemoryReadStatus } from '../src/ui/components/MemoryReadStatus.js';
const events = vi.hoisted(() => ({ refresh: () => {} }));
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: (_id: string, refresh: () => void) => { events.refresh = refresh; } }));
const owner = '0x1111111111111111111111111111111111111111'; const cg = `${owner}/preview`;
let store: OxigraphStore; let engine: DKGQueryEngine; let root: Root; let container: HTMLDivElement; let memory: MemoryData;
let holdOldPage: boolean; let resolveOldPage: (() => void) | undefined;
let holdRefresh: boolean; let resolveRefresh: (() => void) | undefined;
let failShared: boolean;
let requests: Array<{ contextGraphId: string; sparql: string }>;
function Probe({ id = cg, catalog = false }: { id?: string; catalog?: boolean }) {
  memory = useMemoryEntities(id, { includeQueryCatalog: catalog });
  return React.createElement('div', null, memory.entityList.length, React.createElement(MemoryReadStatus, { memory }));
}
async function seed(id: string, count: number) {
  const base = `did:dkg:context-graph:${id}`;
  await store.insert(Array.from({ length: count }, (_, i) => {
    const name = String(i).padStart(2, '0'); const graph = `${base}/_working_memory/${owner}/${name}`;
    const assertion = `urn:dkg:assertion:${id}:${owner}:${name}`;
    return [
      { subject: assertion, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: `${base}/_meta` },
      { subject: assertion, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: `${base}/_meta` },
      { subject: `urn:${id}:${name}`, predicate: 'http://schema.org/name', object: `"${name}"`, graph },
    ];
  }).flat());
}
beforeEach(() => {
  invalidateQueryCache(); store = new OxigraphStore(); engine = new DKGQueryEngine(store);
  holdOldPage = false; resolveOldPage = undefined;
  holdRefresh = false; resolveRefresh = undefined; failShared = false; requests = [];
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    if (failShared && request.sparql.includes('STRENDS(STR(?g), "/_shared_memory")')) {
      return new Response('Temporarily unavailable', { status: 503 });
    }
    if (holdRefresh && !resolveRefresh && request.contextGraphId === cg && request.sparql.includes('SELECT DISTINCT') && request.sparql.includes('"/_working_memory/"')) {
      await new Promise<void>(resolve => { resolveRefresh = resolve; });
    }
    if (holdOldPage && request.contextGraphId === cg && request.sparql.includes(`> "did:dkg:context-graph:${cg}/_working_memory/`)) {
      await new Promise<void>(resolve => { resolveOldPage = resolve; });
    }
    const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
    return new Response(JSON.stringify({ result: { type: 'bindings', bindings: result.bindings } }));
  }));
});
afterEach(async () => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); invalidateQueryCache(); await store.close(); });
describe('memory continuation and refresh with the scoped native store', () => {
  it('reports preview counts when a later SWM page reclassifies a loaded WM entity', async () => {
    await seed(cg, 1); const target = `urn:${cg}:00`;
    await store.insert(Array.from({ length: 6 }, (_, i) => ({
      subject: i === 5 ? target : `urn:shared:${i}`, predicate: 'http://schema.org/name', object: '"Shared entity"',
      graph: `did:dkg:context-graph:${cg}/_shared_memory/${owner}/${String(i).padStart(2, '0')}`,
    })));
    await act(async () => root.render(React.createElement(Probe)));
    expect(memory.counts.wm).toBe(1); expect(memory.partial).toBe(true);
    const previewClaim = container.textContent;
    await act(async () => memory.loadMore?.());
    expect(memory.counts.wm).toBe(0); expect(memory.counts.swm).toBe(6);
    expect(memory.hasMore).toBe(false); expect(memory.partial).toBe(false);
    expect(previewClaim).toContain('Per-layer counts may change');
    expect(previewClaim).not.toContain('lower bounds');
  });
  it.each([1, 6])('can retry a failed layer alongside clipped blanks across %i partitions', async partitions => {
    await seed(cg, partitions); const base = `did:dkg:context-graph:${cg}`;
    await store.insert([
      ...Array.from({ length: 5001 }, (_, i) => ({ subject: `_:blank${i}`, predicate: 'urn:p', object: '"blank"', graph: `${base}/_working_memory/${owner}/00` })),
      { subject: 'urn:shared', predicate: 'urn:p', object: '"shared"', graph: `${base}/_shared_memory/${owner}/00` },
    ]);
    failShared = true;
    await act(async () => root.render(React.createElement(Probe)));
    expect(memory.layerStatus.swm).toBe('error'); expect(memory.limitMessage).toBeTruthy();
    expect(memory.hasMore).toBe(partitions > 5);
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry memory read');
    expect(retry).toBeDefined();
    failShared = false;
    await act(async () => retry!.click());
    expect(memory.layerStatus.swm).toBe('ok');
    expect(memory.graphTriples.some(triple => triple.subject === 'urn:shared')).toBe(true);
    expect(memory.limitMessage).toBeTruthy();
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(partitions > 5 ? ['Load more graph data'] : []);
  });
  it('keeps a clipped blank read partial after all IRI continuation pages finish', async () => {
    await seed(cg, 1); const graph = `did:dkg:context-graph:${cg}/_working_memory/${owner}/00`;
    await store.insert([
      ...Array.from({ length: 5000 }, (_, i) => ({ subject: `urn:regular:${String(i).padStart(4, '0')}`, predicate: 'urn:p', object: '"value"', graph })),
      { subject: '_:blank', predicate: 'urn:p', object: '"blank"', graph },
    ]);
    await act(async () => root.render(React.createElement(Probe)));
    expect(memory.graphTriples).toHaveLength(5000); expect(memory.hasMore).toBe(true);
    expect(container.textContent).toContain('Memory preview limit reached');
    await act(async () => memory.loadMore?.());
    expect(memory.hasMore).toBe(false); expect(memory.partial).toBe(true);
    expect(memory.limitMessage).toContain('relationships remain unloaded');
    expect(container.textContent).toContain('Memory preview limit reached');
    expect(container.querySelector('button')).toBeNull();
  });
  it.each(['switch', 'unmount'])('stops refreshed depth reads after %s while the first inventory is pending', async action => {
    await seed(cg, 12);
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => memory.loadMore?.()); await act(async () => memory.loadMore?.());
    expect(memory.entityList).toHaveLength(12);
    holdRefresh = true; invalidateQueryCache(cg);
    await act(async () => events.refresh());
    expect(resolveRefresh).toBeTypeOf('function');
    const started = requests.filter(request => request.contextGraphId === cg).length;
    if (action === 'switch') {
      const next = `${owner}/replacement`; await seed(next, 1);
      await act(async () => root.render(React.createElement(Probe, { id: next })));
    } else act(() => root.unmount());
    await act(async () => resolveRefresh!());
    expect(requests.filter(request => request.contextGraphId === cg)).toHaveLength(started);
  });
  it('exposes the sixth partition and retains loaded depth after a write and catalog toggle', async () => {
    await seed(cg, 6);
    await act(async () => root.render(React.createElement(Probe)));
    expect(memory.entityList).toHaveLength(5); expect(memory.partial).toBe(true);
    await act(async () => memory.loadMore?.());
    expect(memory.entityList).toHaveLength(6); expect(memory.partial).toBe(false);
    await seed(cg, 7); invalidateQueryCache(cg);
    await act(async () => events.refresh());
    expect(memory.entityList).toHaveLength(7); expect(memory.partial).toBe(false);
    await act(async () => root.render(React.createElement(Probe, { catalog: true })));
    expect(memory.entityList).toHaveLength(7); expect(memory.partial).toBe(false);
  });
  it('ignores a pending old page after switching context graphs', async () => {
    await seed(cg, 6); const next = `${owner}/new`; await seed(next, 1);
    await act(async () => root.render(React.createElement(Probe)));
    holdOldPage = true;
    let pending: unknown;
    await act(async () => { pending = memory.loadMore?.(); });
    expect(resolveOldPage).toBeTypeOf('function');
    await act(async () => root.render(React.createElement(Probe, { id: next })));
    const current = memory.entityList.map(entity => entity.uri);
    await act(async () => { resolveOldPage!(); await pending; });
    expect(memory.entityList.map(entity => entity.uri)).toEqual(current);
    expect(memory.hasMore).toBe(false); expect(memory.pageError).toBeNull();
  });
});
