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

function wmBindings(contextGraphId: string, revision: number) {
  return Array.from({ length: revision }, (_, i) =>
    tripleBinding(
      `urn:test:${contextGraphId}:wm-${i + 1}`,
      `did:dkg:context-graph:${contextGraphId}/notes/assertion/agent/a-${i + 1}`,
    ),
  );
}

function Probe({ contextGraphId, includeQueryCatalog = false }: { contextGraphId: string; includeQueryCatalog?: boolean }) {
  const memory = useMemoryEntities(contextGraphId, { includeQueryCatalog });
  return React.createElement(
    'div',
    {
      id: 'probe',
      'data-total': String(memory.counts.total),
      'data-wm': String(memory.counts.wm),
      'data-loading': String(memory.loading),
      'data-error': String(memory.error),
      'data-status': memory.layerStatus.wm,
      'data-uris': memory.entityList.map(entity => entity.uri).sort().join(','),
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
      const body = JSON.parse(String(init?.body ?? '{}')) as { contextGraphId?: string };
      const contextGraphId = body.contextGraphId ?? 'unknown';
      return {
        ok: true,
        json: async () => ({ contextGraphId, layers: {
          wm: { ok: true, truncated: false, bindings: wmBindings(contextGraphId, revision) },
          swm: { ok: true, truncated: false, bindings: [] },
          vm: { ok: true, truncated: false, bindings: [] },
        } }),
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

    expect(fetch).toHaveBeenCalledTimes(1);
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
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(2);
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

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');
  });

  it('completes the current refresh after a StrictMode effect remount', async () => {
    await act(async () => root.render(React.createElement(React.StrictMode, null,
      React.createElement(Probe, { contextGraphId: 'project-strict' }))));
    await flush();
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('false');
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('1');
  });

  it.each(['graph', 'catalog'] as const)('clears the previous snapshot when a changed %s read fails', async change => {
    await act(async () => root.render(React.createElement(Probe, {
      contextGraphId: 'project-a', includeQueryCatalog: true,
    })));
    expect(container.querySelector('#probe')?.getAttribute('data-total')).toBe('1');
    let rejectRead!: (error: Error) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectRead = reject; })));
    await act(async () => root.render(React.createElement(Probe, {
      contextGraphId: change === 'graph' ? 'project-b' : 'project-a', includeQueryCatalog: false,
    })));
    expect(container.querySelector('#probe')?.getAttribute('data-total')).toBe('0');
    await act(async () => rejectRead(new Error('Authority unavailable')));
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('false');
    expect(container.querySelector('#probe')?.getAttribute('data-error')).toBe('null');
    expect(container.querySelector('#probe')?.getAttribute('data-status')).toBe('error');
    expect(container.querySelector('#probe')?.getAttribute('data-total')).toBe('0');
  });

  it('discards a queued trailing refresh after unmount', async () => {
    let resolveRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveRead = resolve; })));
    await act(async () => root.render(React.createElement(Probe, { contextGraphId: 'project-a' })));
    await act(async () => {
      MockEventSource.instances[0].emit('memory_graph_changed', { contextGraphId: 'project-a', layers: ['wm'], operation: 'write' });
      vi.advanceTimersByTime(350);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await act(async () => resolveRead({ ok: true, json: async () => ({ contextGraphId: 'project-a', layers: {
      wm: { ok: true, truncated: false, bindings: wmBindings('project-a', 1) },
      swm: { ok: true, truncated: false, bindings: [] },
      vm: { ok: true, truncated: false, bindings: [] },
    } }) } as Response));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['graph', 'catalog'] as const)('rejects the pending old %s response and completes the queued current read', async change => {
    const requests: Array<{ contextGraphId: string; includeQueryCatalog: boolean; resolve: (response: Response) => void }> = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const scope = JSON.parse(String(init?.body)) as { contextGraphId: string; includeQueryCatalog: boolean };
      return new Promise<Response>(resolve => requests.push({ ...scope, resolve }));
    }));
    const initialGraph = `pending-${change}-a`;
    const currentGraph = change === 'graph' ? `pending-${change}-b` : initialGraph;
    const respond = (request: typeof requests[number], subject: string) => request.resolve({
      ok: true,
      json: async () => ({ contextGraphId: request.contextGraphId, layers: {
        wm: { ok: true, truncated: false, bindings: [tripleBinding(subject, `did:dkg:context-graph:${request.contextGraphId}/notes/assertion/agent/a`)] },
        swm: { ok: true, truncated: false, bindings: [] },
        vm: { ok: true, truncated: false, bindings: [] },
      } }),
    } as Response);
    await act(async () => root.render(React.createElement(Probe, { contextGraphId: initialGraph, includeQueryCatalog: true })));
    expect(requests).toHaveLength(1);
    await act(async () => root.render(React.createElement(Probe, { contextGraphId: currentGraph, includeQueryCatalog: false })));
    expect(requests).toHaveLength(1);
    expect(container.querySelector('#probe')?.getAttribute('data-uris')).toBe('');
    await act(async () => respond(requests[0], 'urn:stale-result'));
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ contextGraphId: currentGraph, includeQueryCatalog: false });
    expect(container.querySelector('#probe')?.getAttribute('data-uris')).toBe('');
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('true');
    await act(async () => respond(requests[1], 'urn:current-result'));
    await flush();
    expect(container.querySelector('#probe')?.getAttribute('data-uris')).toBe('urn:current-result');
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('false');
  });

  it('collapses events during an active read to one trailing refresh', async () => {
    let resolveFirst!: (response: Response) => void;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const { contextGraphId = 'unknown' } = JSON.parse(String(init?.body ?? '{}')) as {
        contextGraphId?: string;
      };
      const response = () => ({
        ok: true,
        json: async () => ({ contextGraphId, layers: {
          wm: { ok: true, truncated: false, bindings: wmBindings(contextGraphId, calls) },
          swm: { ok: true, truncated: false, bindings: [] },
          vm: { ok: true, truncated: false, bindings: [] },
        } }),
      } as Response);
      if (calls === 1) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      }
      return response();
    }));

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-a' }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      MockEventSource.instances[0].emit('memory_graph_changed', {
        contextGraphId: 'project-a', layers: ['wm'], operation: 'write-1',
      });
      vi.advanceTimersByTime(350);
      MockEventSource.instances[0].emit('memory_graph_changed', {
        contextGraphId: 'project-a', layers: ['wm'], operation: 'write-2',
      });
      vi.advanceTimersByTime(350);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        ok: true,
        json: async () => ({ contextGraphId: 'project-a', layers: {
          wm: { ok: true, truncated: false, bindings: wmBindings('project-a', 1) },
          swm: { ok: true, truncated: false, bindings: [] },
          vm: { ok: true, truncated: false, bindings: [] },
        } }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('2');
  });

  it('keeps the current scope snapshot visible while its refresh is pending', async () => {
    const contextGraphId = 'same-scope-refresh';
    await act(async () => root.render(React.createElement(Probe, { contextGraphId })));
    const originalUris = container.querySelector('#probe')?.getAttribute('data-uris');
    let resolveRead!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveRead = resolve; })));
    await act(async () => {
      MockEventSource.instances[0].emit('memory_graph_changed', { contextGraphId, layers: ['wm'], operation: 'write' });
      vi.advanceTimersByTime(350);
    });
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('true');
    expect(container.querySelector('#probe')?.getAttribute('data-uris')).toBe(originalUris);
    await act(async () => resolveRead({ ok: true, json: async () => ({ contextGraphId, layers: {
      wm: { ok: true, truncated: false, bindings: wmBindings(contextGraphId, 2) },
      swm: { ok: true, truncated: false, bindings: [] },
      vm: { ok: true, truncated: false, bindings: [] },
    } }) } as Response));
    expect(container.querySelector('#probe')?.getAttribute('data-loading')).toBe('false');
    expect(container.querySelector('#probe')?.getAttribute('data-wm')).toBe('2');
  });
});
