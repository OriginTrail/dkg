// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { SubGraphDetailView } from '../src/ui/views/project/components.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@origintrail-official/dkg-graph-viz/react', async () => {
  const React = await import('react');
  return {
    RdfGraph(props: { data: ReadonlyArray<{ object: string }> | undefined }) {
      // Surface the triples this render received as a DOM attribute so
      // tests can assert on it; the production component never reads
      // this attribute.
      const objects = (props.data ?? []).map((t) => t.object);
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-triple-objects': JSON.stringify(objects),
      });
    },
  };
});

const entity = {
  uri: 'urn:entity:demo',
  label: 'Demo entity',
  types: [],
  trustLevel: 'working',
  layers: new Set(['working']),
  subGraphs: new Set(['demo']),
  properties: new Map(),
  connections: [],
};

const rawMemory = {
  entities: new Map([[entity.uri, entity]]),
  entityList: [entity],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 1, swm: 0, vm: 0, total: 1 },
  loading: false,
  error: null,
  partial: false,
  refresh: vi.fn(),
} as any;

const profile: ProjectProfile = {
  contextGraphId: 'cg-test',
  displayName: 'Context Graph Test',
  primaryColor: '#64748b',
  accentColor: '#38bdf8',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: (slug: string) => ({
    slug,
    displayName: slug,
    color: '#38bdf8',
    icon: '#',
    rank: 0,
  }),
  forType: () => undefined,
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// RdfGraph is React.lazy'd, so the first paint is a Suspense fallback.
// Poll until the assertion passes (or 1 s elapses) — pumping microtasks
// inside `act` so the lazy import resolves and the mock can render.
async function waitForGraph(assertion: () => void): Promise<void> {
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

describe('SubGraphDetailView tabs', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
  });

  it('clamps an unsupported controlled timeline tab back to entities', async () => {
    const onTabChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphDetailView, {
            slug: 'demo',
            rawMemory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'timeline',
            onTabChange,
          })),
      );
    });
    await flush();

    expect(onTabChange).toHaveBeenCalledWith('items');
    expect(container.querySelector('[data-cg-scroll-key="subgraph:demo:items"]')).toBeTruthy();
    expect(container.querySelector('[data-cg-scroll-key="subgraph:demo:timeline"]')).toBeNull();
  });

  // C15 regression: when the subgraph trust filter is narrowed to a single
  // layer, the Graph tab must drop triples from other layers — otherwise
  // users see cross-layer edges in what should be a layer-scoped view.
  it('filters cross-layer triples out of the Graph tab when only one layer is enabled', async () => {
    const overlapEntity = {
      uri: 'urn:e:overlap',
      label: 'Overlap entity',
      types: [],
      trustLevel: 'shared', // promoted to SWM, but also has a WM triple
      layers: new Set(['working', 'shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const wmNeighbour = {
      uri: 'urn:e:wm-neighbour',
      label: 'WM neighbour',
      types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const swmNeighbour = {
      uri: 'urn:e:swm-neighbour',
      label: 'SWM neighbour',
      types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const wmEdge = {
      subject: 'urn:e:overlap',
      predicate: 'urn:rel:knows',
      object: 'urn:e:wm-neighbour',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const swmEdge = {
      subject: 'urn:e:overlap',
      predicate: 'urn:rel:knows',
      object: 'urn:e:swm-neighbour',
      subGraph: 'demo',
      layer: 'shared' as const,
    };
    const overlapMemory = {
      entities: new Map([
        [overlapEntity.uri, overlapEntity],
        [wmNeighbour.uri, wmNeighbour],
        [swmNeighbour.uri, swmNeighbour],
      ]),
      entityList: [overlapEntity, wmNeighbour, swmNeighbour],
      allTriples: [wmEdge, swmEdge],
      // graphTriples is the merged S/P/O-deduped projection without `layer`;
      // both edges differ in object, so both survive the dedup.
      graphTriples: [
        { subject: wmEdge.subject, predicate: wmEdge.predicate, object: wmEdge.object, subGraph: 'demo' },
        { subject: swmEdge.subject, predicate: swmEdge.predicate, object: swmEdge.object, subGraph: 'demo' },
      ],
      trustMap: new Map(),
      counts: { wm: 2, swm: 2, vm: 0, total: 3 },
      loading: false,
      error: null,
      partial: false,
      refresh: vi.fn(),
    } as any;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphDetailView, {
            slug: 'demo',
            rawMemory: overlapMemory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    function readGraphObjects(): string[] {
      const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
      if (!el) return [];
      try {
        return JSON.parse(el.getAttribute('data-triple-objects') ?? '[]');
      } catch {
        return [];
      }
    }

    // Baseline (all three layers enabled): both edges visible in the graph.
    await waitForGraph(() => {
      const objs = readGraphObjects();
      expect([...objs].sort()).toEqual(['urn:e:swm-neighbour', 'urn:e:wm-neighbour']);
    });

    // Narrow the trust filter to WM only by toggling off SWM and VM via
    // MiniLayerPyramid chips (their title text disambiguates which is which).
    const chips = Array.from(container.querySelectorAll('button.v10-minipyr-chip')) as HTMLButtonElement[];
    const swmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Shared Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verified Memory'));
    expect(swmChip).toBeTruthy();
    expect(vmChip).toBeTruthy();

    await act(async () => { swmChip!.click(); });
    await act(async () => { vmChip!.click(); });

    // After narrowing: the SWM-layer edge must be filtered out; only the
    // WM edge survives. Without the C15 fix, the graph would still receive
    // both edges (cross-layer leak) even though clicks were layer-scoped.
    await waitForGraph(() => {
      const objs = readGraphObjects();
      expect(objs).toEqual(['urn:e:wm-neighbour']);
    });
  });
});
