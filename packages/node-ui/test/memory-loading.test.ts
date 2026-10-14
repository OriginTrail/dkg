// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateQueryCache } from '../src/ui/api.js';
import { useFetch } from '../src/ui/hooks.js';
import { useMemoryEntities, rdfBindingValue, buildMemoryEntities, type MemoryData } from '../src/ui/hooks/useMemoryEntities.js';
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: () => {} }));
let root: Root; let container: HTMLDivElement; let memory: MemoryData;
const rows = (n: number, id: string) => Array.from({ length: n }, (_, i) => ({
  s: `urn:order:${i}`, p: 'http://schema.org/name', o: JSON.stringify(`Order ${i}`),
  g: `did:dkg:context-graph:${id}/_working_memory/0x1111111111111111111111111111111111111111/1`,
}));
const response = (bindings: unknown[]) => new Response(JSON.stringify({ result: { type: 'bindings', bindings } }));
function Probe({ id }: { id: string }) {
  memory = useMemoryEntities(id, { signalErrors: true });
  return React.createElement('div', null, memory.graphTriples.map(triple => triple.subject).join(','));
}
beforeEach(() => {
  invalidateQueryCache(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); invalidateQueryCache(); vi.unstubAllGlobals(); });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('bounded graph reads', () => {
  it('continues a clipped layer, retries the same failed page, and reuses reads after reopening', async () => {
    let pageFails = true;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.sparql.includes('_verifiable_memory_meta') || request.sparql.includes('STRENDS(STR(?g), "/_shared_memory")')) return response([]);
      if (request.sparql.includes('?__s > "I:urn:order:4999"')) {
        if (pageFails) return new Response('{"error":"temporary"}', { status: 503 });
        return response(rows(1, request.contextGraphId).map(row => ({ ...row, s: 'urn:order:5000' })));
      }
      return response(rows(5000, request.contextGraphId));
    }); vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(React.createElement(Probe, { id: 'cg-a' })));
    await flush();
    expect(memory.hasMore).toBe(true); expect(memory.partial).toBe(true); expect(memory.graphTriples).toHaveLength(5000);
    await act(async () => memory.loadMore?.()); await flush();
    expect(memory.pageError).toContain('Retry'); expect(memory.graphTriples).toHaveLength(5000);
    pageFails = false;
    await act(async () => memory.loadMore?.()); await flush();
    expect(memory.hasMore).toBe(false); expect(memory.partial).toBe(false); expect(memory.graphTriples).toHaveLength(5001);
    const pageReads = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).sparql).filter(sparql => sparql.includes('?__s > "I:urn:order:4999"'));
    expect(pageReads).toHaveLength(2);
    expect(pageReads[0]).toBe(pageReads[1]);
    expect(pageReads.some(sparql => /\bOFFSET\b/.test(sparql))).toBe(false);
    const before = fetch.mock.calls.length;
    await act(async () => root.render(null));
    await act(async () => root.render(React.createElement(Probe, { id: 'cg-a' })));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(before);
    expect(memory.hasMore).toBe(true); // The reopened overview starts with its cached first page.
  });
  it('does not retain another graph’s rows while a new graph is loading', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { contextGraphId } = JSON.parse(String(init.body));
      if (contextGraphId === 'cg-b') return new Promise<Response>(r => { resolve = r; });
      return response(rows(1, contextGraphId));
    }));
    await act(async () => root.render(React.createElement(Probe, { id: 'cg-a' })));
    await flush(); expect(memory.graphTriples.length).toBeGreaterThan(0);
    await act(async () => root.render(React.createElement(Probe, { id: 'cg-b' })));
    expect(memory.loading).toBe(true); expect(memory.graphTriples).toHaveLength(0);
    // Resolve one outstanding read; unmount safely invalidates all remaining continuations.
    await act(async () => resolve(response([])));
  });
  it('preserves blank-node links and does not turn URI-shaped literals into graph nodes', () => {
    const literal = rdfBindingValue({ type: 'literal', value: 'https://example.com/text', 'xml:lang': 'en' })!;
    expect(literal).toBe('"https://example.com/text"@en');
    const blank = rdfBindingValue({ type: 'bnode', value: 'step' })!;
    expect(blank).toBe('_:step');
    const entities = buildMemoryEntities([
      { subject: 'urn:order', predicate: 'urn:note', object: literal, layer: 'working' },
      { subject: 'urn:order', predicate: 'urn:step', object: blank, layer: 'working' },
    ]);
    expect(entities.has('https://example.com/text')).toBe(false);
    expect(entities.has('_:step')).toBe(true);
  });
});

describe('pending tab reads', () => {
  it('does not let an older refresh overwrite a newer result in the same tab', async () => {
    let resolve!: (value: string) => void; let refresh!: () => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }))
      .mockResolvedValue('fresh result');
    function FetchProbe() {
      const result = useFetch(fetcher); refresh = result.refresh;
      return React.createElement('div', null, result.data);
    }
    await act(async () => root.render(React.createElement(FetchProbe)));
    await act(async () => refresh());
    await act(async () => resolve('obsolete result'));
    expect(container.textContent).toBe('fresh result');
  });
  it('ignores the old tab response after switching dependencies', async () => {
    let resolve!: (value: string) => void;
    function FetchProbe({ id }: { id: string }) {
      const result = useFetch(() => id === 'old' ? new Promise<string>(r => { resolve = r; }) : Promise.resolve('new result'), [id]);
      return React.createElement('div', null, result.data);
    }
    await act(async () => root.render(React.createElement(FetchProbe, { id: 'old' })));
    await act(async () => root.render(React.createElement(FetchProbe, { id: 'new' })));
    await act(async () => resolve('obsolete result'));
    expect(container.textContent).toBe('new result');
  });
});
