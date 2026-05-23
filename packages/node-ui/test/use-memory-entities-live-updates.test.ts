// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';

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
  const isVm = sparql.includes('_verified_memory_meta');
  const isSwm = !isVm && sparql.includes('STRENDS');
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

  beforeEach(() => {
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

    expect(fetch).toHaveBeenCalledTimes(3);
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
    expect(fetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(6);
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

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');
  });
});
