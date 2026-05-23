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
    RdfGraph() {
      return React.createElement('div', { 'data-testid': 'rdf-graph' });
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
});
