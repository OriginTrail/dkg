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

  it('without `layer`: falls back to daemon entityCount totals (Overview / Subgraphs path)', async () => {
    // entities is provided but `layer` is omitted — chip counts come
    // from the daemon's per-sub-graph entityCount (3 each here),
    // regardless of how many entities are passed.
    const entities = [
      mkEntity('urn:1', 'working', 'alpha'),
      mkEntity('urn:2', 'shared', 'alpha'),
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
});
