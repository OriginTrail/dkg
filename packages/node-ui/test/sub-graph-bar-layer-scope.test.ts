// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock the daemon /api/sub-graph/list endpoint with a deterministic
// two-sub-graph response. Both report a project-wide entityCount of 3.
vi.mock('../src/ui/api.js', () => ({
  fetchSubGraphs: vi.fn(async () => ({
    subGraphs: [
      { name: 'alpha', entityCount: 3, tripleCount: 9, description: 'Alpha' },
      { name: 'beta', entityCount: 3, tripleCount: 9, description: 'Beta' },
    ],
  })),
}));

// Mock the live-update channel so the bar doesn't try to open an
// EventSource — happy-dom doesn't ship one.
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({
  useMemoryGraphEvents: () => {},
}));

import { SubGraphBar } from '../src/ui/components/SubGraphBar.js';
import type { ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';

const profile: ProjectProfile = {
  contextGraphId: 'cg',
  displayName: 'cg',
  primaryColor: '#000',
  accentColor: '#000',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: (slug: string) => ({ slug, displayName: slug, color: '#000', icon: '#', rank: 0 }),
  forType: () => undefined,
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

const mkEntity = (uri: string, trust: 'working' | 'shared' | 'verified', subGraph: string) => ({
  uri,
  label: uri,
  types: [],
  trustLevel: trust,
  layers: new Set([trust]),
  subGraphs: new Set([subGraph]),
  properties: new Map(),
  connections: [],
});

async function flushNet() {
  // Pump microtasks twice — once for the fetchSubGraphs promise,
  // once for the setState that follows.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('SubGraphBar — layer-scoped chip counts (P4)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function chipCount(label: string): number {
    const chips = Array.from(container.querySelectorAll('button.v10-subgraph-chip')) as HTMLButtonElement[];
    const chip = chips.find(b => (b.textContent ?? '').includes(label));
    const countSpan = chip?.querySelector('.v10-subgraph-chip-count');
    return Number(countSpan?.textContent ?? 'NaN');
  }

  it('without `layer`: distinct-counts entities per sub-graph across all layers (Issue B — sub-graph page chip row)', async () => {
    // Issue B: the daemon's `/api/sub-graph/list` `entityCount`
    // double-counts entities that live in two or more sub-graphs
    // (e.g. one entity in {alpha, beta} contributes 1 to alpha AND
    // 1 to beta, so summing reports 2). On the sub-graph page the
    // pyramid header sums across layers and matches the entity list;
    // the chip row used to disagree because it surfaced the daemon
    // total. Now SubGraphBar derives the count locally from the
    // passed entities — distinct per (entity, sub-graph) membership.
    const entities = [
      mkEntity('urn:1', 'working', 'alpha'),
      mkEntity('urn:2', 'shared', 'alpha'),
      // Note: daemon mock at the top of the file reports
      // alpha.entityCount=3 / beta.entityCount=3, but only 2
      // alpha entities and 0 beta entities are in the local list.
      // The local distinct-count is the source of truth (matches the
      // entity list below the chip row).
    ];
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities,
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(2);
    expect(chipCount('beta')).toBe(0);
  });

  it('without `layer` + no `entities`: falls back to daemon entityCount totals (defensive)', async () => {
    // Defensive case: the standalone caller pattern that omits
    // entities still falls back to the daemon's `entityCount`.
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(3);
    expect(chipCount('beta')).toBe(3);
  });

  it('with `layer="wm"`: counts entities whose canonical trustLevel matches the layer (per-sub-graph)', async () => {
    // alpha has 1 WM-only entity (`urn:wm-a`) + 1 promoted-to-SWM
    // entity. beta has 1 SWM-only entity. WM-scoped: alpha=1, beta=0.
    const entities = [
      mkEntity('urn:wm-a', 'working', 'alpha'),
      mkEntity('urn:promoted-a', 'shared', 'alpha'),
      mkEntity('urn:swm-b', 'shared', 'beta'),
    ];
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities,
        layer: 'wm',
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(1);
    expect(chipCount('beta')).toBe(0);
    // The "All" chip sums layer-scoped counts.
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All'));
    const allCount = Number(allChip?.querySelector('.v10-subgraph-chip-count')?.textContent ?? 'NaN');
    expect(allCount).toBe(1);
  });

  it('with `layer="swm"`: per-sub-graph SWM-only counts', async () => {
    const entities = [
      mkEntity('urn:wm-a', 'working', 'alpha'),
      mkEntity('urn:promoted-a', 'shared', 'alpha'),
      mkEntity('urn:swm-b', 'shared', 'beta'),
    ];
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities,
        layer: 'swm',
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(1);
    expect(chipCount('beta')).toBe(1);
  });

  // R2-5 regression: the "All" chip's `totalEntities` used to sum
  // `merged[].entityCount`, which double-counted entities living in
  // two or more sub-graphs (each sub-graph's `entityCount` includes
  // them). The WM/SWM/VM list under us is trustLevel-filtered without
  // sub-graph multiplicity, so the sum disagreed with the list —
  // undoing what P3/P4 set out to align. Distinct-count by entity URI
  // for the "All" total in layer mode.
  it('with `layer`: the "All" chip total does not double-count entities living in multiple sub-graphs (R2-5)', async () => {
    // One WM-only entity belongs to BOTH alpha AND beta. Per-sub-graph
    // chips correctly count it in both (1 + 1 = 2 via summing). The
    // "All" total must remain 1 (one distinct entity in the layer).
    const crossSubGraph = {
      uri: 'urn:e:cross',
      label: 'cross',
      types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set(['alpha', 'beta']),
      properties: new Map(),
      connections: [],
    };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [crossSubGraph],
        layer: 'wm',
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(1);
    expect(chipCount('beta')).toBe(1);
    // Pre-R2-5 the "All" total summed per-sub-graph counts → 2.
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All'));
    const allCount = Number(allChip?.querySelector('.v10-subgraph-chip-count')?.textContent ?? 'NaN');
    expect(allCount).toBe(1);
  });

  // Root-bucket regression: SWM entities whose graph URI is
  // `<cg>/_shared_memory` (the root SWM bucket) surface with an empty
  // `subGraphs` set — `subGraphOf` in useMemoryEntities.ts filters
  // underscore-prefixed segments, leaving no slug. Pre-fix the "All"
  // chip excluded those entities via a `subGraphs.size === 0` skip,
  // so it undercounted vs the layer tab badge (e.g. tab 27 / All 25
  // when 2 root-bucket SWM entities existed). They still belong to
  // the layer and must count toward the umbrella.
  it('with `layer`: the "All" chip total includes entities with no named sub-graph membership (matches layer tab badge)', async () => {
    const rootEntity = (uri: string): any => ({
      uri, label: uri, types: [],
      trustLevel: 'shared' as const,
      layers: new Set(['shared']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    });
    const entities = [
      mkEntity('urn:swm-alpha', 'shared', 'alpha'),
      rootEntity('urn:swm-root-1'),
      rootEntity('urn:swm-root-2'),
    ];
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities,
        layer: 'swm',
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(1);  // per-sub-graph unchanged
    // All counts every SWM entity, including the two root-bucket
    // entities with no named sub-graph membership. Pre-fix: 1.
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All'));
    const allCount = Number(allChip?.querySelector('.v10-subgraph-chip-count')?.textContent ?? 'NaN');
    expect(allCount).toBe(3);
  });

  // Layer-agnostic counterpart of the previous case: on the sub-graph
  // page `ProjectView` passes `entities` without `layer`, and "All"
  // represents the umbrella over named-sub-graph chips. Entities with
  // no chip membership (root-bucket SWM entities, empty `subGraphs`)
  // must STAY excluded here — including them would inflate the total
  // past anything the user can reach by clicking a chip.
  it('without `layer`: the "All" chip total excludes entities with no named sub-graph membership (umbrella over chips)', async () => {
    const rootEntity = (uri: string, trust: 'working' | 'shared' | 'verified'): any => ({
      uri, label: uri, types: [],
      trustLevel: trust,
      layers: new Set([trust]),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    });
    const entities = [
      mkEntity('urn:e:alpha', 'shared', 'alpha'),
      mkEntity('urn:e:beta', 'shared', 'beta'),
      rootEntity('urn:e:root-1', 'shared'),
      rootEntity('urn:e:root-2', 'working'),
    ];
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities,
        // intentionally no `layer` — sub-graph page semantic
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(1);
    expect(chipCount('beta')).toBe(1);
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All'));
    const allCount = Number(allChip?.querySelector('.v10-subgraph-chip-count')?.textContent ?? 'NaN');
    // 2 chip-reachable entities (alpha, beta). Root entities excluded.
    expect(allCount).toBe(2);
  });

  // Issue B regression — sub-graph page chip row in layer-agnostic mode.
  // User repro: SWM tab + sub-graph 'ui-epcis' open → chip row shows
  // "All 27 / ui-epcis 27" while the entity list shows 11. The "27"
  // is the daemon's `/api/sub-graph/list` `entityCount`, which counts
  // entities once per sub-graph membership (so a cross-sub-graph
  // entity is double-counted). On the sub-graph page the pyramid
  // header sums across layers and matches the entity list — the
  // chip row should agree. Now SubGraphBar derives counts locally
  // from the passed entities, distinct per (entity, sub-graph)
  // membership.
  it('without `layer`: per-sub-graph chip count matches the entity-list count (Issue B)', async () => {
    // 11 distinct entities in 'alpha' (matching the user's 11). One
    // of them ALSO belongs to 'beta'. The daemon mock at the top of
    // the file says alpha.entityCount=3 / beta.entityCount=3 — those
    // numbers no longer leak into chip counts when entities is given.
    const entities: any[] = [];
    for (let i = 0; i < 10; i++) {
      entities.push(mkEntity(`urn:e:alpha-${i}`, i < 4 ? 'working' : i < 9 ? 'shared' : 'verified', 'alpha'));
    }
    entities.push({
      uri: 'urn:e:cross',
      label: 'cross',
      types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set(['alpha', 'beta']),
      properties: new Map(),
      connections: [],
    });
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: 'alpha',
        onSelect: vi.fn(),
        entities,
      }));
    });
    await flushNet();
    expect(chipCount('alpha')).toBe(11); // matches what the entity list shows
    expect(chipCount('beta')).toBe(1);
    // The "All" total must be 11 distinct entities, not the
    // double-counted sum (11 + 1 = 12) and not the daemon
    // project-wide total (6 from the mock).
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All'));
    const allCount = Number(allChip?.querySelector('.v10-subgraph-chip-count')?.textContent ?? 'NaN');
    expect(allCount).toBe(11);
  });

  // S3 — Root chip rendering. Surfaces only when the consumer
  // supplies `entities` AND at least one entity is in the root
  // bucket (no sub-graph membership). On Overview / Subgraphs
  // pages the bar has no entities prop, so the chip stays hidden
  // (we can't tell whether root entities exist without the list).
  it('renders the Root chip when at least one entity has no subGraph membership', async () => {
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    const namedEntity = mkEntity('urn:e:named', 'shared', 'alpha');
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [rootEntity, namedEntity],
      }));
    });
    await flushNet();
    // Root chip is present and reports the single root-bucket
    // entity. Symbol from §4.4.1 is `⊘` (U+2298).
    const rootChip = container.querySelector('.v10-subgraph-chip-root') as HTMLButtonElement | null;
    expect(rootChip).toBeTruthy();
    expect(rootChip!.textContent).toContain('Root');
    expect(rootChip!.querySelector('.v10-subgraph-chip-count')?.textContent).toBe('1');
  });

  it('hides the Root chip when every supplied entity has a sub-graph membership', async () => {
    const a = mkEntity('urn:a', 'working', 'alpha');
    const b = mkEntity('urn:b', 'working', 'beta');
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [a, b],
      }));
    });
    await flushNet();
    expect(container.querySelector('.v10-subgraph-chip-root')).toBeNull();
  });

  it('Root chip click calls onSelect with ROOT_SLUG_SENTINEL', async () => {
    const onSelect = vi.fn();
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect,
        entities: [rootEntity, mkEntity('urn:e:named', 'shared', 'alpha')],
      }));
    });
    await flushNet();
    const { ROOT_SLUG_SENTINEL } = await import('../src/ui/lib/subGraphs.js');
    const rootChip = container.querySelector('.v10-subgraph-chip-root') as HTMLButtonElement;
    await act(async () => { rootChip.click(); });
    // #9 polish — the second arg carries the originating layer; on
    // this Overview-shaped mount (no `layer` prop) it's undefined.
    expect(onSelect).toHaveBeenCalledWith(ROOT_SLUG_SENTINEL, undefined);
  });

  // S3 Codex follow-up (Issue B on PR #772). The Root chip must stay
  // visible whenever Root is the selected scope, even after a live
  // refresh drops the root-bucket count to 0 (e.g. the last root
  // entity got scoped to a sub-graph). Pre-fix the chip vanished and
  // the detail body kept Root scope with no matching active chip in
  // the row — a confusing UI state.
  it('keeps the Root chip visible (and active) when ROOT_SLUG_SENTINEL is selected even after the root count drops to 0', async () => {
    const { ROOT_SLUG_SENTINEL } = await import('../src/ui/lib/subGraphs.js');
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    // Initial render: one root entity, Root selected.
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: ROOT_SLUG_SENTINEL,
        onSelect: vi.fn(),
        entities: [rootEntity, mkEntity('urn:e:named', 'shared', 'alpha')],
      }));
    });
    await flushNet();
    {
      const chip = container.querySelector('.v10-subgraph-chip-root') as HTMLElement | null;
      expect(chip).toBeTruthy();
      expect(chip!.getAttribute('data-active')).toBe('true');
      expect(chip!.getAttribute('data-count')).toBe('1');
    }
    // Live-refresh: the previously-root entity has been scoped to
    // `alpha`. The root-bucket count drops to 0, but the user is
    // still in Root scope (selected stays ROOT_SLUG_SENTINEL).
    const movedEntity = { ...rootEntity, subGraphs: new Set(['alpha']) };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: ROOT_SLUG_SENTINEL,
        onSelect: vi.fn(),
        entities: [movedEntity, mkEntity('urn:e:named', 'shared', 'alpha')],
      }));
    });
    await flushNet();
    const chip = container.querySelector('.v10-subgraph-chip-root') as HTMLElement | null;
    expect(chip).toBeTruthy();
    // Still active (selected hasn't changed) and now reads 0.
    expect(chip!.getAttribute('data-active')).toBe('true');
    expect(chip!.getAttribute('data-count')).toBe('0');
  });

  // S3 polish #7 — `All = Root + subgraphs` inline arithmetic
  // hint + extended tooltip on the All chip (ux-locked).
  // `MemoryEntity.subGraphs` is a Set, so the All count is a
  // distinct total — cross-membership entities count once in
  // All but may appear under multiple chip totals. The hint
  // surfaces that math without changing the canonical All
  // semantics.
  it('renders the "All = Root + subgraphs" inline hint when Root is visible AND in layer mode', async () => {
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [rootEntity, mkEntity('urn:e:named', 'working', 'alpha')],
        layer: 'wm',
      }));
    });
    await flushNet();

    const hint = container.querySelector('.v10-subgraph-bar-hint');
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain('All = Root + subgraphs');
  });

  it('does NOT render the "All = Root + subgraphs" hint when there is no Root chip', async () => {
    // No root-bucket entities — Root chip is hidden, and so is
    // the hint (since the hint references a chip that's not on
    // screen).
    const a = mkEntity('urn:a', 'working', 'alpha');
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [a],
        layer: 'wm',
      }));
    });
    await flushNet();

    expect(container.querySelector('.v10-subgraph-bar-hint')).toBeNull();
  });

  // PR #793 Codex sweep 1 — the `entityScopedAllTotal` math at
  // SubGraphBar.tsx:139 EXCLUDES root-bucket entities in layer-
  // agnostic mode (the Subgraph Explorer overview). The All-chip
  // tooltip / aria-label and the "All = Root + subgraphs" hint
  // would silently contradict that math; both must mode-branch.
  it('does NOT render the "All = Root + subgraphs" hint in layer-agnostic mode (Codex sweep 1)', async () => {
    // Root entity present (would normally show the chip + hint
    // in layer mode), but the bar is mounted WITHOUT a `layer`
    // prop — Subgraph Explorer overview shape. All excludes
    // Root by design; the hint must hide.
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'working' as const,
      layers: new Set(['working']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        entities: [rootEntity, mkEntity('urn:e:named', 'shared', 'alpha')],
        /* no layer prop → layer-agnostic */
      }));
    });
    await flushNet();

    // Root chip itself stays visible (the chip-visibility gate
    // doesn't depend on layer mode); only the hint is gated.
    expect(container.querySelector('.v10-subgraph-chip-root')).toBeTruthy();
    expect(container.querySelector('.v10-subgraph-bar-hint')).toBeNull();
  });

  it('extends the All chip tooltip in layer mode with the cross-membership clarification (includes Root)', async () => {
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        layer: 'wm',
      }));
    });
    await flushNet();
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All')) as HTMLButtonElement;
    expect(allChip).toBeTruthy();
    const title = allChip.getAttribute('title') ?? '';
    const aria = allChip.getAttribute('aria-label') ?? '';
    expect(title).toContain('Total entities');
    expect(title).toContain('some may belong to more than one');
    expect(title).toContain('plus Root entities not in any subgraph');
    expect(aria).toContain('plus Root entities not in any subgraph');
    // Must NOT carry the layer-agnostic phrasing.
    expect(title).not.toContain('counted separately');
  });

  it('uses the layer-agnostic All chip tooltip in overview mode (Codex sweep 1 — Root counted separately)', async () => {
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect: vi.fn(),
        /* no layer prop → layer-agnostic */
      }));
    });
    await flushNet();
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All')) as HTMLButtonElement;
    expect(allChip).toBeTruthy();
    const title = allChip.getAttribute('title') ?? '';
    const aria = allChip.getAttribute('aria-label') ?? '';
    expect(title).toContain('Total entities in named subgraphs');
    expect(title).toContain('counted separately on the Root chip');
    expect(aria).toContain('counted separately on the Root chip');
    // Must NOT carry the layer-mode phrasing that includes Root.
    expect(title).not.toContain('plus Root entities not in any subgraph');
  });

  // S3 polish #9 — when SubGraphBar is mounted on a WM/SWM/VM
  // page (the `layer` prop is set) and the user clicks a chip,
  // `onSelect` carries the originating layer as the second arg
  // so the detail view can seed `enabledLayers` to that layer
  // (§4.4.1 fold-in #4). On the Subgraphs / Overview mount the
  // bar has no `layer` prop and the second arg stays undefined.
  it('forwards the bar `layer` prop as originatingLayer when a named chip is clicked', async () => {
    const onSelect = vi.fn();
    const wmEntity = mkEntity('urn:e:wm-a', 'working', 'alpha');
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect,
        entities: [wmEntity],
        layer: 'wm',
      }));
    });
    await flushNet();

    const alphaChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('alpha')) as HTMLButtonElement;
    expect(alphaChip).toBeTruthy();
    await act(async () => { alphaChip.click(); });
    expect(onSelect).toHaveBeenCalledWith('alpha', 'wm');
  });

  it('forwards the bar `layer` prop as originatingLayer when the Root chip is clicked', async () => {
    const onSelect = vi.fn();
    const rootEntity = {
      uri: 'urn:e:root', label: 'Root', types: [],
      trustLevel: 'shared' as const,
      layers: new Set(['shared']),
      subGraphs: new Set<string>(),
      properties: new Map(),
      connections: [],
    };
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: null,
        onSelect,
        entities: [rootEntity, mkEntity('urn:e:named', 'shared', 'alpha')],
        layer: 'swm',
      }));
    });
    await flushNet();

    const { ROOT_SLUG_SENTINEL } = await import('../src/ui/lib/subGraphs.js');
    const rootChip = container.querySelector('.v10-subgraph-chip-root') as HTMLButtonElement;
    await act(async () => { rootChip.click(); });
    expect(onSelect).toHaveBeenCalledWith(ROOT_SLUG_SENTINEL, 'swm');
  });

  it('All chip click clears the originating-layer carry (passes undefined)', async () => {
    // Selecting "All" exits the sub-graph page entirely — the
    // bar passes undefined so any prior originating-layer scope
    // is cleared.
    const onSelect = vi.fn();
    await act(async () => {
      root.render(React.createElement(SubGraphBar, {
        contextGraphId: 'cg',
        profile,
        selected: 'alpha',
        onSelect,
        layer: 'wm',
      }));
    });
    await flushNet();
    const allChip = Array.from(container.querySelectorAll('button.v10-subgraph-chip'))
      .find(b => b.textContent?.includes('All')) as HTMLButtonElement;
    await act(async () => { allChip.click(); });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
