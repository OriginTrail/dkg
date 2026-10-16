// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';
import { invalidateQueryCache } from '../src/ui/api.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, data: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
  }
}

function tripleBinding(subject: string, graph: string) {
  return {
    s: { value: subject },
    p: { value: RDF_TYPE },
    o: { value: 'http://schema.org/Thing' },
    g: { value: graph },
  };
}

function bindingsForLayer(sparql: string, contextGraphId: string, revision: number) {
  const isVm = sparql.includes('_verifiable_memory_meta');
  // PR #818 sweep 3 — WM SPARQL also contains STRENDS (for the
  // `/_meta` exclusion); discriminate by the SWM-exclusive
  // `/_shared_memory` tail check.
  const isSwm = !isVm && sparql.includes('STRENDS(STR(?g), "/_shared_memory")');
  if (isVm || isSwm) return [];
  return Array.from({ length: revision }, (_, i) =>
    tripleBinding(
      `urn:test:${contextGraphId}:wm-${i + 1}`,
      `did:dkg:context-graph:${contextGraphId}/notes/assertion/agent/a-${i + 1}`,
    ),
  );
}

let memory: ReturnType<typeof useMemoryEntities>;
function Probe({ contextGraphId }: { contextGraphId: string }) {
  memory = useMemoryEntities(contextGraphId);
  return React.createElement(
    'div',
    {
      id: 'probe',
      'data-total': String(memory.counts.total),
      'data-wm': String(memory.counts.wm),
      'data-loading': String(memory.loading),
    },
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useMemoryEntities live updates', () => {
  let container: HTMLDivElement;
  let root: Root;
  let revision = 1;

  beforeEach(() => {
    invalidateQueryCache();
    vi.useFakeTimers();
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    revision = 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { sparql?: string; contextGraphId?: string };
      const bindings = bindingsForLayer(body.sparql ?? '', body.contextGraphId ?? 'unknown', revision);
      return {
        ok: true,
        json: async () => ({ result: { bindings } }),
      } as Response;
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('debounces matching memory_graph_changed events and refreshes graph data', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-a' }));
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');

    revision = 2;
    await act(async () => {
      MockEventSource.instances[0].emit('memory_graph_changed', {
        contextGraphId: 'project-a',
        layers: ['wm'],
        operation: 'assertion_written',
        timestamp: new Date().toISOString(),
      });
      vi.advanceTimersByTime(349);
    });
    expect(fetch).toHaveBeenCalledTimes(5);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(10);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('2');
  });

  it('ignores memory_graph_changed events for other context graphs', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-a' }));
    });
    await flush();

    revision = 2;
    await act(async () => {
      MockEventSource.instances[0].emit('memory_graph_changed', {
        contextGraphId: 'project-b',
        layers: ['wm'],
        operation: 'assertion_written',
      });
      vi.advanceTimersByTime(350);
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');
  });

  it.each(['initial', 'continuation'])('retains one event refresh during a pending %s read', async mode => {
    const graphNames = Array.from({ length: 6 }, (_, i) =>
      `did:dkg:context-graph:project-a/_working_memory/0x1111111111111111111111111111111111111111/${i}`);
    let release: (() => void) | undefined;
    let held = false;
    let normalReads = 0;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const { sparql } = JSON.parse(String(init?.body));
      let bindings: unknown[] = [];
      const working = !sparql.includes('_verifiable_memory_meta') && !sparql.includes('STRENDS(STR(?g), "/_shared_memory")');
      if (working && sparql.includes('SELECT DISTINCT')) {
        bindings = graphNames.filter(graph => !sparql.includes(`> ${JSON.stringify(graphNames[4])}`) || graph > graphNames[4])
          .map(g => ({ g }));
      } else if (working && sparql.includes('FILTER(!isBlank')) {
        normalReads++;
        const visible = graphNames.filter(graph => sparql.includes(`<${graph}>`));
        bindings = visible.map(graph => tripleBinding(`urn:version:${revision}:${graphNames.indexOf(graph)}`, graph));
        const shouldHold = mode === 'initial' || visible.includes(graphNames[5]);
        if (!held && shouldHold) {
          held = true;
          await new Promise<void>(resolve => { release = resolve; });
        }
      }
      return new Response(JSON.stringify({ result: { type: 'bindings', bindings } }));
    });
    await act(async () => root.render(React.createElement(Probe, { contextGraphId: 'project-a' })));
    if (mode === 'continuation') {
      expect(memory.counts.total).toBe(5);
      await act(async () => memory.loadMore?.());
    }
    expect(release).toBeTypeOf('function');
    const before = normalReads;
    revision = 2;
    await act(async () => {
      for (let i = 0; i < 20; i++) MockEventSource.instances[0].emit('memory_graph_changed', {
        contextGraphId: 'project-a', layers: ['wm'], operation: 'assertion_written',
      });
      vi.advanceTimersByTime(350);
    });
    expect(normalReads).toBe(before);
    await act(async () => release!()); await flush();
    expect(memory.loading).toBe(false);
    expect(memory.counts.total).toBe(mode === 'initial' ? 5 : 6);
    expect(memory.allTriples.every(triple => triple.subject.startsWith('urn:version:2:'))).toBe(true);
    expect(normalReads).toBe(mode === 'initial' ? 2 : 4);
    expect(memory.pageError).toBeNull();
  });
});
