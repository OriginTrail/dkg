// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/dist/dkg-query-engine.js';
import { invalidateQueryCache } from '../src/ui/api.js';
import { useMemoryEntities, type MemoryData } from '../src/ui/hooks/useMemoryEntities.js';
const events = vi.hoisted(() => ({ refresh: () => {} }));
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: (_id: string, refresh: () => void) => { events.refresh = refresh; } }));
const owner = '0x1111111111111111111111111111111111111111'; const cg = `${owner}/preview`;
let store: OxigraphStore; let engine: DKGQueryEngine; let root: Root; let container: HTMLDivElement; let memory: MemoryData;
let holdOldPage: boolean; let resolveOldPage: (() => void) | undefined;
function Probe({ id = cg, catalog = false }: { id?: string; catalog?: boolean }) {
  memory = useMemoryEntities(id, { includeQueryCatalog: catalog }); return React.createElement('div', null, memory.entityList.length);
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
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (holdOldPage && request.contextGraphId === cg && request.sparql.includes(`> "did:dkg:context-graph:${cg}/_working_memory/`)) {
      await new Promise<void>(resolve => { resolveOldPage = resolve; });
    }
    const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
    return new Response(JSON.stringify({ result: { type: 'bindings', bindings: result.bindings } }));
  }));
});
afterEach(async () => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); invalidateQueryCache(); await store.close(); });
describe('memory continuation and refresh with the scoped native store', () => {
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
