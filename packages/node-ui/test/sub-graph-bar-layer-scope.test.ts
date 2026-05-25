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
});
