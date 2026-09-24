// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';
import { stubNodeEventStream, type FakeNodeEventStream, type FetchFallback } from './helpers/fake-event-stream.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

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

function Probe({ contextGraphId }: { contextGraphId: string }) {
  const memory = useMemoryEntities(contextGraphId);
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
  let queryFetch: Mock<FetchFallback>;
  let events: FakeNodeEventStream;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    revision = 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    queryFetch = vi.fn<FetchFallback>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { sparql?: string; contextGraphId?: string };
      const bindings = bindingsForLayer(body.sparql ?? '', body.contextGraphId ?? 'unknown', revision);
      return {
        ok: true,
        json: async () => ({ result: { bindings } }),
      } as Response;
    });
    events = stubNodeEventStream(queryFetch);
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

    expect(queryFetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');

    revision = 2;
    await act(async () => {
      await events.latest().emit('memory_graph_changed', {
        contextGraphId: 'project-a',
        layers: ['wm'],
        operation: 'assertion_written',
        timestamp: new Date().toISOString(),
      });
      vi.advanceTimersByTime(349);
    });
    expect(queryFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    expect(queryFetch).toHaveBeenCalledTimes(6);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('2');
  });

  it('ignores memory_graph_changed events for other context graphs', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-a' }));
    });
    await flush();

    revision = 2;
    await act(async () => {
      await events.latest().emit('memory_graph_changed', {
        contextGraphId: 'project-b',
        layers: ['wm'],
        operation: 'assertion_written',
      });
      vi.advanceTimersByTime(350);
    });
    await flush();

    expect(queryFetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');
  });
});
