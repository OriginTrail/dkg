// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const graphState = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
}));

vi.mock('@origintrail-official/dkg-graph-viz/react', async () => {
  const React = await import('react');
  return {
    RdfGraph(props: any) {
      const defaultColor = props.options?.style?.defaultNodeColor ?? '';
      React.useEffect(() => {
        graphState.mounts.push(defaultColor);
        return () => {
          graphState.unmounts.push(defaultColor);
        };
      }, [defaultColor]);

      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-default-color': defaultColor,
        'data-node-colors': JSON.stringify(props.options?.style?.nodeColors ?? {}),
        'data-triples': String(props.data?.length ?? 0),
        'data-scale-with-degree': String(Boolean(props.options?.hexagon?.scaleWithDegree)),
      });
    },
  };
});

const triples = [
  {
    subject: 'urn:test:root',
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: 'http://schema.org/Thing',
  },
  {
    subject: 'urn:test:root',
    predicate: 'https://schema.org/mentions',
    object: 'urn:test:target',
  },
];

async function waitForAssertion(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 1000) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe('LayerGraphPanel graph lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    graphState.mounts.length = 0;
    graphState.unmounts.length = 0;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for SWM attribution colors before first graph paint', async () => {
    let resolveFetch!: (response: any) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    })));

    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });

    expect(container.textContent).toContain('Loading Shared Working Memory attribution...');
    expect(container.querySelector('[data-testid="rdf-graph"]')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          result: {
            bindings: [{
              op: { value: 'urn:test:op' },
              root: { value: 'urn:test:root' },
              agent: { value: 'did:dkg:agent:alice' },
              publishedAt: { value: '2026-05-22T00:00:00.000Z' },
              g: { value: 'did:dkg:context-graph:cg-1/_shared_memory_meta' },
            }],
          },
        }),
      });
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    const nodeColors = JSON.parse(graph.getAttribute('data-node-colors') ?? '{}');
    expect(nodeColors['urn:test:root']).toBeTruthy();
    expect(container.textContent).not.toContain('Loading Shared Working Memory attribution...');
  });

  it('releases the SWM graph after attribution lookup fails', async () => {
    let resolveFetch!: (response: any) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    })));
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });

    expect(container.querySelector('[data-testid="rdf-graph"]')).toBeNull();

    await act(async () => {
      resolveFetch({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(graph.getAttribute('data-default-color')).toBe('#f59e0b');
  });

  it('releases the SWM graph if attribution lookup stalls', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise(() => {});
    }));
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });

    expect(container.textContent).toContain('Loading Shared Working Memory attribution...');
    expect(container.querySelector('[data-testid="rdf-graph"]')).toBeNull();
    expect(requestSignal?.aborted).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(requestSignal?.aborted).toBe(true);
    expect(graph.getAttribute('data-default-color')).toBe('#f59e0b');
    expect(JSON.parse(graph.getAttribute('data-node-colors') ?? '{}')).toEqual({});
  });

  it('invalidates in-flight attribution when the hook is disabled', async () => {
    const resolvers: Array<(response: any) => void> = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => new Promise((resolve) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      resolvers.push(resolve);
    })));
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });
    expect(container.querySelector('[data-testid="rdf-graph"]')).toBeNull();

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      resolvers[0]!({
        ok: true,
        json: async () => ({
          result: {
            bindings: [{
              op: { value: 'urn:test:op' },
              root: { value: 'urn:test:root' },
              agent: { value: 'did:dkg:agent:alice' },
              publishedAt: { value: '2026-05-22T00:00:00.000Z' },
              g: { value: 'did:dkg:context-graph:cg-1/_shared_memory_meta' },
            }],
          },
        }),
      });
    });

    graphState.mounts.length = 0;
    graphState.unmounts.length = 0;

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
        contextGraphId: 'cg-1',
      }));
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Loading Shared Working Memory attribution...');
    expect(container.querySelector('[data-testid="rdf-graph"]')).toBeNull();
    expect(graphState.mounts).toEqual([]);

    await act(async () => {
      resolvers[1]!({
        ok: true,
        json: async () => ({
          result: {
            bindings: [{
              op: { value: 'urn:test:op-2' },
              root: { value: 'urn:test:root' },
              agent: { value: 'did:dkg:agent:bob' },
              publishedAt: { value: '2026-05-22T00:01:00.000Z' },
              g: { value: 'did:dkg:context-graph:cg-1/_shared_memory_meta' },
            }],
          },
        }),
      });
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });
  });

  it('remounts the graph when the active layer changes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples,
      }));
    });
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'swm',
        triples,
      }));
    });
    await waitForAssertion(() => {
      expect(graphState.mounts).toHaveLength(2);
    });

    expect(graphState.mounts).toEqual(['#64748b', '#f59e0b']);
    expect(graphState.unmounts).toEqual(['#64748b']);
  });

  it('renders layer graph with degree sizing and in-canvas expand control', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples,
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    expect(container.textContent).not.toContain('Working Memory graph:');
    expect(container.textContent).not.toContain('Trust layers');

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(graph.getAttribute('data-scale-with-degree')).toBe('true');

    const expand = container.querySelector('.v10-graph-expand-btn.in-canvas') as HTMLButtonElement;
    expect(expand).toBeTruthy();
    await act(async () => {
      expand.click();
    });

    expect(document.body.querySelector('.v10-graph-expanded-panel')).toBeTruthy();
    expect(document.body.querySelectorAll('[data-testid="rdf-graph"]').length).toBe(1);

    const backdrop = document.body.querySelector('.v10-graph-expanded-backdrop') as HTMLDivElement;
    await act(async () => {
      backdrop.click();
    });
    expect(document.body.querySelector('.v10-graph-expanded-panel')).toBeNull();
  });

  it('keeps valid non-http RDF resource IRIs connected in the graph', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples: [
          {
            subject: 'urn:test:root',
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://schema.org/Thing',
          },
          {
            subject: 'urn:test:root',
            predicate: 'https://schema.org/mentions',
            object: 'ipfs://bafybeigdyrzt',
          },
        ],
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(graph.getAttribute('data-triples')).toBe('2');
    expect(container.textContent).not.toContain('Singleton shelf');
  });

  it('moves disconnected singleton subjects into the shelf instead of the graph data', async () => {
    const onNodeClick = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');
    const singletonTriples = Array.from({ length: 18 }).flatMap((_, index) => [
      {
        subject: `urn:test:solo-${index}`,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://schema.org/Thing',
      },
      {
        subject: `urn:test:solo-${index}`,
        predicate: 'http://schema.org/name',
        object: `Solo document ${index}`,
      },
    ]);

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples: [
          ...triples,
          ...singletonTriples,
        ],
        onNodeClick,
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(graph.getAttribute('data-triples')).toBe('2');
    expect(container.textContent).toContain('Standalone entities');
    expect(container.textContent).toContain('18');

    const singletonItems = container.querySelectorAll('.v10-graph-singleton-item');
    expect(singletonItems.length).toBe(18);
    const labels = Array.from(singletonItems).map((item) => item.textContent);
    expect(labels).toContain('Solo document 17');
    const singleton = singletonItems[17] as HTMLButtonElement;
    await act(async () => {
      singleton.click();
    });
    expect(onNodeClick).toHaveBeenCalledWith({ id: singleton.getAttribute('title'), trustLayer: 'wm' });
  });

  it('uses decoded labels and canonical IDs for singleton shelf entries', async () => {
    const onNodeClick = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples: [
          ...triples,
          {
            subject: '<urn:test:wrapped-singleton>',
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://schema.org/Thing',
          },
          {
            subject: 'urn:test:wrapped-singleton',
            predicate: 'http://schema.org/name',
            object: '"Line\\nLabel"',
          },
        ],
        onNodeClick,
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const singletonItems = container.querySelectorAll('.v10-graph-singleton-item');
    expect(singletonItems.length).toBe(1);
    const singleton = singletonItems[0] as HTMLButtonElement;
    expect(singleton.textContent).toBe('Line\nLabel');
    expect(singleton.getAttribute('title')).toBe('urn:test:wrapped-singleton');
    await act(async () => {
      singleton.click();
    });
    expect(onNodeClick).toHaveBeenCalledWith({ id: 'urn:test:wrapped-singleton', trustLayer: 'wm' });
  });

  it('keeps mixed-scope subgraph graph scope visible without the generic trust rail', async () => {
    const onNodeClick = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        title: 'Subgraph alpha',
        triples: [
          ...triples,
          {
            subject: 'urn:test:mixed-scope-singleton',
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://schema.org/Thing',
          },
        ],
        onNodeClick,
        scopeLabel: 'Subgraph graph: alpha entities and entity-to-entity triples from loaded subgraph data.',
        trustLegendActiveLayer: null,
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    expect(container.querySelector('.v10-graph-expand-btn')?.getAttribute('aria-label')).toBe('Expand Subgraph alpha graph');
    expect(container.textContent).toContain('Subgraph graph: alpha entities and entity-to-entity triples from loaded subgraph data.');
    expect(container.textContent).not.toContain('Trust layers');

    const singleton = container.querySelector('.v10-graph-singleton-item') as HTMLButtonElement;
    expect(singleton).toBeTruthy();
    await act(async () => {
      singleton.click();
    });
    expect(onNodeClick).toHaveBeenCalledWith({ id: 'urn:test:mixed-scope-singleton' });
  });

  it('keeps blank-node and angle-wrapped resource edges in the graph data', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { LayerGraphPanel } = await import('../src/ui/views/project/components.js');

    await act(async () => {
      root.render(React.createElement(LayerGraphPanel, {
        layer: 'wm',
        triples: [
          {
            subject: 'urn:test:root',
            predicate: 'https://schema.org/mentions',
            object: '_:blank-target',
          },
          {
            subject: 'urn:test:angle-source',
            predicate: 'https://schema.org/mentions',
            object: '<urn:test:angle-target>',
          },
          {
            subject: 'urn:test:angle-target',
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://schema.org/Thing',
          },
        ],
      }));
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
    });

    const graph = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement;
    expect(graph.getAttribute('data-triples')).toBe('3');
    expect(container.textContent).not.toContain('Singleton shelf');
  });
});
