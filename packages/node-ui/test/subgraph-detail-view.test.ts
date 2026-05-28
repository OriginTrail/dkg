// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { SubGraphDetailView } from '../src/ui/views/project/components.js';
import { ROOT_SLUG_SENTINEL } from '../src/ui/lib/subGraphs.js';
import { TRUST_COLORS } from '../src/ui/views/project/helpers.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@origintrail-official/dkg-graph-viz/react', async () => {
  const React = await import('react');
  return {
    RdfGraph(props: {
      data: ReadonlyArray<{ subject: string; predicate: string; object: string }> | undefined;
      options?: { style?: { nodeColors?: Record<string, string> } };
    }) {
      // Surface the triples this render received as a DOM attribute so
      // tests can assert on it; the production component never reads
      // these attributes.
      const triples = (props.data ?? []).map((t) => ({ s: t.subject, p: t.predicate, o: t.object }));
      const objects = triples.map((t) => t.o);
      // Surface the `nodeColors` style override so tests can assert
      // S3's per-URI trust colouring (fold-in #6) without reaching
      // into the canvas internals.
      const nodeColors = props.options?.style?.nodeColors ?? {};
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-triple-objects': JSON.stringify(objects),
        'data-triples': JSON.stringify(triples),
        'data-node-colors': JSON.stringify(nodeColors),
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
  forSubGraph: (slug: string) => {
    // Mirror the real resolver's ROOT_SLUG_SENTINEL short-circuit so
    // tests that exercise the Root bucket see the same synthesized
    // binding the production code path produces (chip + detail
    // header + breadcrumb all read from this).
    if (slug === ROOT_SLUG_SENTINEL) {
      return {
        slug: ROOT_SLUG_SENTINEL,
        displayName: 'Root',
        description: 'Entities not in any subgraph (Context Graph root)',
        icon: '⊘',
        rank: 99,
      };
    }
    return {
      slug,
      displayName: slug,
      color: '#38bdf8',
      icon: '#',
      rank: 0,
    };
  },
  // Tests historically returned undefined; entityMeta reads
  // `b.label` so a safe no-op fixture must return at least `{}`.
  // Bucket tests that mount the Entities tab depend on this.
  forType: () => ({}) as any,
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
    // MiniLayerBar chips (their title text disambiguates which is which).
    const chips = Array.from(container.querySelectorAll('button.v10-minibar-chip')) as HTMLButtonElement[];
    const swmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Shared Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verifiable Memory'));
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
    const chips = Array.from(container.querySelectorAll('button.v10-minibar-chip')) as HTMLButtonElement[];
    const wmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Working Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verifiable Memory'));
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

  // C18 regression: the C17 fix used `filteredUris`, which is built from
  // `filteredEntities` (`trustLevel`-filtered) — wrong for a layer-narrowed
  // view. A mixed-layer entity (present in WM and SWM) has trustLevel ===
  // 'shared', so in a WM-only chip view the old gate excluded it and its
  // WM rdf:type / label triples were dropped, leaving the entity as an
  // unlabelled node disagreeing with the Entities tab. The fix derives
  // the endpoint-presence URI set from `entity.layers.has(layerTrust)`
  // instead.
  it('keeps WM triples on a mixed-layer entity when narrowed to WM only', async () => {
    // The same entity exists in both WM (with a knows edge + type + label)
    // and SWM (promoted). Its single `trustLevel` is the highest: 'shared'.
    const mixed = {
      uri: 'urn:e:mixed',
      label: 'Mixed entity',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['working', 'shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const wmNeighbour = {
      uri: 'urn:e:wm-neighbour-2',
      label: 'WM neighbour',
      types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const wmEdge = {
      subject: 'urn:e:mixed',
      predicate: 'http://schema.org/knows',
      object: 'urn:e:wm-neighbour-2',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const wmType = {
      subject: 'urn:e:mixed',
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://schema.org/Thing',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const wmLabel = {
      subject: 'urn:e:mixed',
      predicate: 'http://schema.org/name',
      object: '"Mixed entity"',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const swmEdge = {
      subject: 'urn:e:mixed',
      predicate: 'http://schema.org/related',
      object: 'urn:e:swm-only',
      subGraph: undefined as string | undefined,
      layer: 'shared' as const,
    };
    const mixedMemory = {
      entities: new Map([
        [mixed.uri, mixed],
        [wmNeighbour.uri, wmNeighbour],
      ]),
      entityList: [mixed, wmNeighbour],
      allTriples: [wmEdge, wmType, wmLabel, swmEdge],
      graphTriples: [
        { subject: wmEdge.subject, predicate: wmEdge.predicate, object: wmEdge.object, subGraph: 'demo' },
        { subject: wmType.subject, predicate: wmType.predicate, object: wmType.object, subGraph: 'demo' },
        { subject: wmLabel.subject, predicate: wmLabel.predicate, object: wmLabel.object, subGraph: 'demo' },
        { subject: swmEdge.subject, predicate: swmEdge.predicate, object: swmEdge.object },
      ],
      trustMap: new Map(),
      counts: { wm: 2, swm: 1, vm: 0, total: 2 },
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
            rawMemory: mixedMemory,
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

    // Narrow to WM only by toggling off SWM + VM. The mixed entity has
    // trustLevel === 'shared' so it would be filtered out of
    // `filteredEntities` here — the pre-C18 gate would then drop its WM
    // rdf:type / label triples even though its WM-layer membership is
    // exactly what the narrowed view is asking for.
    const chips = Array.from(container.querySelectorAll('button.v10-minibar-chip')) as HTMLButtonElement[];
    const swmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Shared Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verifiable Memory'));
    expect(swmChip).toBeTruthy();
    expect(vmChip).toBeTruthy();

    await act(async () => { swmChip!.click(); });
    await act(async () => { vmChip!.click(); });

    await waitForGraph(() => {
      const triples = readGraphTriples();
      const hasEdge = triples.some(
        (t) => t.s === 'urn:e:mixed'
          && t.p === 'http://schema.org/knows'
          && t.o === 'urn:e:wm-neighbour-2',
      );
      const hasType = triples.some(
        (t) => t.s === 'urn:e:mixed'
          && t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && t.o === 'http://schema.org/Thing',
      );
      const hasLabel = triples.some(
        (t) => t.s === 'urn:e:mixed'
          && t.p === 'http://schema.org/name'
          && t.o === '"Mixed entity"',
      );
      // The SWM-only edge must NOT appear in the WM-narrowed view.
      const hasSwmEdge = triples.some(
        (t) => t.s === 'urn:e:mixed' && t.p === 'http://schema.org/related',
      );
      expect(hasEdge).toBe(true);
      expect(hasType).toBe(true);
      expect(hasLabel).toBe(true);
      expect(hasSwmEdge).toBe(false);
    });
  });

  // P3 regression: the sub-graph pyramid pill counts must agree with
  // the entity list under them. Pre-P3 the pyramid counted by
  // `entity.layers.has(...)` so a mixed-layer entity (e.g. promoted
  // to SWM with WM residue) was double-counted across two pills,
  // disagreeing with the trustLevel-filtered Entities tab.
  it('pyramid counts match Entities-list trustLevel filter (P3)', async () => {
    // Two entities: one genuinely WM-only, one promoted to SWM (with
    // residual WM-layer presence). With the M6 trustLevel convention
    // the pyramid should read wm=1 / swm=1 (not wm=2 / swm=1).
    const wmOnly = {
      uri: 'urn:e:p3-wm-only',
      label: 'WM-only',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const promoted = {
      uri: 'urn:e:p3-promoted',
      label: 'Promoted',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['working', 'shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const fixture = {
      entities: new Map([[wmOnly.uri, wmOnly], [promoted.uri, promoted]]),
      entityList: [wmOnly, promoted],
      allTriples: [],
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            // Render the Graph tab — the pyramid is in the header so
            // it shows on any tab; this avoids the Entities-tab card
            // render which the fixture's stub `forType: () => undefined`
            // doesn't support.
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    // Chips are buttons with class `v10-minibar-chip`; the count is the
    // `.v10-minibar-count` span. Title prefixes disambiguate them.
    const chips = Array.from(container.querySelectorAll('button.v10-minibar-chip')) as HTMLButtonElement[];
    const countFor = (labelPrefix: string) => {
      const chip = chips.find(b => (b.getAttribute('title') ?? '').startsWith(labelPrefix));
      return Number(chip?.querySelector('.v10-minibar-count')?.textContent ?? 'NaN');
    };
    // Trust convention: WM=1 (the WM-only entity), SWM=1 (the promoted
    // entity, counted in its canonical layer only), VM=0. Pre-P3 this
    // would have been WM=2 / SWM=1 / VM=0.
    expect(countFor('Working Memory')).toBe(1);
    expect(countFor('Shared Memory')).toBe(1);
    expect(countFor('Verifiable Memory')).toBe(0);
  });

  // R3 regression: `splitGraphTriplesForShelf` normalises subjects /
  // objects via `graphNodeKey` but used to compare the *raw* predicate
  // against RDF_TYPE_URI. A wrapped `<rdf:type>` predicate slipped past
  // the type-skip, inflated the subject's degree (it no longer
  // qualified as a singleton), and the type triple was kept on the
  // canvas where its class IRI rendered as a phantom connected node.
  // R6 (defensive) additionally filters canvas triples whose object
  // is on the shelf, so a single-type-triple subject lands cleanly on
  // the shelf instead of staying half on canvas.
  it('skips wrapped <rdf:type> predicates so a type-only subject shelves cleanly', async () => {
    const subject = {
      uri: 'urn:e:r3-subject',
      label: 'R3 subject',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const wrappedTypeTriple = {
      // Predicate arrives wrapped — the daemon sometimes hands triples
      // back with angle-bracketed IRIs (e.g. when CONSTRUCT bindings come
      // out of certain views). The pre-R3 code compared this verbatim
      // against the unwrapped RDF_TYPE_URI constant and missed.
      subject: 'urn:e:r3-subject',
      predicate: '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>',
      object: 'http://schema.org/Thing',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const phantomMemory = {
      entities: new Map([[subject.uri, subject]]),
      entityList: [subject],
      allTriples: [wrappedTypeTriple],
      graphTriples: [
        { subject: wrappedTypeTriple.subject, predicate: wrappedTypeTriple.predicate, object: wrappedTypeTriple.object, subGraph: 'demo' },
      ],
      trustMap: new Map(),
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
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
            rawMemory: phantomMemory,
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

    // With R3 the wrapped type predicate is recognised → the subject
    // has degree 0 → it becomes a singleton → R6 then drops the type
    // triple from canvas (its subject is on the shelf). The class IRI
    // therefore never enters the rendered triple set. The subject
    // surfaces as a singleton-shelf chip instead.
    await waitForGraph(() => {
      const triples = readGraphTriples();
      const classIriOnCanvas = triples.some((t) => t.o === 'http://schema.org/Thing');
      expect(classIriOnCanvas).toBe(false);
      // Shelf chip for the type-only subject is the expected residue.
      const shelfChip = container.querySelector(
        '.v10-graph-singleton-item[title="urn:e:r3-subject"]',
      );
      expect(shelfChip).toBeTruthy();
    });
  });

  // Issue C regression: SubGraphDetailView Graph tab silently dropped
  // scoped entities whose triples don't pass the `scopedTriples` filter
  // (e.g. promoted SWM entities whose triples live in `_shared_memory`
  // and have no `subGraph` tag — and whose object-side endpoints aren't
  // in `scopedUris` either). Those entities exist in `scopedEntities`
  // (via WM-era slug membership) but their triples never reach
  // `splitGraphTriplesForShelf`, so they never enter `subjects`, never
  // become singletons, and disappear from the Graph view entirely.
  // Fix: `LayerGraphPanel` accepts a `scopeEntities` prop and unions
  // entities not on canvas + not already shelved into the shelf.
  it('shows scope entities with no rendered triples on the singleton shelf (Issue C)', async () => {
    // A "ghost" entity — in the sub-graph's scope (via WM-era
    // subGraphs.has('demo')) but its only triples are in SWM
    // `_shared_memory` (subGraph undefined) with literal/class-IRI
    // objects, so the sub-graph scope filter drops them all.
    const ghost = {
      uri: 'urn:e:ghost',
      label: 'Ghost Entity',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    // A regular entity with a triple in the sub-graph so the Graph
    // view isn't completely empty.
    const visible = {
      uri: 'urn:e:visible',
      label: 'Visible',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const visibleType = {
      subject: 'urn:e:visible',
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://schema.org/Thing',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const ghostMemory = {
      entities: new Map([[ghost.uri, ghost], [visible.uri, visible]]),
      entityList: [ghost, visible],
      // No triples for `ghost` in this set — that's the whole point.
      allTriples: [visibleType],
      graphTriples: [
        { subject: visibleType.subject, predicate: visibleType.predicate, object: visibleType.object, subGraph: 'demo' },
      ],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
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
            rawMemory: ghostMemory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    // The ghost entity must surface on the singleton shelf — without
    // the Issue C fix it disappeared silently. Title attribute on
    // each shelf chip holds the URI.
    await waitForGraph(() => {
      const ghostChip = container.querySelector(
        '.v10-graph-singleton-item[title="urn:e:ghost"]',
      );
      expect(ghostChip).toBeTruthy();
    });
  });

  // S3 — Root bucket (synthesized `__root__` slug). Scope is "no
  // sub-graph membership" — entity.subGraphs.size === 0. The detail
  // body shape matches a named subgraph (header / count strip /
  // tabs); only the chrome (icon ⊘ / title "Root") and scope
  // predicate differ.
  it('renders the Root bucket (slug=ROOT_SLUG_SENTINEL) with the no-membership scope', async () => {
    const rootEntity = {
      uri: 'urn:e:rooted',
      label: 'Rooted',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    const namedEntity = {
      uri: 'urn:e:in-named',
      label: 'In named subgraph',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['recipes']),
      properties: new Map(),
      connections: [],
    };
    const memory = {
      entities: new Map([[rootEntity.uri, rootEntity], [namedEntity.uri, namedEntity]]),
      entityList: [rootEntity, namedEntity],
      allTriples: [],
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
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
            slug: ROOT_SLUG_SENTINEL,
            rawMemory: memory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'items',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    // Header carries the Root identity (locked literals from §4.4.1).
    expect(container.querySelector('.v10-subgraph-detail-title')?.textContent).toBe('Root');
    // Cross-layer count strip exists and reports the root-scoped
    // entity at WM only — `namedEntity` (recipes-scoped) must not
    // count toward Root.
    const strip = container.querySelector('[data-testid="cross-layer-strip"]');
    expect(strip).toBeTruthy();
    const cells = strip!.querySelectorAll('.v10-subgraph-cross-layer-cell-count');
    expect(cells[0]?.textContent).toBe('1'); // wm — rootEntity
    expect(cells[1]?.textContent).toBe('0'); // swm — namedEntity excluded
    expect(cells[2]?.textContent).toBe('0'); // vm

    // The Entities tab must show the root-scoped entity only.
    const entityCards = container.querySelectorAll('.v10-entity-card');
    expect(entityCards.length).toBe(1);
    expect(entityCards[0]?.textContent).toContain('Rooted');
  });

  // S3 — cross-layer count strip + active-layer chip pill (UX §4.4.1).
  // The pill must be visible whenever scope is narrower than "all
  // three", and clicking it must reset to All layers.
  it('renders the active-layer pill and resets to "All layers" on click', async () => {
    const wmOnly = {
      uri: 'urn:e:wm', label: 'WM only', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const swmOnly = {
      uri: 'urn:e:swm', label: 'SWM only', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const fixture = {
      entities: new Map([[wmOnly.uri, wmOnly], [swmOnly.uri, swmOnly]]),
      entityList: [wmOnly, swmOnly],
      allTriples: [],
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    const pill = container.querySelector('[data-testid="active-layer-pill"]') as HTMLButtonElement | null;
    expect(pill).toBeTruthy();
    // Default: all three layers — pill reads "All layers" and is disabled.
    expect(pill!.textContent).toContain('All layers');
    expect(pill!.disabled).toBe(true);

    // Narrow to WM only via the mini-pyramid chips.
    const chips = Array.from(container.querySelectorAll('button.v10-minibar-chip')) as HTMLButtonElement[];
    const swmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Shared Memory'));
    const vmChip = chips.find(b => (b.getAttribute('title') ?? '').startsWith('Verifiable Memory'));
    await act(async () => { swmChip!.click(); });
    await act(async () => { vmChip!.click(); });
    await flush();

    // Pill now surfaces the narrowed scope and becomes clickable.
    expect(pill!.textContent).toContain('Working Memory');
    expect(pill!.disabled).toBe(false);

    // Clicking resets to all layers.
    await act(async () => { pill!.click(); });
    await flush();
    expect(pill!.textContent).toContain('All layers');
    expect(pill!.disabled).toBe(true);
  });

  // S3 fold-in #6 (PR #677 follow-up). Multi-layer sub-graph Graph
  // tab paints per-entity by `trustLevel` via `nodeColorsOverride`,
  // not the WM-default fallback. Pre-fix every node painted gray.
  it('passes per-URI trust nodeColors to the Graph pane on a multi-layer subgraph', async () => {
    const wmEntity = {
      uri: 'urn:e:wm-node', label: 'WM node', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const swmEntity = {
      uri: 'urn:e:swm-node', label: 'SWM node', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const vmEntity = {
      uri: 'urn:e:vm-node', label: 'VM node', types: [],
      trustLevel: 'verified',
      layers: new Set(['verified']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const edgeAB = {
      subject: 'urn:e:wm-node',
      predicate: 'urn:rel:r',
      object: 'urn:e:swm-node',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const fixture = {
      entities: new Map([
        [wmEntity.uri, wmEntity],
        [swmEntity.uri, swmEntity],
        [vmEntity.uri, vmEntity],
      ]),
      entityList: [wmEntity, swmEntity, vmEntity],
      allTriples: [edgeAB],
      graphTriples: [
        { subject: edgeAB.subject, predicate: edgeAB.predicate, object: edgeAB.object, subGraph: 'demo' },
      ],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 1, total: 3 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    await waitForGraph(() => {
      const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      const colors = JSON.parse(el!.getAttribute('data-node-colors') ?? '{}');
      // Each entity URI keyed to its TRUST_COLORS palette value —
      // canonical hex, NOT a `var(--text-*)` lookup (the canvas
      // pipeline reads raw color strings).
      expect(colors['urn:e:wm-node']).toBe(TRUST_COLORS.working);
      expect(colors['urn:e:swm-node']).toBe(TRUST_COLORS.shared);
      expect(colors['urn:e:vm-node']).toBe(TRUST_COLORS.verified);
    });
  });

  // S3 — per-row trust badge keyed to e.trustLevel (not the fixed
  // `layerKey` SubGraphDetailView passes to EntityList). Pre-fix
  // every row read "Working" even on SWM/VM entities.
  it('renders the per-row trust badge from entity.trustLevel on the Entities tab', async () => {
    const wmRow = {
      uri: 'urn:e:wm-row', label: 'WM row', types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const swmRow = {
      uri: 'urn:e:swm-row', label: 'SWM row', types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const vmRow = {
      uri: 'urn:e:vm-row', label: 'VM row', types: ['http://schema.org/Thing'],
      trustLevel: 'verified',
      layers: new Set(['verified']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const fixture = {
      entities: new Map([
        [wmRow.uri, wmRow], [swmRow.uri, swmRow], [vmRow.uri, vmRow],
      ]),
      entityList: [wmRow, swmRow, vmRow],
      allTriples: [],
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 1, total: 3 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'items',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    // Each row carries its OWN trust-level badge — class is keyed
    // by layer (`.wm` / `.swm` / `.vm`), text is the trust label.
    const cards = Array.from(container.querySelectorAll('.v10-entity-card')) as HTMLElement[];
    const byLabel = new Map<string, HTMLElement>();
    for (const card of cards) {
      const label = card.querySelector('.v10-entity-card-title')?.textContent ?? '';
      byLabel.set(label, card);
    }
    expect(byLabel.get('WM row')?.querySelector('.v10-trust-badge.wm')?.textContent).toContain('Working');
    expect(byLabel.get('SWM row')?.querySelector('.v10-trust-badge.swm')?.textContent).toContain('Shared');
    expect(byLabel.get('VM row')?.querySelector('.v10-trust-badge.vm')?.textContent).toContain('Verifiable');
  });

  // S3 fold-in #7 — multi-layer `scopedTriples` predicate admits
  // edges whose `subGraph` tag was erased on promotion. Pre-fix
  // (`subGraph === slug || (scopedUris.has(s) && scopedUris.has(o))`)
  // the both-ends test ALREADY caught this specific case, but the
  // subject-scoped rule extends admission to edges where the object
  // is in scope but the subject's `subGraph` tag is missing. The
  // post-fix predicate keeps the both-ends and adds the asymmetric
  // recovery so promoted SWM/VM endpoints don't silently drop out
  // of the multi-layer Graph view.
  it('admits cross-layer edges whose subGraph tag was erased on promotion (fold-in #7)', async () => {
    // Two entities both scoped to `demo`. One is WM-only, the other
    // was promoted to SWM and its triples lost their `subGraph`
    // origin tag on promotion. The edge has `subGraph: undefined`.
    const wmEnd = {
      uri: 'urn:e:wm-end', label: 'WM endpoint',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const swmEnd = {
      uri: 'urn:e:swm-end', label: 'SWM endpoint',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const promotedEdge = {
      subject: 'urn:e:swm-end',
      predicate: 'http://schema.org/relatesTo',
      object: 'urn:e:wm-end',
      subGraph: undefined as string | undefined,
      layer: 'shared' as const,
    };
    const fixture = {
      entities: new Map([
        [wmEnd.uri, wmEnd], [swmEnd.uri, swmEnd],
      ]),
      entityList: [wmEnd, swmEnd],
      allTriples: [promotedEdge],
      graphTriples: [
        { subject: promotedEdge.subject, predicate: promotedEdge.predicate, object: promotedEdge.object },
      ],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    await waitForGraph(() => {
      const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      const triples = JSON.parse(el!.getAttribute('data-triples') ?? '[]');
      const hasEdge = triples.some(
        (t: { s: string; p: string; o: string }) =>
          t.s === 'urn:e:swm-end'
          && t.p === 'http://schema.org/relatesTo'
          && t.o === 'urn:e:wm-end',
      );
      expect(hasEdge).toBe(true);
    });
  });

  // S3 Codex follow-up (Bug A on PR #772). The fold-in #7 recovery
  // branch must NOT admit triples that carry an explicit non-matching
  // `subGraph` tag — those belong to the tagged slug's view, even
  // when an endpoint happens to be in the current scope (an entity
  // in multiple sub-graphs is shared territory, not a broadcast).
  // Exact-tag-routing wins; the recovery branch is for `subGraph`
  // erased by promotion only.
  it('does NOT admit a triple with an explicit non-matching subGraph tag even when an endpoint is in scope', async () => {
    // `cross` belongs to BOTH `demo` (current view) and `other`. A
    // triple tagged `subGraph: 'other'` whose subject is `cross`
    // must NOT leak into the `demo` view.
    const cross = {
      uri: 'urn:e:cross', label: 'Cross-membership entity',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo', 'other']),
      properties: new Map(),
      connections: [],
    };
    const demoOnly = {
      uri: 'urn:e:demo-only', label: 'Demo-only entity',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    };
    const demoEdge = {
      subject: 'urn:e:demo-only',
      predicate: 'http://schema.org/knows',
      object: 'urn:e:cross',
      subGraph: 'demo',
      layer: 'working' as const,
    };
    const otherEdge = {
      subject: 'urn:e:cross',
      predicate: 'http://schema.org/knows',
      object: 'urn:e:demo-only',
      subGraph: 'other',
      layer: 'working' as const,
    };
    const fixture = {
      entities: new Map([[cross.uri, cross], [demoOnly.uri, demoOnly]]),
      entityList: [cross, demoOnly],
      allTriples: [demoEdge, otherEdge],
      graphTriples: [
        { subject: demoEdge.subject, predicate: demoEdge.predicate, object: demoEdge.object, subGraph: 'demo' },
        { subject: otherEdge.subject, predicate: otherEdge.predicate, object: otherEdge.object, subGraph: 'other' },
      ],
      trustMap: new Map(),
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    await waitForGraph(() => {
      const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      const triples = JSON.parse(el!.getAttribute('data-triples') ?? '[]');
      // The `demo`-tagged edge is admitted via exact-tag routing.
      const hasDemoEdge = triples.some(
        (t: { s: string; p: string; o: string }) =>
          t.s === 'urn:e:demo-only' && t.p === 'http://schema.org/knows' && t.o === 'urn:e:cross',
      );
      // The `other`-tagged edge must NOT leak in — even though its
      // subject (`cross`) is in the `demo` scope. Pre-fix the
      // subject-scoped fallback admitted it.
      const hasOtherEdge = triples.some(
        (t: { s: string; p: string; o: string }) =>
          t.s === 'urn:e:cross' && t.p === 'http://schema.org/knows' && t.o === 'urn:e:demo-only',
      );
      expect(hasDemoEdge).toBe(true);
      expect(hasOtherEdge).toBe(false);
    });
  });

  // S3 Codex follow-up (Bug A on PR #772 — Root branch). Root scope
  // is "root-bucket entities + root-bucket edges". A `recipes`-tagged
  // edge whose object happens to be a root entity must NOT show up
  // in the Root view — that edge belongs to the `recipes` view.
  it('Root scope rejects named-subgraph edges that merely point at a root entity', async () => {
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root entity',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    const recipeEntity = {
      uri: 'urn:e:in-recipes', label: 'In recipes',
      types: ['http://schema.org/Thing'],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['recipes']),
      properties: new Map(),
      connections: [],
    };
    const recipesEdge = {
      subject: 'urn:e:in-recipes',
      predicate: 'http://schema.org/about',
      object: 'urn:e:root',
      subGraph: 'recipes',
      layer: 'working' as const,
    };
    const fixture = {
      entities: new Map([[rootEntity.uri, rootEntity], [recipeEntity.uri, recipeEntity]]),
      entityList: [rootEntity, recipeEntity],
      allTriples: [recipesEdge],
      graphTriples: [
        { subject: recipesEdge.subject, predicate: recipesEdge.predicate, object: recipesEdge.object, subGraph: 'recipes' },
      ],
      trustMap: new Map(),
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
      refresh: vi.fn(),
    } as any;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphDetailView, {
            slug: ROOT_SLUG_SENTINEL,
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });

    // The rejected edge means scopedTriples for Root is empty, so
    // the canvas falls through to the placeholder. We assert two
    // things: (1) RdfGraph never received the recipes-tagged
    // triple (it didn't render at all OR rendered without it),
    // and (2) the root entity surfaces on the singleton shelf
    // instead — the entity is in scope even though no admissible
    // triple references it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
    if (el) {
      const triples = JSON.parse(el.getAttribute('data-triples') ?? '[]');
      const hasRecipesEdge = triples.some(
        (t: { s: string; p: string; o: string }) =>
          t.s === 'urn:e:in-recipes' && t.o === 'urn:e:root',
      );
      expect(hasRecipesEdge).toBe(false);
    } else {
      // No canvas at all — even better, since canvasTriples was
      // empty (the recipes edge was rightly rejected and nothing
      // else admitted).
      const placeholder = container.querySelector('.v10-graph-placeholder-centered');
      expect(placeholder).toBeTruthy();
    }
    // The root entity surfaces on the singleton shelf via the
    // scopeEntities fallback — it's in scope but has no
    // admissible triple to anchor it on canvas.
    const rootShelfChip = container.querySelector('.v10-graph-singleton-item[title="urn:e:root"]');
    expect(rootShelfChip).toBeTruthy();
  });

  // S3 polish #10b — the detail-view header used to render a
  // duplicate "No data" badge in its top-right corner whenever the
  // sub-graph had no entities to populate the MiniLayerBar with.
  // The fix passes `compact={true}` so the empty branch returns
  // null. No badge on either the empty-named or empty-Root case.
  it('does NOT render a "No data" header badge when the sub-graph is empty', async () => {
    const empty = {
      entities: new Map(),
      entityList: [],
      allTriples: [],
      graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 0, swm: 0, vm: 0, total: 0 },
      loading: false, error: null, partial: false,
      refresh: vi.fn(),
    } as any;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphDetailView, {
            slug: 'team-notes',
            rawMemory: empty,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    // The detail header wraps a MiniLayerBar in compact mode. The
    // compact-empty branch returns null, so the `.v10-minibar`
    // element should be absent.
    const header = container.querySelector('.v10-subgraph-detail-header');
    expect(header).toBeTruthy();
    expect(header!.querySelector('.v10-minibar')).toBeNull();
    // The card-body / detail-body fallback path must NOT carry
    // the legacy "No data" copy either.
    expect(container.textContent).not.toContain('No data\n');
  });

  // S3 polish #6 — cross-layer strip cells are interactive
  // buttons wired to `toggleLayer`. Pre-polish they were inert
  // span elements; the user had to use the (smaller) header
  // MiniLayerBar chips to narrow the layer scope. Same handler,
  // same "refuse last enabled" safeguard, broader hit target.
  it('toggles a layer when the WM cross-layer cell is clicked', async () => {
    const wmOnly = {
      uri: 'urn:e:wm', label: 'WM', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const swmOnly = {
      uri: 'urn:e:swm', label: 'SWM', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const fixture = {
      entities: new Map([[wmOnly.uri, wmOnly], [swmOnly.uri, swmOnly]]),
      entityList: [wmOnly, swmOnly],
      allTriples: [], graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'items',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    function cellFor(layer: 'wm' | 'swm' | 'vm'): HTMLButtonElement {
      const el = container.querySelector(`button.v10-subgraph-cross-layer-cell[data-layer="${layer}"]`);
      if (!el) throw new Error(`Missing cell for ${layer}`);
      return el as HTMLButtonElement;
    }

    // Default: all three layers enabled — every cell is pressed.
    expect(cellFor('wm').getAttribute('aria-pressed')).toBe('true');
    expect(cellFor('swm').getAttribute('aria-pressed')).toBe('true');
    expect(cellFor('vm').getAttribute('aria-pressed')).toBe('true');

    // Click the WM cell — narrows scope to {swm, vm}.
    await act(async () => { cellFor('wm').click(); });
    await flush();
    expect(cellFor('wm').getAttribute('aria-pressed')).toBe('false');
    expect(cellFor('swm').getAttribute('aria-pressed')).toBe('true');
    expect(cellFor('vm').getAttribute('aria-pressed')).toBe('true');

    // Click WM again — re-adds it.
    await act(async () => { cellFor('wm').click(); });
    await flush();
    expect(cellFor('wm').getAttribute('aria-pressed')).toBe('true');
  });

  it('does NOT allow the last-enabled cell to be toggled off (safeguard inherited from toggleLayer)', async () => {
    const wmOnly = {
      uri: 'urn:e:wm', label: 'WM', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const fixture = {
      entities: new Map([[wmOnly.uri, wmOnly]]),
      entityList: [wmOnly],
      allTriples: [], graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'items',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    function cellFor(layer: 'wm' | 'swm' | 'vm'): HTMLButtonElement {
      return container.querySelector(`button.v10-subgraph-cross-layer-cell[data-layer="${layer}"]`) as HTMLButtonElement;
    }

    // Narrow down to WM only.
    await act(async () => { cellFor('swm').click(); });
    await act(async () => { cellFor('vm').click(); });
    await flush();
    expect(cellFor('wm').getAttribute('aria-pressed')).toBe('true');
    expect(cellFor('swm').getAttribute('aria-pressed')).toBe('false');
    expect(cellFor('vm').getAttribute('aria-pressed')).toBe('false');

    // Clicking WM (the last enabled) MUST NOT disable it.
    await act(async () => { cellFor('wm').click(); });
    await flush();
    expect(cellFor('wm').getAttribute('aria-pressed')).toBe('true');
  });

  // S3 polish #8 — SWM-attribution discoverability. When the
  // Graph pane has narrowed to SWM-only the existing
  // SwmAttributionLegend explains the coloring rule, but there's
  // no explicit "this canvas is currently colored by agent" cue
  // above the graph. Add an inline badge that surfaces alongside
  // the legend so the rule isn't buried in the side rail.
  it('renders the "Colored by contributing agent" badge when narrowed to SWM-only on the Graph tab', async () => {
    const swmOnly = {
      uri: 'urn:e:swm', label: 'SWM', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const wmOnly = {
      uri: 'urn:e:wm', label: 'WM', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const fixture = {
      entities: new Map([[swmOnly.uri, swmOnly], [wmOnly.uri, wmOnly]]),
      entityList: [swmOnly, wmOnly],
      allTriples: [], graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    // Baseline (all three enabled) — no badge.
    expect(container.querySelector('[data-testid="swm-attribution-badge"]')).toBeNull();

    // Narrow to SWM-only via the cross-layer cells.
    function cellFor(layer: 'wm' | 'swm' | 'vm'): HTMLButtonElement {
      return container.querySelector(`button.v10-subgraph-cross-layer-cell[data-layer="${layer}"]`) as HTMLButtonElement;
    }
    await act(async () => { cellFor('wm').click(); });
    await act(async () => { cellFor('vm').click(); });
    await flush();

    const badge = container.querySelector('[data-testid="swm-attribution-badge"]');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toContain('Colored by contributing agent');
    // The SWM cell carries the context-sensitive tooltip per #8 (c).
    expect(cellFor('swm').getAttribute('title')).toContain('colored by contributing agent');
  });

  it('does NOT render the SWM-attribution badge when WM is the only enabled layer', async () => {
    const wmOnly = {
      uri: 'urn:e:wm', label: 'WM', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(), connections: [],
    };
    const fixture = {
      entities: new Map([[wmOnly.uri, wmOnly]]),
      entityList: [wmOnly],
      allTriples: [], graphTriples: [],
      trustMap: new Map(),
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
      loading: false, error: null, partial: false,
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
            rawMemory: fixture,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            activeTab: 'graph',
            onTabChange: vi.fn(),
          })),
      );
    });
    await flush();

    function cellFor(layer: 'wm' | 'swm' | 'vm'): HTMLButtonElement {
      return container.querySelector(`button.v10-subgraph-cross-layer-cell[data-layer="${layer}"]`) as HTMLButtonElement;
    }
    await act(async () => { cellFor('swm').click(); });
    await act(async () => { cellFor('vm').click(); });
    await flush();

    // singleLayer === 'wm' — badge should NOT render.
    expect(container.querySelector('[data-testid="swm-attribution-badge"]')).toBeNull();
    // SWM cell carries no SWM-attribution tooltip in this state.
    expect(cellFor('swm').getAttribute('title')).toBeNull();
  });
});
