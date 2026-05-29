// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// fetchSubGraphs is the daemon-backed source that Issue G's fix
// gates on. Default mock resolves with empty cards (the
// success-empty branch); individual tests override per-call.
const fetchSubGraphsMock = vi.fn();

vi.mock('../src/ui/api.js', () => ({
  fetchSubGraphs: (...args: any[]) => fetchSubGraphsMock(...args),
  executeQuery: vi.fn(async () => ({ result: { bindings: [] } })),
}));

// The grid renders mini RdfGraphs per card; the lazy import would
// otherwise stall the test. Stub it out — only the empty/error
// branches matter for this file.
vi.mock('@origintrail-official/dkg-graph-viz/react', async () => {
  const React = await import('react');
  return {
    RdfGraph(props: {
      data?: ReadonlyArray<{ subject: string; predicate: string; object: string }>;
      options?: { style?: { nodeColors?: Record<string, string> } };
    }) {
      // Surface the nodeColors style override so #3 polish tests
      // can assert per-URI trust-color plumbing without reaching
      // into the canvas internals.
      const nodeColors = props.options?.style?.nodeColors ?? {};
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-node-colors': JSON.stringify(nodeColors),
      });
    },
  };
});

import { SubGraphOverviewGrid } from '../src/ui/views/project/components.js';
import { TRUST_COLORS } from '../src/ui/views/project/helpers.js';

const profile: ProjectProfile = {
  contextGraphId: 'cg-test',
  displayName: 'Test',
  primaryColor: '#64748b',
  accentColor: '#38bdf8',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: (slug: string) => ({ slug, displayName: slug, color: '#38bdf8', icon: '#', rank: 0 }),
  forType: () => ({}) as any,
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

const memory = {
  entities: new Map(),
  entityList: [],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 0, swm: 0, vm: 0, total: 0 },
  loading: false,
  error: null,
  partial: false,
  layerStatus: { wm: 'ok' as const, swm: 'ok' as const, vm: 'ok' as const },
  refresh: vi.fn(),
} as any;

async function flush(): Promise<void> {
  // Two microtask drains — one for the promise the effect kicks
  // off, one for the setState in the resolver/finally.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('SubGraphOverviewGrid — fetch failure state (S3 Codex sweep 3 Issue G)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSubGraphsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    return act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  // Issue G load-bearing case: a transient `fetchSubGraphs` error
  // used to render the success-empty teaching state ("No subgraphs
  // in this Context Graph yet" + View root CTA) because the catch
  // was silent. That's authoritative-looking but wrong — the user
  // doesn't know yet whether the CG has sub-graphs or not. The new
  // error branch shows a distinct "Couldn't load subgraphs" state.
  it('renders the error state — NOT the teaching empty — when fetchSubGraphs rejects', async () => {
    fetchSubGraphsMock.mockRejectedValueOnce(new Error('network timeout'));
    await render();
    await flush();

    const empty = container.querySelector('.v10-empty-state');
    expect(empty).toBeTruthy();
    const title = empty!.querySelector('.v10-empty-state-title')?.textContent ?? '';
    expect(title).toBe("Couldn't load subgraphs.");
    // Must NOT be the success-empty teaching copy.
    expect(title).not.toContain('No subgraphs in this Context Graph yet');
    // Must NOT show the View root CTA (the user has no way of
    // knowing whether root is the right place to look until the
    // sub-graph list actually loads).
    const action = empty!.querySelector('.v10-empty-state-action');
    expect(action).toBeNull();
    // Error tone for the data-tone attribute / styling consumers.
    expect(empty!.getAttribute('data-tone')).toBe('danger');
  });

  // Regression guard for the other direction — the new error branch
  // must NOT swallow the success-empty teaching state when the
  // daemon legitimately returns an empty list.
  it('still renders the teaching empty state when fetchSubGraphs resolves with []', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({ subGraphs: [] });
    await render();
    await flush();

    const empty = container.querySelector('.v10-empty-state');
    expect(empty).toBeTruthy();
    const title = empty!.querySelector('.v10-empty-state-title')?.textContent ?? '';
    expect(title).toBe('No subgraphs in this Context Graph yet.');
    // The teaching state offers the View root action.
    const action = empty!.querySelector('.v10-empty-state-action');
    expect(action).toBeTruthy();
    expect(action!.textContent).toContain('View root');
    // Neutral tone, not danger.
    expect(empty!.getAttribute('data-tone')).toBe('neutral');
  });
});

describe('SubGraphMiniCard — empty-card-body two-branch copy (S3 polish #2, ux-locked)', () => {
  // The card-body fallback is rendered when card.triples.length === 0.
  // Two branches the user can land on:
  //   `entityCount === 0` (sub-graph has nothing yet) → "No data yet"
  //   `entityCount > 0`  (sub-graph has SWM/VM entities promoted out of
  //                       the WM origin and no WM triples this card can
  //                       render) → "Promoted — open to view"
  // The previous power-user copy ("No WM triples · promoted data only")
  // assumed familiarity with WM/SWM mechanics the typical user doesn't
  // share. Pair the new literal with the existing ↗ open button so the
  // implied action is obvious.
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSubGraphsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(memoryOverride: any) {
    return act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory: memoryOverride,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  it('renders "No data yet" on a sub-graph with no entities and no triples (entityCount === 0)', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'team-notes', entityCount: 0, tripleCount: 0, description: '' }],
    });
    // memory.entityList is also empty — entityUrisBySubGraph yields
    // an empty Set, so `cardEntityUris.size === 0` falls back to the
    // server entityCount of 0 → "No data yet" branch.
    await renderWith({ ...memory, entityList: [], allTriples: [] });
    await flush();

    const cardEmpty = container.querySelector('.v10-sgov-card-empty');
    expect(cardEmpty).toBeTruthy();
    expect(cardEmpty!.textContent).toContain('No data yet');
    // The other branch must NOT also fire.
    expect(cardEmpty!.textContent).not.toContain('Promoted — open to view');
  });

  it('renders "Promoted — open to view" when the sub-graph has entities but no WM triples', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'team-notes', entityCount: 3, tripleCount: 0, description: '' }],
    });
    // Entities scoped to `team-notes` exist (canonical entityList view
    // — cardEntityUris.size > 0), but no triples carry the sub-graph
    // origin tag, so card.triples is empty → "Promoted" branch.
    const promotedEntity = {
      uri: 'urn:e:promoted',
      label: 'Promoted',
      types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['team-notes']),
      properties: new Map(),
      connections: [],
    };
    await renderWith({
      ...memory,
      entityList: [promotedEntity],
      entities: new Map([[promotedEntity.uri, promotedEntity]]),
      allTriples: [],
    });
    await flush();

    const cardEmpty = container.querySelector('.v10-sgov-card-empty');
    expect(cardEmpty).toBeTruthy();
    expect(cardEmpty!.textContent).toContain('Promoted — open to view');
    expect(cardEmpty!.textContent).not.toContain('No data yet');
    expect(cardEmpty!.textContent).not.toContain('No WM triples');
  });

  // #2 / #10b — the duplicate "No data" label that appeared next to
  // the card-body fallback came from MiniLayerBar's own non-compact
  // empty branch. Pass `compact={true}` and that branch returns null.
  it('does NOT render a duplicate "No data" pyramid label on an empty card', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'team-notes', entityCount: 0, tripleCount: 0, description: '' }],
    });
    await renderWith({ ...memory, entityList: [], allTriples: [] });
    await flush();

    // The pyramid wrapper exists but MiniLayerBar in compact mode
    // returns null when total === 0, so the legend strip is empty.
    const pyramid = container.querySelector('.v10-sgov-card-pyramid');
    expect(pyramid).toBeTruthy();
    expect(pyramid!.querySelector('.v10-minibar')).toBeNull();
    // Only the card-body literal remains.
    const cardBody = container.querySelector('.v10-sgov-card-empty');
    expect(cardBody?.textContent).toBe('No data yet');
  });
});

describe('SubGraphOverviewGrid — header subtitle anchors (PR #793 round 4.1, GH #812)', () => {
  // Round 4.1 (ux-lead) — the subtitle now reads from the canonical
  // hook surfaces (`memory.counts.total` for entities,
  // `memory.allTriples.length` for triples) so it agrees with the
  // SubGraphBar `All` chip by construction. Pre-round-4.1 the
  // subtitle derived from card-level aggregates and either
  // double-counted cross-membership entities (round-4-prior
  // sum-of-`entityCount`) or excluded the root bucket. The tests
  // below lock the new anchor: a fixture where the hook total
  // disagrees with the card sum must render the hook total in the
  // subtitle.
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSubGraphsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(memoryOverride: any) {
    return act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory: memoryOverride,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  it('renders the subtitle entity count from memory.counts.total and triple count from memory.allTriples.length', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [
        { name: 'alpha', entityCount: 2, tripleCount: 5, description: '' },
        { name: 'beta', entityCount: 2, tripleCount: 7, description: '' },
      ],
    });
    const triples = [
      // alpha sub-graph triples
      { subject: 'urn:e:a1', predicate: 'p', object: 'o1', subGraph: 'alpha' },
      { subject: 'urn:e:a2', predicate: 'p', object: 'o2', subGraph: 'alpha' },
      // beta sub-graph triples
      { subject: 'urn:e:b1', predicate: 'p', object: 'o3', subGraph: 'beta' },
      { subject: 'urn:e:b2', predicate: 'p', object: 'o4', subGraph: 'beta' },
      // a root-bucket triple (no sub-graph origin) — counted by the
      // hook total but never reaches a card aggregate.
      { subject: 'urn:e:root', predicate: 'p', object: 'o5' },
    ];
    const entityList = [
      { uri: 'urn:e:a1', label: 'a1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:a2', label: 'a2', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:b1', label: 'b1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['beta']), properties: new Map(), connections: [] },
      { uri: 'urn:e:b2', label: 'b2', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['beta']), properties: new Map(), connections: [] },
      // A root-bucket entity with no sub-graph membership — would
      // be missing from any card-derived count.
      { uri: 'urn:e:root', label: 'root', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 5, swm: 0, vm: 0, total: 5 },
    });
    await flush();

    const sub = container.querySelector('.v10-sgov-sub');
    expect(sub).toBeTruthy();
    expect(sub!.textContent).toContain('2 subgraphs');
    expect(sub!.textContent).toContain('5 entities');
    expect(sub!.textContent).toContain('5 triples');
  });

  it('subtitle uses memory.counts.total even when it disagrees with sum-of-card entityCount (cross-membership regression)', async () => {
    // Fixture mirrors the §4.4.1 reversal scenario:
    //   - One entity belongs to BOTH 'alpha' AND 'beta'.
    //   - card[alpha].entityCount === 2 (alpha-only + cross)
    //   - card[beta].entityCount  === 2 (beta-only + cross)
    //   - sum-of-cards            === 4 (double-counts the cross entity)
    //   - memory.counts.total      === 3 (distinct entities)
    // Round 4.1 lock: the subtitle reads memory.counts.total (3),
    // NOT the sum-of-cards (4). Same logic for triples — the hook
    // total wins.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [
        { name: 'alpha', entityCount: 2, tripleCount: 3, description: '' },
        { name: 'beta', entityCount: 2, tripleCount: 3, description: '' },
      ],
    });
    const entityList = [
      { uri: 'urn:e:alpha-only', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:beta-only', label: 'b', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['beta']), properties: new Map(), connections: [] },
      { uri: 'urn:e:cross', label: 'c', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha', 'beta']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // 4 raw triple rows even though the cross-graph SPO duplicate
      // means distinct triples are fewer — exactly the GH #805
      // family the subtitle now defers to.
      { subject: 'urn:e:alpha-only', predicate: 'p', object: 'o', subGraph: 'alpha' },
      { subject: 'urn:e:beta-only', predicate: 'p', object: 'o', subGraph: 'beta' },
      { subject: 'urn:e:cross', predicate: 'p', object: 'o', subGraph: 'alpha' },
      { subject: 'urn:e:cross', predicate: 'p', object: 'o', subGraph: 'beta' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 3, swm: 0, vm: 0, total: 3 },
    });
    await flush();

    const sub = container.querySelector('.v10-sgov-sub');
    expect(sub).toBeTruthy();
    // Subtitle anchors to hook total (3), NOT sum-of-cards (4).
    expect(sub!.textContent).toContain('3 entities');
    expect(sub!.textContent).not.toContain('4 entities');
    // Subtitle anchors to allTriples.length (4), matching what the
    // SubGraphBar `All` chip tooltip surfaces.
    expect(sub!.textContent).toContain('4 triples');
  });
});

describe('SubGraphMiniCard — per-trust nodeColors (S3 polish #3, ui-locked priority chain)', () => {
  // The mini-graph previously rendered every node in the card's
  // chrome color (`card.color`), losing the trust signal that the
  // detail-view Graph pane already preserves. Build a per-URI
  // `nodeColors` override from TRUST_COLORS[trustLevel] so each
  // mini-graph reads the same per-trust palette the detail view
  // does. Chrome color (border, header icon, namespace fallback)
  // stays unchanged.
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSubGraphsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(memoryOverride: any) {
    return act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory: memoryOverride,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  it('passes per-URI nodeColors keyed by TRUST_COLORS[trustLevel] for every card entity', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'recipes', entityCount: 3, tripleCount: 3, description: '' }],
    });
    const wmEntity = {
      uri: 'urn:e:wm', label: 'WM', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };
    const swmEntity = {
      uri: 'urn:e:swm', label: 'SWM', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };
    const vmEntity = {
      uri: 'urn:e:vm', label: 'VM', types: [],
      trustLevel: 'verified',
      layers: new Set(['verified']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };
    // A triple between the WM and SWM entities so the mini-graph
    // actually renders (canvas-empty branch is the other path).
    const edge = {
      subject: 'urn:e:wm',
      predicate: 'http://schema.org/relatedTo',
      object: 'urn:e:swm',
      subGraph: 'recipes',
      layer: 'working' as const,
    };

    await renderWith({
      ...memory,
      entityList: [wmEntity, swmEntity, vmEntity],
      entities: new Map([
        [wmEntity.uri, wmEntity],
        [swmEntity.uri, swmEntity],
        [vmEntity.uri, vmEntity],
      ]),
      allTriples: [edge],
    });
    await flush();

    // RdfGraph is React.lazy'd — pump microtasks until the Suspense
    // boundary resolves and our mock renders.
    async function waitForGraph(maxMs = 1000): Promise<HTMLElement | null> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
        if (el) return el;
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      }
      return container.querySelector('[data-testid="rdf-graph"]');
    }
    const graph = await waitForGraph();
    expect(graph).toBeTruthy();
    const nodeColors = JSON.parse(graph!.getAttribute('data-node-colors') ?? '{}');
    // Each entity URI keys to its canonical trust hex — same
    // palette as the detail-view Graph pane (TRUST_COLORS in
    // helpers.ts:47).
    expect(nodeColors['urn:e:wm']).toBe(TRUST_COLORS.working);
    expect(nodeColors['urn:e:swm']).toBe(TRUST_COLORS.shared);
    expect(nodeColors['urn:e:vm']).toBe(TRUST_COLORS.verified);
  });

  it('omits nodeColors entirely when the card has no entities (chrome-color fallback wins)', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'recipes', entityCount: 0, tripleCount: 0, description: '' }],
    });
    await renderWith({ ...memory, entityList: [], allTriples: [] });
    await flush();

    // Empty entity set + no triples → card-body falls through to
    // the empty placeholder, no RdfGraph mount.
    const graph = container.querySelector('[data-testid="rdf-graph"]');
    expect(graph).toBeNull();
  });

  // S3 polish PR #793 Codex sweep 4 (Bug M) — `entityTrustByUri`
  // upstream loop now writes BOTH canonical AND raw URI forms so
  // the mini-graph `nodeColors` override resolves either form
  // the triple set may carry. Pre-fix a wrapped `<urn:...>`
  // subject/object missed the canonical-only key and fell back
  // to `card.color` (chrome), defeating #3's per-trust signal
  // exactly in the cases (wrapped URIs from a daemon query path)
  // where it matters most.
  it('mini-graph nodeColors maps both raw <urn:...> and canonical urn:... forms to TRUST_COLORS (Bug M load-bearing)', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'recipes', entityCount: 1, tripleCount: 1, description: '' }],
    });
    // Entity carries the raw wrapped form on its `.uri`.
    const wrappedEntity = {
      uri: '<urn:e:wrapped>',
      label: 'Wrapped', types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };
    // A triple anchoring the entity to the card's render set so
    // the mini-graph mounts.
    const edge = {
      subject: '<urn:e:wrapped>',
      predicate: 'http://schema.org/name',
      object: '<urn:e:other>',
      subGraph: 'recipes',
      layer: 'shared' as const,
    };
    const otherEntity = {
      uri: 'urn:e:other',
      label: 'Other', types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };

    await renderWith({
      ...memory,
      entityList: [wrappedEntity, otherEntity],
      entities: new Map([
        [wrappedEntity.uri, wrappedEntity],
        [otherEntity.uri, otherEntity],
      ]),
      allTriples: [edge],
    });
    await flush();

    async function waitForGraph(maxMs = 1000): Promise<HTMLElement | null> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
        if (el) return el;
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      }
      return container.querySelector('[data-testid="rdf-graph"]');
    }
    const graph = await waitForGraph();
    expect(graph).toBeTruthy();
    const nodeColors = JSON.parse(graph!.getAttribute('data-node-colors') ?? '{}');

    // BOTH forms must resolve to TRUST_COLORS.shared — the
    // override has to win for whichever form the rendered
    // triple carries (`<urn:e:wrapped>` here).
    expect(nodeColors['<urn:e:wrapped>']).toBe(TRUST_COLORS.shared);
    expect(nodeColors['urn:e:wrapped']).toBe(TRUST_COLORS.shared);
    // The unwrapped sibling still resolves correctly (regression
    // guard against the upstream change accidentally inverting
    // the canonical-vs-raw write order).
    expect(nodeColors['urn:e:other']).toBe(TRUST_COLORS.working);
  });

  it('mini-graph nodeColors keeps the canonical mapping for unwrapped entities (Bug M regression guard)', async () => {
    // Defensive — when all URIs are already canonical, the dual
    // write collapses to a single key and the map size is just
    // the entity count.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'recipes', entityCount: 1, tripleCount: 1, description: '' }],
    });
    const e = {
      uri: 'urn:e:plain',
      label: 'Plain', types: [],
      trustLevel: 'verified',
      layers: new Set(['verified']),
      subGraphs: new Set(['recipes']),
      properties: new Map(), connections: [],
    };
    const edge = {
      subject: 'urn:e:plain',
      predicate: 'http://schema.org/name',
      object: '"Plain"',
      subGraph: 'recipes',
      layer: 'verified' as const,
    };
    await renderWith({
      ...memory,
      entityList: [e],
      entities: new Map([[e.uri, e]]),
      allTriples: [edge],
    });
    await flush();

    async function waitForGraph(maxMs = 1000): Promise<HTMLElement | null> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const el = container.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
        if (el) return el;
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      }
      return container.querySelector('[data-testid="rdf-graph"]');
    }
    const graph = await waitForGraph();
    expect(graph).toBeTruthy();
    const nodeColors = JSON.parse(graph!.getAttribute('data-node-colors') ?? '{}');
    expect(nodeColors['urn:e:plain']).toBe(TRUST_COLORS.verified);
    // The dual-key shape MUST NOT introduce a phantom wrapped
    // form when the entity didn't have one.
    expect(nodeColors['<urn:e:plain>']).toBeUndefined();
  });
});
