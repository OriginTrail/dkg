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
    RdfGraph(props: { data: ReadonlyArray<{ subject: string; predicate: string; object: string }> | undefined }) {
      // Surface the triples this render received as a DOM attribute so
      // tests can assert on it; the production component never reads
      // these attributes.
      const triples = (props.data ?? []).map((t) => ({ s: t.subject, p: t.predicate, o: t.object }));
      const objects = triples.map((t) => t.o);
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-triple-objects': JSON.stringify(objects),
        'data-triples': JSON.stringify(triples),
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

  // C17 regression: in a narrowed single-layer Graph view, a promoted entity
  // whose SWM/VM triples lost their `subGraph` tag on promotion must keep its
  // subject-local triples (rdf:type, labels, literal-valued properties) — the
  // earlier `both ends in scopedUris` filter accidentally dropped them
  // because class IRIs and literals are never themselves scoped entities.
  // Test shape: two scoped entities connected by one resource edge so the
  // singleton shelf doesn't pull either off-canvas, then assert both
  // entities' rdf:type and label triples survive into the rendered set.
  it('preserves subject-local triples (rdf:type / labels / literals) on promoted entities when narrowed to one layer', async () => {
    // Both entities live in 'demo' (WM origin) and have been promoted to SWM.
    // Their SWM triples lost the `subGraph` tag on promotion — the scenario
    // C17's fix targets.
    const promotedA = {
      uri: 'urn:e:promoted-a',
      label: 'Promoted A',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const promotedB = {
      uri: 'urn:e:promoted-b',
      label: 'Promoted B',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const edgeTriple = {
      subject: 'urn:e:promoted-a',
      predicate: 'http://schema.org/knows',
      object: 'urn:e:promoted-b',
      subGraph: undefined as string | undefined,
      layer: 'shared' as const,
    };
    const typeTripleA = {
      subject: 'urn:e:promoted-a',
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://schema.org/Thing',
      subGraph: undefined as string | undefined,
      layer: 'shared' as const,
    };
    const labelTripleA = {
      subject: 'urn:e:promoted-a',
      predicate: 'http://schema.org/name',
      object: '"Promoted A"',
      subGraph: undefined as string | undefined,
      layer: 'shared' as const,
    };
    const promotedMemory = {
      entities: new Map([
        [promotedA.uri, promotedA],
        [promotedB.uri, promotedB],
      ]),
      entityList: [promotedA, promotedB],
      allTriples: [edgeTriple, typeTripleA, labelTripleA],
      graphTriples: [
        { subject: edgeTriple.subject, predicate: edgeTriple.predicate, object: edgeTriple.object },
        { subject: typeTripleA.subject, predicate: typeTripleA.predicate, object: typeTripleA.object },
        { subject: labelTripleA.subject, predicate: labelTripleA.predicate, object: labelTripleA.object },
      ],
      trustMap: new Map(),
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
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
            rawMemory: promotedMemory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    function readGraphTriples(): Array<{ s: string; p: string; o: string }> {
      const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
      if (!el) return [];
      try {
        return JSON.parse(el.getAttribute('data-triples') ?? '[]');
      } catch {
        return [];
      }
    }

    // Narrow to SWM only by toggling off WM + VM.
    const chips = Array.from(container.querySelectorAll('button.v10-minipyr-chip')) as HTMLButtonElement[];
    const wmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Working Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verified Memory'));
    expect(wmChip).toBeTruthy();
    expect(vmChip).toBeTruthy();

    await act(async () => { wmChip!.click(); });
    await act(async () => { vmChip!.click(); });

    // After narrowing to SWM only, all three triples must survive end-to-end:
    //  - the entity-to-entity edge (would already survive pre-C17),
    //  - promoted-a's `rdf:type :Thing` triple, whose object is a class IRI
    //    *not* in `scopedUris` — pre-C17 the `scopedUris.has(t.object)` half
    //    of the both-ends test dropped this,
    //  - promoted-a's `schema:name "Promoted A"` label triple, whose object
    //    is a literal — pre-C17 dropped this same way.
    // The both-ends recovery still works because subject is in scope.
    await waitForGraph(() => {
      const triples = readGraphTriples();
      const hasEdge = triples.some(
        (t) => t.s === 'urn:e:promoted-a'
          && t.p === 'http://schema.org/knows'
          && t.o === 'urn:e:promoted-b',
      );
      const hasType = triples.some(
        (t) => t.s === 'urn:e:promoted-a'
          && t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && t.o === 'http://schema.org/Thing',
      );
      const hasLabel = triples.some(
        (t) => t.s === 'urn:e:promoted-a'
          && t.p === 'http://schema.org/name'
          && t.o === '"Promoted A"',
      );
      expect(hasEdge).toBe(true);
      expect(hasType).toBe(true);
      expect(hasLabel).toBe(true);
    });
  });
});
