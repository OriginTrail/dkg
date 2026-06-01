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
      // PR #818 sweep 2 — also surface the data length via
      // `data-triple-count` so MAX_PER_CARD cap tests can assert
      // the rendered slice length directly (would have caught
      // the single-dominant-subject cap defect).
      const nodeColors = props.options?.style?.nodeColors ?? {};
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-node-colors': JSON.stringify(nodeColors),
        'data-triple-count': String(props.data?.length ?? 0),
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

// RdfGraph is React.lazy'd — pump microtasks until the Suspense
// boundary resolves and the stub renders. Sweep 1 cap tests
// asserted against a transient Suspense fallback that shares the
// empty-branch class; tighten by waiting for the actual graph
// element before reading `data-triple-count`. Optional `scope`
// restricts the lookup (e.g. to a specific card element).
async function waitForGraph(
  container: Element,
  options?: { scope?: Element; maxMs?: number },
): Promise<HTMLElement | null> {
  const root = options?.scope ?? container;
  const maxMs = options?.maxMs ?? 1000;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const el = root.querySelector('[data-testid="rdf-graph"]') as HTMLElement | null;
    if (el) return el;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return root.querySelector('[data-testid="rdf-graph"]');
}

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
      // alpha sub-graph triples. GH #805 — fixture now tags
      // `layer: 'working'` so the `useLayerTriples` sum
      // (which the subtitle now reads) admits them.
      { subject: 'urn:e:a1', predicate: 'p', object: 'o1', subGraph: 'alpha', layer: 'working' },
      { subject: 'urn:e:a2', predicate: 'p', object: 'o2', subGraph: 'alpha', layer: 'working' },
      // beta sub-graph triples
      { subject: 'urn:e:b1', predicate: 'p', object: 'o3', subGraph: 'beta', layer: 'working' },
      { subject: 'urn:e:b2', predicate: 'p', object: 'o4', subGraph: 'beta', layer: 'working' },
      // a root-bucket triple (no sub-graph origin) — counted by the
      // hook total but never reaches a card aggregate.
      { subject: 'urn:e:root', predicate: 'p', object: 'o5', layer: 'working' },
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
    // PR #818 sweep 2 — subtitle label is "named subgraphs" so
    // it's honest about the count's scope (Root is a peer-but-
    // different surface in the grid).
    expect(sub!.textContent).toContain('2 named subgraphs');
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
      // 4 raw triple rows; the (urn:e:cross, p, o) SPO appears in
      // both alpha and beta named graphs — exactly the SWM
      // cross-graph duplication GH #805 fixes. After
      // `useLayerTriples` SPO-dedup the layer slice carries 3
      // distinct triples, not 4.
      { subject: 'urn:e:alpha-only', predicate: 'p', object: 'o', subGraph: 'alpha', layer: 'working' },
      { subject: 'urn:e:beta-only', predicate: 'p', object: 'o', subGraph: 'beta', layer: 'working' },
      { subject: 'urn:e:cross', predicate: 'p', object: 'o', subGraph: 'alpha', layer: 'working' },
      { subject: 'urn:e:cross', predicate: 'p', object: 'o', subGraph: 'beta', layer: 'working' },
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
    // Subtitle triples now sums `useLayerTriples` per layer
    // (GH #805): the (urn:e:cross, p, o) SPO row that appeared
    // in both alpha and beta named graphs collapses to 1 after
    // canonical-SPO dedup, so the 4 raw rows project down to 3
    // distinct triples in the WM layer slice.
    expect(sub!.textContent).toContain('3 triples');
    // The raw `allTriples.length` (4) must NOT appear — that's
    // the bug GH #805 fixed.
    expect(sub!.textContent).not.toContain('4 triples');
  });

  it('subtitle drops WM residue rows only when BOTH endpoints have moved past the row layer (GH #819 mixed-layer-preserving rule)', async () => {
    // The residue-drop semantic shifted from PR #805's per-layer
    // rule ("drop if subject moved") to GH #819's canonical-total
    // rule ("drop ONLY if BOTH endpoints moved past `t.layer`").
    // The new rule preserves legitimate mixed-layer edges — the
    // common case after promotion where an entity moves up but
    // still has cross-layer references.
    //
    // This test exercises BOTH branches:
    //   • promoted → orphan object (literal / class IRI / non-
    //     entity URN): orphan never "moves", so the row is not
    //     unambiguous residue → ADMITS as a legitimate
    //     subject-local property of the promoted entity.
    //   • promoted → promoted (both endpoints SWM canonical) at
    //     row layer 'working': both moved past WM → DROPS as
    //     unambiguous residue.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 2, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Both entities canonical layer SWM (promoted past WM).
      { uri: 'urn:e:promoted-a', label: 'a', types: [], trustLevel: 'shared', layers: new Set(['working', 'shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:promoted-b', label: 'b', types: [], trustLevel: 'shared', layers: new Set(['working', 'shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Honest SWM triple to an orphan object — kept.
      { subject: 'urn:e:promoted-a', predicate: 'p', object: 'o-swm', layer: 'shared' },
      // WM row to an orphan object. Subject moved past WM but
      // object is an orphan (no entity record), so this is NOT
      // unambiguous residue under the canonical rule. Admits as a
      // subject-local property (the GH #819 mixed-layer-preserving
      // behavior the per-layer rule incorrectly dropped).
      { subject: 'urn:e:promoted-a', predicate: 'p', object: 'o-wm-mixed', layer: 'working' },
      // WM row between two promoted entities. BOTH endpoints
      // moved past WM → unambiguous residue → drops.
      { subject: 'urn:e:promoted-a', predicate: 'p', object: 'urn:e:promoted-b', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
    });
    await flush();

    const sub = container.querySelector('.v10-sgov-sub');
    expect(sub).toBeTruthy();
    // 2 of 3 rows admit: the honest SWM row + the orphan-object
    // WM row (legitimate post-promotion subject-local property).
    // The full-residue WM row between two promoted entities drops.
    // Pre-#819 (`useLayerTriples` per-layer rule) would have
    // dropped both WM rows → `1 triples`. The canonical rule
    // keeps mixed-layer.
    expect(sub!.textContent).toContain('2 triples');
    expect(sub!.textContent).not.toContain('3 triples');
  });
});

describe('SubGraphOverviewGrid — Root mini-card (GH #813)', () => {
  // The Root mini-card mirrors SubGraphBar's Root chip on the
  // overview surface. Synthesizes a card for the bucket of
  // entities not in any named sub-graph; rendered LAST in the
  // grid (mirrors the Root chip's rightmost chip-row position);
  // carries the dashed-border `.root` chrome modifier so it
  // reads as a synthesized bucket vs daemon-emitted cards.
  let root: Root;
  let container: HTMLDivElement;

  // Profile fixture that mirrors useProjectProfile's
  // ROOT_SUBGRAPH_BINDING short-circuit at `:622` so the Root card
  // resolves to the same `⊘` / `Root` identity production renders.
  const rootAwareProfile = {
    ...profile,
    forSubGraph: (slug: string) => {
      if (slug === '__root__') {
        return { slug: '__root__', displayName: 'Root', description: 'Entities not in any subgraph (Context Graph root)', icon: '⊘', rank: 999 };
      }
      return { slug, displayName: slug, color: '#38bdf8', icon: '#', rank: 0 };
    },
  } as any;

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
        React.createElement(ProjectProfileContext.Provider, { value: rootAwareProfile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory: memoryOverride,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  it('renders a Root mini-card with the dashed `.root` chrome modifier', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // 1 entity in a named sub-graph (alpha) + 1 root-bucket entity.
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:root', label: 'r', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: [],
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    // 1 named card + 1 Root card = 2 cards rendered.
    expect(cards.length).toBe(2);
    // Root card is LAST (mirrors chip-row position).
    const rootCardEl = cards[cards.length - 1];
    expect(rootCardEl.classList.contains('root')).toBe(true);
    // Root card renders the canonical `Root` identity (icon + label).
    expect(rootCardEl.querySelector('.v10-sgov-card-title')?.textContent).toBe('Root');
    expect(rootCardEl.querySelector('.v10-sgov-card-icon')?.textContent).toBe('⊘');
    // Stats reflect the 1 root-bucket entity.
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    expect(stats).toContain('1');
    expect(stats).toContain('entities');
  });

  it('renders the Root mini-card even at 0 root entities (consistency with named-card empty branch)', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Every entity belongs to a named sub-graph — root bucket is
      // empty. Per option (b) the card still renders, matching how
      // named subgraphs with 0 entities render the empty branch.
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: [],
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    expect(cards.length).toBe(2);
    const rootCardEl = cards[cards.length - 1];
    expect(rootCardEl.classList.contains('root')).toBe(true);
    // Empty branch literal — same one named cards use.
    expect(rootCardEl.querySelector('.v10-sgov-card-empty')?.textContent).toBe('No data yet');
  });

  it('Root card open button calls onSelectSubGraph with ROOT_SLUG_SENTINEL', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:root', label: 'r', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const onSelectSubGraph = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: rootAwareProfile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory: {
              ...memory,
              entities: new Map(entityList.map(e => [e.uri, e])),
              entityList,
              allTriples: [],
              counts: { wm: 2, swm: 0, vm: 0, total: 2 },
            },
            onNodeClick: vi.fn(),
            onSelectSubGraph,
          })),
      );
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const openBtn = rootCardEl.querySelector('.v10-sgov-card-open') as HTMLButtonElement;
    expect(openBtn).toBeTruthy();
    await act(async () => { openBtn.click(); });
    expect(onSelectSubGraph).toHaveBeenCalledWith('__root__');
  });

  it('Root card scopes triples to untagged-recovery-only (mirrors SubGraphDetailView Root rule)', async () => {
    // SubGraphDetailView Root branch: rule 1 "exact-tag-routing"
    // never fires for Root (the bucket carries no tagged triples
    // by definition); only untagged triples with an in-scope
    // endpoint are admitted. Mini-card must mirror that — a
    // tagged triple between two root entities must NOT appear in
    // the Root card's graph slice (lives on the tagged
    // sub-graph's card instead).
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 1, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:root1', label: 'r1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
      { uri: 'urn:e:root2', label: 'r2', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Tagged triple — root entity but tagged to a different
      // sub-graph. Must NOT appear in Root's slice.
      // PR #818 sweep 2 — fixtures tagged `layer: 'working'` so
      // `useLayerTriples` admits them into the layer-correct
      // universe the Root card now scopes into (GH #805 family).
      { subject: 'urn:e:root1', predicate: 'p', object: 'urn:e:alpha', subGraph: 'alpha', layer: 'working' },
      // Untagged triple between two root entities — admitted by
      // the untagged-recovery branch.
      { subject: 'urn:e:root1', predicate: 'p', object: 'urn:e:root2', layer: 'working' },
      // Untagged triple with no endpoint in scope — must NOT
      // appear in Root's slice.
      { subject: 'urn:e:alpha', predicate: 'p', object: 'urn:e:somewhere-else', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 3, swm: 0, vm: 0, total: 3 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    // Root card stats: 2 root entities, 1 admitted triple (the
    // untagged root↔root edge). Tagged + non-scoped triples
    // dropped.
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    expect(stats).toContain('2 entities');
    expect(stats).toContain('1 triples');
  });

  it('Root card canonicalizes triple endpoints + SPO dedup key (Codex sweep 1, Bug M family)', async () => {
    // PR #818 sweep 1 — `rootEntityUris` is built from
    // `canonicalEntityUri(e.uri)` but `t.subject` / `t.object` from
    // `memory.allTriples` carry the daemon-emitted raw forms (often
    // wrapped `<urn:...>`). Without canonicalisation on the
    // consumer side:
    //   1. The membership check fails when a wrapped endpoint's
    //      canonical form IS in the set — the in-scope triple
    //      gets silently dropped from the card slice.
    //   2. The SPO-dedup key counts wrapped + bare variants of the
    //      same (s,p,o) as distinct rows — inflates the count.
    // The fix canonicalises subject + object once per iteration,
    // uses canonical forms for BOTH the membership check AND the
    // seenSpo key. Mirrors the upstream Bug M dual-key pattern.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      // Root entity in canonical (unwrapped) form. `rootEntityUris`
      // therefore contains 'urn:e:root1' only.
      { uri: 'urn:e:root1', label: 'r1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Subject wrapped — pre-sweep the membership check (against
      // the unwrapped set) failed and this triple was dropped.
      // PR #818 sweep 2 — fixtures tagged `layer: 'working'` so
      // `useLayerTriples` admits them (GH #805 family).
      // PR #818 sweep 6 — Root now AND-filters via
      // `filterTriplesToEntities`; resource-object endpoints
      // would otherwise need to be entities. Use literal objects
      // so admission lands solely on the canonical-URI subject
      // check this test is actually exercising.
      { subject: '<urn:e:root1>', predicate: 'p', object: '"o-bare"', layer: 'working' },
      // Same SPO emitted twice — once wrapped on the object
      // side, once bare. Pre-sweep these had distinct seenSpo
      // keys and counted as 2. Post-sweep both map to the same
      // canonical key and dedup to 1.
      { subject: 'urn:e:root1', predicate: 'p', object: '"o-other"', layer: 'working' },
      { subject: 'urn:e:root1', predicate: 'p', object: '"o-other"', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // 1 root entity, 2 distinct triples after canonical-SPO dedup
    // (the wrapped/bare object pair collapses to 1; the wrapped-
    // subject row is admitted via the canonicalised membership
    // check). Pre-sweep this fixture would have rendered "1 triple"
    // (wrapped subject dropped) OR "3 triples" (no dedup).
    expect(stats).toContain('1 entities');
    expect(stats).toContain('2 triples');
  });

  it('renders the Root card when the CG has zero named subgraphs but non-zero root entities (Codex sweep 1)', async () => {
    // PR #818 sweep 1 — the teaching empty state gate previously
    // fired on `cards.length === 0` alone. A CG with no named
    // sub-graphs but populated root entities lost the direct Root
    // affordance: user landed on the teaching state and had to
    // click "View root" instead of seeing the Root card in place.
    // Gate is now `cards.length === 0 && rootCard.entityCount === 0`,
    // so this scenario renders only the Root card as the entire
    // grid.
    fetchSubGraphsMock.mockResolvedValueOnce({
      // Zero named sub-graphs.
      subGraphs: [],
    });
    const entityList = [
      { uri: 'urn:e:root-only', label: 'r', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: [],
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
    });
    await flush();

    // Teaching empty state must NOT render — its title is the
    // tell.
    expect(container.textContent ?? '').not.toContain('No subgraphs in this Context Graph yet.');
    // PR #818 sweep 2 — subtitle reads `0 named subgraphs` here.
    // Locks the rename: pre-sweep this said `0 subgraphs` while
    // a Root card visibly rendered (the inconsistency Codex
    // flagged in sweep 2 finding 3). The "named" qualifier makes
    // the count honest about what `cards.length` covers.
    const sub = container.querySelector('.v10-sgov-sub');
    expect(sub?.textContent).toContain('0 named subgraphs');
    // Exactly one card renders — the Root card.
    const cards = container.querySelectorAll('.v10-sgov-card');
    expect(cards.length).toBe(1);
    expect(cards[0].classList.contains('root')).toBe(true);
    expect(cards[0].querySelector('.v10-sgov-card-title')?.textContent).toBe('Root');
  });

  it('renders the teaching empty state when the CG has zero named subgraphs AND zero root entities (Codex sweep 1)', async () => {
    // Companion test — the truly-empty case must keep showing the
    // teaching empty state (unchanged behaviour). Locks against a
    // regression where someone widens the Root card gate too far.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [],
    });
    await renderWith({
      ...memory,
      entityList: [],
      allTriples: [],
      counts: { wm: 0, swm: 0, vm: 0, total: 0 },
    });
    await flush();

    // Teaching empty state renders — its title is the tell.
    expect(container.textContent ?? '').toContain('No subgraphs in this Context Graph yet.');
    // No mini-cards.
    expect(container.querySelectorAll('.v10-sgov-card').length).toBe(0);
  });

  it('Root card caps mini-graph triples at MAX_PER_CARD via heaviest-subjects sampling (Codex sweep 1)', async () => {
    // PR #818 sweep 1 — earlier the Root card had no cap on the
    // theory that the recovery slice was small. Codex flagged
    // the counterexample: large initial seeds + agents writing
    // without sub-graph tags can produce thousands of untagged
    // triples touching root entities, locking RdfGraph's layout
    // on the overview tab. Cap = 2500 (same constant as the
    // named-card path); sampling keeps every triple for the
    // heaviest-degree subjects so cluster topology survives.
    //
    // Fixture: 1 high-degree root entity with 3000 untagged
    // triples. Without the cap the mini-graph would receive
    // 3000 triples; with it, only the 2500-row sample
    // (every triple stays in this case because the one heaviest
    // subject hits the cap first, so the `kept >= MAX_PER_CARD`
    // break trips after the first iteration and only 2500 of
    // its rows survive the filter).
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:heavy-root', label: 'hr', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [];
    for (let i = 0; i < 3000; i++) {
      // PR #818 sweep 2 — tag `layer: 'working'` so the layer-correct
      // universe `useLayerTriples` produces (GH #805 family) admits
      // these rows for the Root card to scope over.
      // PR #818 sweep 6 — literal objects so AND-membership via
      // `filterTriplesToEntities` admits them (resource-object
      // edges would need both endpoints in the entity set).
      triples.push({ subject: 'urn:e:heavy-root', predicate: 'p', object: `"v-${i}"`, layer: 'working' });
    }
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    // tripleCount stat reports the TRUE pre-cap distinct total
    // (3000 — matches the named-card convention where the badge
    // reads the daemon-reported total even when the mini-graph
    // slice is sampled).
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    expect(stats).toContain('3000 triples');
    // PR #818 sweep 2 — the rendered mini-graph slice receives
    // the post-cap sampled rows. The RdfGraph stub exposes
    // `data-triple-count` so we can assert the cap is honored
    // directly. Earlier shape `expect(emptyBranch).toBeNull()`
    // was brittle (Suspense fallback shares the empty class) AND
    // would have missed the single-dominant-subject defect Codex
    // surfaced in sweep 2 — assert against the cap directly now.
    // PR #818 sweep 3 — wait for Suspense resolution before
    // reading the data attribute so isolated runs don't race
    // the lazy import.
    const graphEl = await waitForGraph(container, { scope: rootCardEl });
    expect(graphEl).toBeTruthy();
    const renderedTripleCount = Number(graphEl!.getAttribute('data-triple-count') ?? 'NaN');
    expect(renderedTripleCount).toBeLessThanOrEqual(2500); // MAX_PER_CARD
    // And the cap actually fires (we're well over with 3000) —
    // not just trivially under it because the input degraded.
    expect(renderedTripleCount).toBeGreaterThan(0);
  });

  it('Root card retains all triples under the MAX_PER_CARD cap (no spurious sampling)', async () => {
    // Companion test — the cap must not fire when the root
    // triple slice is small. Fixture: 5 distinct root↔root
    // triples → both stat AND rendered graph carry 5.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:r1', label: 'r1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // PR #818 sweep 2 — `layer: 'working'` so the layer-correct
      // universe (GH #805) admits the rows.
      // PR #818 sweep 6 — literal objects so AND-membership
      // admits them past `filterTriplesToEntities`.
      { subject: 'urn:e:r1', predicate: 'p', object: '"o1"', layer: 'working' },
      { subject: 'urn:e:r1', predicate: 'p', object: '"o2"', layer: 'working' },
      { subject: 'urn:e:r1', predicate: 'p', object: '"o3"', layer: 'working' },
      { subject: 'urn:e:r1', predicate: 'p', object: '"o4"', layer: 'working' },
      { subject: 'urn:e:r1', predicate: 'p', object: '"o5"', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    expect(stats).toContain('5 triples');
    // RdfGraph renders (not the empty branch), confirming all 5
    // triples survived to the mini-graph slice.
    expect(rootCardEl.querySelector('[data-testid="rdf-graph"]')).toBeTruthy();
  });

  it('Root card admits WM residue alongside honest SWM rows (Codex sweep 4 revert — consistent-wrong vs named cards, fix-side scoped for GH #819)', async () => {
    // PR #818 sweep 4 (ux-lead Finding 1 verdict A — revert).
    // Sweep 2 added a `useLayerTriples` layer-correctness filter
    // that dropped WM-residue rows for a promoted entity. That
    // filter introduced two regressions of its own at the next
    // consumer downstream (per-slice SPO-dedup race + mixed-layer
    // edge drop) — moving the symptom rather than fixing the
    // source. ux-lead's verdict (A): revert to the symmetric
    // `memory.allTriples` filtered by `!t.subGraph` shape so the
    // Root card uses the same machinery as the named cards.
    //
    // Post-revert: the WM residue row admits alongside the honest
    // SWM row. Inflation is consistent across Root AND named
    // cards (consistent-wrong is easier to reason about and to
    // fix in one render-side follow-up than divergent-wrong).
    // GH #819 owns the shared render-correct derivation for both
    // surfaces.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      // Root-bucket entity, canonical trustLevel is SWM (promoted
      // past WM, but `subGraphs.size === 0` keeps it in the Root
      // bucket).
      { uri: 'urn:e:promoted', label: 'p', types: [], trustLevel: 'shared', layers: new Set(['working', 'shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Honest SWM triple — admitted into the SWM layer slice.
      // PR #818 sweep 6 — literal objects so AND-membership via
      // `filterTriplesToEntities` admits them on the canonical-
      // URI subject check (the residue/inflation semantic this
      // test exercises is orthogonal to the resource-vs-literal
      // distinction).
      { subject: 'urn:e:promoted', predicate: 'p', object: '"o-swm"', layer: 'shared' },
      // WM residue — same subject, but canonical trustLevel is
      // 'shared', so `useLayerTriples('wm')` drops this row via
      // the subject-trust-level filter at helpers.ts:436-437.
      // Pre-sweep this would have inflated the Root card stat by 1.
      { subject: 'urn:e:promoted', predicate: 'p', object: '"o-wm-residue"', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 1, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // PR #818 sweep 4 (ux-lead Finding 1 verdict A — revert): the
    // sweep-2 layer-correctness filter has been removed; Root now
    // mirrors the named-card pattern over `memory.allTriples`. The
    // WM residue row admits alongside the honest SWM row — same
    // inflation behavior as named cards (consistent-wrong rather
    // than divergent-wrong; render-side fix is GH #819).
    expect(stats).toContain('2 triples');
  });

  it('Root card admits SWM cross-graph SPO collision via the untagged variant (Codex sweep 4 regression — under-count prevented)', async () => {
    // PR #818 sweep 4 (ux-lead Finding 1 verdict A — revert).
    // The sweep-2 `useLayerTriples` derivation had a per-slice
    // dedup race: when the SAME `(s, p, o)` shipped under BOTH
    // the root SWM graph (untagged) AND a per-sub-graph SWM graph
    // (tagged), the SWM layer slice's canonical-SPO dedup
    // collapsed both rows into the one that arrived first. If
    // the tagged row won, the Root card's `if (t.subGraph)
    // continue` guard then dropped it — and the untagged variant
    // never got a second chance to admit. Outcome: Root card
    // under-counted the SPO to ZERO on the cross-graph collision
    // shape.
    //
    // Post-revert: `memory.allTriples` is the input, so both the
    // tagged and untagged variants reach the Root loop. The
    // `!t.subGraph` filter drops the tagged row; the untagged row
    // admits and renders. Regression-prevent: the row admits at
    // least once — not the sweep-2 outcome of 0.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 0, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Single root-bucket entity at SWM.
      { uri: 'urn:e:root-swm', label: 'rsm', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // The crucial cross-graph collision: the SAME SPO ships
      // under both an untagged variant (root SWM graph) AND a
      // tagged variant (per-sub-graph SWM graph). Sweep 2's per-
      // layer dedup collapsed them and could drop the survivor.
      // Post-revert the untagged row admits.
      { subject: 'urn:e:root-swm', predicate: 'rdfs:label', object: '"r"', layer: 'shared' },
      { subject: 'urn:e:root-swm', predicate: 'rdfs:label', object: '"r"', subGraph: 'alpha', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 1, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // Lock-test: the cross-graph SPO admits via the untagged row.
    // Pre-revert (sweep 2) this fixture rendered `0 triples` when
    // the tagged row won the per-slice dedup race. Loose lower-
    // bound rather than strict equality because the render-side
    // inflation behavior is left for GH #819 to lock precisely;
    // the regression-prevent contract here is "not zero".
    expect(stats).toContain('1 entities');
    expect(stats).not.toContain('0 triples');
  });

  it('Root card admits mixed-layer resource edges (Codex sweep 4 regression — WM→SWM cross-layer drop prevented)', async () => {
    // PR #818 sweep 4 (ux-lead Finding 2 verdict A — revert).
    // Sweep 2's `useLayerTriples` derivation applied a subject-
    // trust-level residue filter inside each layer slice. For a
    // WM root entity pointing at an SWM entity, the row's
    // `t.layer === 'shared'` sent it to the SWM slice — but the
    // SWM slice's residue filter drops rows whose subject's
    // canonical trustLevel doesn't match the slice (subject is
    // WM, slice is SWM → dropped). The row never entered any
    // layer slice and never reached the Root card.
    //
    // Post-revert: `memory.allTriples` carries the row, the Root
    // loop sees it, the untagged check passes (no subGraph), and
    // canonical-URI membership admits because the WM subject IS
    // in `rootEntityUris`. Lock-test: the cross-layer edge
    // renders on the Root card.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 0, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // WM root entity (subject of the cross-layer edge).
      { uri: 'urn:e:wm-root', label: 'w', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
      // SWM root entity (object of the cross-layer edge).
      { uri: 'urn:e:swm-root', label: 's', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // The crucial cross-layer edge: WM subject → SWM object,
      // row layer matches the object's (SWM). Sweep 2 dropped
      // it; post-revert it admits.
      { subject: 'urn:e:wm-root', predicate: 'rel', object: 'urn:e:swm-root', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 1, swm: 1, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // Both endpoints are root entities; the cross-layer edge
    // admits. Pre-revert (sweep 2) the residue filter dropped it
    // → Root card showed `0 triples`. Post-revert it shows `1`.
    expect(stats).toContain('2 entities');
    expect(stats).toContain('1 triples');
  });

  it('Root card drops triples to non-root entities (Codex sweep 6 — AND-membership symmetric with named cards)', async () => {
    // PR #818 sweep 6 — sweep 4's inline OR-membership ("admit if
    // either endpoint is in rootEntityUris") let untagged triples
    // from `<cg>/_shared_memory` whose SUBJECT happened to be a
    // root entity admit even when the OBJECT was a non-root
    // entity. User caught the bug on `ui-refresh`: entity
    // `urn:epcis:...:gtin:50127962004651:lot:P240526X` lived in
    // `epcis-supply-chain` (subGraphs non-empty → not in Root
    // entity list), but the daemon ships untagged copies of its
    // triples in `<cg>/_shared_memory` → rendered as a node in
    // the Root mini-graph (broke the visual count check).
    //
    // Fix: route through `filterTriplesToEntities(candidates,
    // rootEntityUris)` so admission is AND-membership (both
    // endpoints must be root entities, with `rdf:type` exempted)
    // — exactly the named-card rule.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Non-root entity (in a named sub-graph).
      { uri: 'urn:e:non-root', label: 'nr', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      // Root-bucket entity.
      { uri: 'urn:e:root', label: 'r', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Untagged edge from root → non-root. Pre-sweep-6 OR-
      // membership admitted this (subject IS in rootEntityUris)
      // and `urn:e:non-root` rendered as a node in the Root
      // mini-graph. Post-sweep-6 AND-membership drops it.
      { subject: 'urn:e:root', predicate: 'p', object: 'urn:e:non-root', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // 1 root entity, 0 triples — the root→non-root edge dropped
    // by AND-filter. Pre-sweep this read `1 triples`.
    expect(stats).toContain('1 entities');
    expect(stats).toContain('0 triples');
    expect(stats).not.toContain('1 triples');
  });

  it('Root card admits rdf:type edges to class URIs (Codex sweep 6 — class IRIs exempted from AND-filter)', async () => {
    // PR #818 sweep 6 — `filterTriplesToEntities` exempts
    // `rdf:type` from the object-side membership check because
    // class IRIs aren't entities but the triple is needed for
    // `classColors` styling (helpers.ts:533-535). Lock that the
    // Root card preserves this exemption when it routes through
    // the helper.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 0, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Root-bucket entity.
      { uri: 'urn:e:root', label: 'r', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // rdf:type to a class IRI — admits via the exemption.
      { subject: 'urn:e:root', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:type:Document', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 1, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // rdf:type row admits despite the class URI not being in
    // rootEntityUris — the exemption preserves the type signal
    // for classColors on the rendered mini-graph.
    expect(stats).toContain('1 entities');
    expect(stats).toContain('1 triples');
  });

  it('Named card renders the per-subgraph canonical-bucket triple count (GH #819 decoupled from AND-filtered rendered slice)', async () => {
    // PR #818 sweep 6 + GH #819 separation of concerns:
    //   - `tripleCount` STAT reports the canonical per-subgraph
    //     bucket size (post-residue-filter, post-canonical-SPO-
    //     dedup, pre-cap, pre-AND-filter). This is the "true
    //     count" the user sees on the card chrome — agrees with
    //     the subtitle distinct total when summed without
    //     double-counting cross-graph duplicates.
    //   - `triples` RENDERED slice further applies
    //     `filterTriplesToEntities` (AND-membership +
    //     rdf:type exemption) so non-scoped objects don't render
    //     as phantom nodes. The two are intentionally decoupled.
    //
    // Pre-#819 the stat read `sg.tripleCount` (daemon-reported)
    // which was the inflated raw count — agreed with neither the
    // canonical universe nor the rendered slice.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // 'alpha' entity (in-scope for the alpha card).
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      // 'beta' entity — out-of-scope for the alpha card.
      { uri: 'urn:e:beta', label: 'b', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['beta']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // alpha → beta edge tagged to alpha's subgraph. The triple
      // genuinely belongs to alpha's bucket (subGraph tag), so it
      // counts in the alpha card's stat. The AND-filtered render
      // slice still drops it because beta isn't in alpha's
      // entityUris — but that's a render concern, not a count
      // concern.
      { subject: 'urn:e:alpha', predicate: 'p', object: 'urn:e:beta', subGraph: 'alpha', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
    });
    await flush();

    // alpha card is first.
    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const stats = alphaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // 1 entity (alpha — the only entity in alpha's subgraph),
    // 1 triple (the alpha-tagged edge is in alpha's canonical
    // bucket). Pre-#819 read `sg.tripleCount` (daemon 0); the
    // canonical bucket-size lock anchors the new behavior.
    expect(stats).toContain('1 entities');
    expect(stats).toContain('1 triples');

    // GH #819 round 2 (ux-lead locked literal) — when the in-scope
    // canonical count differs from what actually renders on the
    // mini-graph, the triple-count badge gets a `title` tooltip
    // explaining the gap. Here the alpha→beta edge is in alpha's
    // canonical bucket (count = 1) but drops from the rendered
    // slice via `filterTriplesToEntities` (rendered = 0). Tooltip
    // surfaces this asymmetry.
    const tripleStat = Array.from(alphaCardEl.querySelectorAll('.v10-sgov-card-stat'))
      .find(el => el.textContent?.includes('triples')) as HTMLElement | undefined;
    expect(tripleStat).toBeTruthy();
    expect(tripleStat!.getAttribute('title')).toBe(
      `1 triples in this subgraph's scope; 0 rendered (cross-card edges whose other endpoint isn't in this subgraph aren't drawn here).`,
    );
  });

  it('Named card omits the stat-vs-rendered tooltip when count and rendered agree (GH #819 round 2 conditional render)', async () => {
    // ux-lead locked the tooltip as conditional — added only when
    // `tripleCount !== renderedTripleCount`. When equal (the
    // common case: bucket is small, no cross-card edges, no cap),
    // no chrome is added; the badge reads cleanly. Same
    // visible-when-it-has-something-to-say pattern as S2's
    // `Pending join requests` empty state.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 2, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Both entities in alpha's scope.
      { uri: 'urn:e:alpha-a', label: 'aa', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:alpha-b', label: 'ab', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // alpha-a → alpha-b edge: both endpoints in alpha's
      // entityUris, so `filterTriplesToEntities` admits → rendered
      // count == bucket count. No tooltip.
      { subject: 'urn:e:alpha-a', predicate: 'p', object: 'urn:e:alpha-b', subGraph: 'alpha', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const tripleStat = Array.from(alphaCardEl.querySelectorAll('.v10-sgov-card-stat'))
      .find(el => el.textContent?.includes('triples')) as HTMLElement | undefined;
    expect(tripleStat).toBeTruthy();
    expect(tripleStat!.textContent).toContain('1 triples');
    // Conditional render — title attribute is absent (or empty)
    // when stat and rendered agree.
    expect(tripleStat!.getAttribute('title')).toBeNull();
  });

  it('Both cards surface their own scoped copy of an SPO shipped under two named subgraphs (GH #819 round 3 — Codex sweep 1 🔴 #1)', async () => {
    // PR #847 round 3 (Codex sweep 1 🔴 #1) — `useCanonicalTriples`
    // dedupes globally by `(canonical(s), p, canonical(o))` which
    // is correct for the aggregate total but WRONG for per-bucket
    // card counts: the same `(s, p, o)` legitimately shipped under
    // two named sub-graphs (cross-membership entity referenced
    // from both) would only survive in whichever row the canonical
    // helper saw first, leaving the late-arrival card under-
    // counted. Fix: `triplesBySubGraph` re-dedupes per bucket from
    // raw `memory.allTriples`, keeping `subGraph` implicit in the
    // bucket scope so each card keeps its own scoped copy.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [
        { name: 'alpha', entityCount: 1, tripleCount: 0, description: '' },
        { name: 'beta', entityCount: 1, tripleCount: 0, description: '' },
      ],
    });
    const entityList = [
      // Cross-membership entity in both alpha and beta.
      { uri: 'urn:e:cross', label: 'c', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set(['alpha', 'beta']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Same SPO shipped under two named sub-graphs. Pre-fix
      // canonical's global dedup collapsed both to the row that
      // arrived first; only the first card showed the edge. Post-
      // fix each bucket admits its own copy.
      { subject: 'urn:e:cross', predicate: 'http://schema.org/name', object: '"C"', subGraph: 'alpha', layer: 'shared' },
      { subject: 'urn:e:cross', predicate: 'http://schema.org/name', object: '"C"', subGraph: 'beta', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 1, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    // 2 named cards + Root card. alpha first (rank order), beta
    // second, Root last.
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const alphaCardEl = cards[0];
    const betaCardEl = cards[1];
    const alphaStats = alphaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    const betaStats = betaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // BOTH cards show their scoped copy. Pre-fix one of them
    // showed `0 triples`.
    expect(alphaStats).toContain('1 triples');
    expect(betaStats).toContain('1 triples');
  });

  it('Named card tripleCount falls back to sg.tripleCount when canonical universe is incomplete (GH #819 round 3 — Codex sweep 1 🔴 #3)', async () => {
    // PR #847 round 3 (Codex sweep 1 🔴 #3) — round 2 gated the
    // `sg.tripleCount` fallback on `memory.loading` alone, missing
    // the hydrated-after-layer-failure case (loading flips false
    // but `canonicalTriples` is still incomplete because a layer
    // query errored). The fixture below holds `memory.loading`
    // false but reports a layer status of 'error' AND a partial
    // result — canonical universe is missing rows from that
    // layer. Pre-fix the fallback didn't fire (loading was
    // false), card rendered `0 triples` instead of the daemon
    // lower-bound. Post-fix the widened gate
    // (`canonicalIncomplete`) kicks in.
    fetchSubGraphsMock.mockResolvedValueOnce({
      // Daemon-reported lower-bound count (the fallback target).
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 42, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      // Hydrated but incomplete: layer query errored.
      allTriples: [],
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
      loading: false,
      partial: true,
      layerStatus: { wm: 'error', swm: 'ok', vm: 'ok' },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const stats = alphaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // Fallback fires — card shows the daemon-reported lower-bound
    // (42) rather than the empty canonical universe (0).
    expect(stats).toContain('42 triples');
    expect(stats).not.toContain('0 triples');
  });

  it('Named card bucket applies canonical residue filter per scope (GH #819 round 4 — Codex sweep 2 🔴 #5)', async () => {
    // PR #847 round 4 (🔴 #5) — round 3 per-bucket dedup correctly
    // preserved cross-membership multiplicity but lacked the
    // residue filter. A WM-residue resource-edge + its promoted
    // SWM/VM copy in the same subgraph (different SPO keys) would
    // double-count: both rows survived per-bucket SPO dedup, but
    // the WM row is unambiguous residue (both endpoints moved).
    // Round-4 fix: apply `applyCanonicalAdmission` per bucket so
    // residue drops at the bucket level too.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 2, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Both entities promoted past WM (canonical 'shared').
      { uri: 'urn:e:promoted-a', label: 'a', types: [], trustLevel: 'shared', layers: new Set(['working', 'shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:promoted-b', label: 'b', types: [], trustLevel: 'shared', layers: new Set(['working', 'shared']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    const triples = [
      // WM residue resource-edge — both endpoints SWM canonical,
      // row stored at WM → unambiguous residue → MUST DROP from
      // the bucket per canonical admission.
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', subGraph: 'alpha', layer: 'working' },
      // The honest SWM copy — admits.
      { subject: 'urn:e:promoted-a', predicate: 'http://schema.org/knows', object: 'urn:e:promoted-b', subGraph: 'alpha', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 2, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const stats = alphaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // 1 admitted SPO post-residue + canonical-dedup. Pre-fix the
    // bucket counted both rows (SPO keys collapsed them, BUT the
    // residue row would have admitted distinct copies if the
    // objects differed). Lock the residue-drop invariant.
    expect(stats).toContain('1 triples');
    expect(stats).not.toContain('2 triples');
  });

  it('Named card tripleCount Math.max-clamps daemon lower-bound vs partial-hydrated bucket (GH #819 round 4 — Codex sweep 2 🔴 #6)', async () => {
    // PR #847 round 4 (🔴 #6) — round 3 used `??` precedence:
    // `tripleCountBySubGraph.get(sg) ?? sg.tripleCount` only fell
    // through when the bucket was undefined. A partial-hydrated
    // bucket (e.g. 3 rows of an expected 10) had a defined value
    // and won — card stat undercounted to 3 instead of the
    // daemon's 10.
    //
    // Round-4 fix: `Math.max(sg.tripleCount, bucket ?? 0)` in the
    // `canonicalIncomplete` branch — clamps to the larger of the
    // two when the canonical universe can't be trusted, surfacing
    // the truer lower-bound either way (defends against daemon
    // undershoot too).
    fetchSubGraphsMock.mockResolvedValueOnce({
      // Daemon reports the higher count (10).
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 10, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    // 3 partially-hydrated rows in alpha's bucket — incomplete
    // canonical universe (one layer errored, so only WM made it).
    const triples = [
      { subject: 'urn:e:alpha', predicate: 'http://schema.org/name', object: '"a-name-1"', subGraph: 'alpha', layer: 'working' },
      { subject: 'urn:e:alpha', predicate: 'http://schema.org/name', object: '"a-name-2"', subGraph: 'alpha', layer: 'working' },
      { subject: 'urn:e:alpha', predicate: 'http://schema.org/name', object: '"a-name-3"', subGraph: 'alpha', layer: 'working' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
      loading: false,
      partial: true,
      // SWM errored — canonical universe is missing rows from
      // there. Daemon still reports 10 as the true total.
      layerStatus: { wm: 'ok', swm: 'error', vm: 'ok' },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const stats = alphaCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // Pre-round-4 the bucket value (3) won via `??`. Post-fix
    // `Math.max(10, 3) === 10` — the daemon lower-bound surfaces.
    expect(stats).toContain('10 triples');
    expect(stats).not.toContain('3 triples');
  });

  it('Root card keeps its scoped copy when same SPO also appears under a named subgraph (GH #819 round 4 — Codex sweep 2 🔴 #7)', async () => {
    // PR #847 round 4 (🔴 #7) — Root card sourced from
    // `canonicalTriples.filter(!t.subGraph)`. Global SPO dedup
    // made this order-dependent: if a tagged copy of the same
    // SPO arrived first, the root untagged copy lost the dedup
    // race; `filter(!t.subGraph)` then dropped the surviving
    // tagged entry; Root rendered 0.
    //
    // Round-4 fix: build Root candidates from raw root-scoped
    // rows (`!t.subGraph`), then `applyCanonicalAdmission` with
    // per-call dedup state. Each scope keeps its own copy.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 0, tripleCount: 0, description: '' }],
    });
    const entityList = [
      // Root entity (no subGraph membership).
      { uri: 'urn:e:r', label: 'r', types: [], trustLevel: 'shared', layers: new Set(['shared']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [
      // Same SPO shipped under named subgraph alpha — arrives
      // first in iteration order so it wins the global SPO dedup
      // pre-fix.
      { subject: 'urn:e:r', predicate: 'http://schema.org/name', object: '"R"', subGraph: 'alpha', layer: 'shared' },
      // Untagged root copy — pre-fix this lost the global SPO
      // dedup; `filter(!t.subGraph)` then dropped the tagged
      // survivor; Root rendered 0.
      { subject: 'urn:e:r', predicate: 'http://schema.org/name', object: '"R"', layer: 'shared' },
    ];
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 0, swm: 1, vm: 0, total: 1 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    // Root card is last in the grid (rank 999).
    const rootCardEl = cards[cards.length - 1];
    expect(rootCardEl.classList.contains('root')).toBe(true);
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    // Root keeps its scoped SPO copy — pre-fix this was 0
    // (order-dependent dedup race lost).
    expect(stats).toContain('1 triples');
    expect(stats).not.toContain('0 triples');
  });

  it('Root card cap honors MAX_PER_CARD even with a single dominant subject (Codex sweep 2)', async () => {
    // PR #818 sweep 2 — sweep-1 sampling shape had a defect:
    // `if (kept >= MAX_PER_CARD) break;` checked AFTER adding the
    // current subject's full degree. A single dominant subject
    // with degree > MAX_PER_CARD passed the check at `kept = 0`,
    // got added, contributed its full row count to `kept`, then
    // the break fired the next iteration — but `keep.has(subject)`
    // returned every row of the dominant subject from the filter,
    // including thousands above the cap. Fix: pre-check
    // `kept + subjectDegree > MAX_PER_CARD` before adding +
    // defensive `slice(0, MAX_PER_CARD)` post-filter.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      // ONE dominant root entity with 5000 untagged out-edges
      // (degree = 5000, well above MAX_PER_CARD = 2500).
      { uri: 'urn:e:dominant', label: 'd', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [];
    for (let i = 0; i < 5000; i++) {
      // PR #818 sweep 6 — literal objects so AND-membership
      // admits them past `filterTriplesToEntities` (this test
      // exercises the cap, not endpoint admission).
      triples.push({ subject: 'urn:e:dominant', predicate: 'p', object: `"v-${i}"`, layer: 'working' });
    }
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 2, swm: 0, vm: 0, total: 2 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    // PR #818 sweep 3 — wait for Suspense resolution before
    // reading the data attribute so isolated runs don't race
    // the lazy import.
    const graphEl = await waitForGraph(container, { scope: rootCardEl });
    expect(graphEl).toBeTruthy();
    const renderedTripleCount = Number(graphEl!.getAttribute('data-triple-count') ?? 'NaN');
    // Pre-sweep this would have rendered 5000 (the dominant
    // subject's full row count, since `keep.has(subject)`
    // returned every row from the filter). Post-sweep the
    // pre-check halts the loop before adding the dominant
    // subject (degree 5000 > MAX_PER_CARD), so the keep set
    // would normally be empty — but the residual fallback
    // (`if (keep.size === 0 && order.length > 0) keep.add(order[0])`)
    // admits that single dominant subject so the card still
    // shows the hub, and the post-filter `slice(0, MAX_PER_CARD)`
    // trims its long tail. Net: cap is HONORED and the user
    // sees the dominant cluster instead of an empty card.
    expect(renderedTripleCount).toBeLessThanOrEqual(2500); // MAX_PER_CARD
    expect(renderedTripleCount).toBeGreaterThan(0);         // not degraded to empty
    // And `tripleCount` stat still reports the true pre-cap
    // total — the cap affects only the rendered mini-graph
    // slice, not the user-visible distinct count.
    const stats = rootCardEl.querySelector('.v10-sgov-card-stats')?.textContent ?? '';
    expect(stats).toContain('5000 triples');
  });

  it('Named card cap honors MAX_PER_CARD even with a single dominant subject (Codex sweep 2, parity fix)', async () => {
    // PR #818 sweep 2 — same defect exists in the named-card
    // path at the original `triplesBySubGraph` sampling (Root
    // inherited the pattern from there). Fix is applied at both
    // sites so the named-card path stops smuggling dominant
    // clusters through too. This test locks the named-card path
    // independently of the Root card.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 5000, description: '' }],
    });
    const entityList = [
      // One named-subgraph entity that's the dominant subject.
      { uri: 'urn:e:dominant', label: 'd', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    const triples = [];
    for (let i = 0; i < 5000; i++) {
      // Tag with sub-graph 'alpha' so the named-card bucket
      // path at `triplesBySubGraph` picks them up. Use literal
      // objects so `filterTriplesToEntities` (applied to the
      // bucket on the named-card render path at `:4084`) admits
      // them — resource-object edges would otherwise be dropped
      // because `urn:e:obj-N` isn't in the entityUris set.
      triples.push({ subject: 'urn:e:dominant', predicate: 'p', object: `"v-${i}"`, subGraph: 'alpha', layer: 'working' });
    }
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 1, swm: 0, vm: 0, total: 1 },
    });
    await flush();

    // First card is the named alpha card; Root card is last.
    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    // PR #818 sweep 3 — wait for Suspense resolution before
    // reading the data attribute so isolated runs don't race
    // the lazy import.
    const graphEl = await waitForGraph(container, { scope: alphaCardEl });
    expect(graphEl).toBeTruthy();
    const renderedTripleCount = Number(graphEl!.getAttribute('data-triple-count') ?? 'NaN');
    // Pre-sweep: 5000 rows leaked through. Post-sweep: cap is
    // honored, and the residual fallback keeps the dominant
    // subject visible (same trade-off as the Root card test
    // above).
    expect(renderedTripleCount).toBeLessThanOrEqual(2500); // MAX_PER_CARD
    expect(renderedTripleCount).toBeGreaterThan(0);         // dominant hub still renders
  });

  it('Root card cap densely-packs the available capacity instead of under-filling on a non-fitting subject (Codex sweep 3)', async () => {
    // PR #818 sweep 3 — sweep-2 used `break` on a non-fitting
    // subject, which under-filled the cap when smaller satellites
    // would still have fit. Fixture: degrees `[2400, 200, 50, 50]`
    // with MAX_PER_CARD = 2500.
    //   • `break` shape: admit 2400 → reject 200 (kept+200 > 2500)
    //     → stop. Rendered = 2400 (100 headroom unused).
    //   • `continue` shape: admit 2400 → skip 200 → admit 50 →
    //     admit 50. Rendered = 2500 (dense pack at the cap).
    // The dense-pack outcome is the friendlier user-facing
    // result.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 1, tripleCount: 0, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:alpha', label: 'a', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:r-2400', label: 'r1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
      { uri: 'urn:e:r-200', label: 'r2', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
      { uri: 'urn:e:r-50a', label: 'r3', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
      { uri: 'urn:e:r-50b', label: 'r4', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set<string>(), properties: new Map(), connections: [] },
    ];
    const triples = [];
    // PR #818 sweep 6 — literal objects so AND-membership admits
    // them past `filterTriplesToEntities` (this test exercises
    // dense-pack cap behavior, not endpoint admission).
    for (let i = 0; i < 2400; i++) triples.push({ subject: 'urn:e:r-2400', predicate: 'p', object: `"v-2400-${i}"`, layer: 'working' });
    for (let i = 0; i < 200; i++) triples.push({ subject: 'urn:e:r-200', predicate: 'p', object: `"v-200-${i}"`, layer: 'working' });
    for (let i = 0; i < 50; i++) triples.push({ subject: 'urn:e:r-50a', predicate: 'p', object: `"v-50a-${i}"`, layer: 'working' });
    for (let i = 0; i < 50; i++) triples.push({ subject: 'urn:e:r-50b', predicate: 'p', object: `"v-50b-${i}"`, layer: 'working' });
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 5, swm: 0, vm: 0, total: 5 },
    });
    await flush();

    const cards = container.querySelectorAll('.v10-sgov-card');
    const rootCardEl = cards[cards.length - 1];
    const graphEl = await waitForGraph(container, { scope: rootCardEl });
    expect(graphEl).toBeTruthy();
    const renderedTripleCount = Number(graphEl!.getAttribute('data-triple-count') ?? 'NaN');
    // Dense pack: 2400 + 50 + 50 = 2500 (continue skips the 200
    // that wouldn't fit). The `break` shape would have rendered
    // 2400 (skipping the satellites that fit). Floor at 2450
    // catches the 2400 under-fill defect while permitting minor
    // sampling variance in future tweaks.
    expect(renderedTripleCount).toBeLessThanOrEqual(2500); // MAX_PER_CARD
    expect(renderedTripleCount).toBeGreaterThanOrEqual(2450); // dense pack
  });

  it('Named card cap densely-packs the available capacity (Codex sweep 3, parity)', async () => {
    // PR #818 sweep 3 — same defect on the named-card sampling at
    // `:3935-3953`. Same `[2400, 200, 50, 50]` fixture shape,
    // tagged into a single sub-graph, with literal objects so
    // `filterTriplesToEntities` doesn't drop the resource-edge
    // rows.
    fetchSubGraphsMock.mockResolvedValueOnce({
      subGraphs: [{ name: 'alpha', entityCount: 4, tripleCount: 2700, description: '' }],
    });
    const entityList = [
      { uri: 'urn:e:a-2400', label: 'a1', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:a-200', label: 'a2', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:a-50a', label: 'a3', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
      { uri: 'urn:e:a-50b', label: 'a4', types: [], trustLevel: 'working', layers: new Set(['working']), subGraphs: new Set(['alpha']), properties: new Map(), connections: [] },
    ];
    const triples = [];
    for (let i = 0; i < 2400; i++) triples.push({ subject: 'urn:e:a-2400', predicate: 'p', object: `"v-2400-${i}"`, subGraph: 'alpha', layer: 'working' });
    for (let i = 0; i < 200; i++) triples.push({ subject: 'urn:e:a-200', predicate: 'p', object: `"v-200-${i}"`, subGraph: 'alpha', layer: 'working' });
    for (let i = 0; i < 50; i++) triples.push({ subject: 'urn:e:a-50a', predicate: 'p', object: `"v-50a-${i}"`, subGraph: 'alpha', layer: 'working' });
    for (let i = 0; i < 50; i++) triples.push({ subject: 'urn:e:a-50b', predicate: 'p', object: `"v-50b-${i}"`, subGraph: 'alpha', layer: 'working' });
    await renderWith({
      ...memory,
      entities: new Map(entityList.map(e => [e.uri, e])),
      entityList,
      allTriples: triples,
      counts: { wm: 4, swm: 0, vm: 0, total: 4 },
    });
    await flush();

    // First card is the named alpha card.
    const cards = container.querySelectorAll('.v10-sgov-card');
    const alphaCardEl = cards[0];
    const graphEl = await waitForGraph(container, { scope: alphaCardEl });
    expect(graphEl).toBeTruthy();
    const renderedTripleCount = Number(graphEl!.getAttribute('data-triple-count') ?? 'NaN');
    expect(renderedTripleCount).toBeLessThanOrEqual(2500); // MAX_PER_CARD
    expect(renderedTripleCount).toBeGreaterThanOrEqual(2450); // dense pack
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
