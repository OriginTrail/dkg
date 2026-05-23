// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createEntities() {
  return new Map([
    ['urn:entity:working', {
      uri: 'urn:entity:working',
      label: 'Working entity',
      types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [],
    }],
    ['urn:entity:demo', {
      uri: 'urn:entity:demo',
      label: 'Demo entity',
      types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['demo']),
      properties: new Map(),
      connections: [{ predicate: 'related', targetUri: 'urn:entity:other', targetLabel: 'Other entity' }],
    }],
    ['urn:entity:other', {
      uri: 'urn:entity:other',
      label: 'Other entity',
      types: [],
      trustLevel: 'working',
      layers: new Set(['working']),
      subGraphs: new Set(['other']),
      properties: new Map(),
      connections: [],
    }],
  ]);
}

const memory = {
  entities: createEntities(),
  entityList: [] as any[],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 2, swm: 0, vm: 0, total: 2 },
  loading: false,
  error: null,
  partial: false,
  refresh: vi.fn(),
};

function resetMemory() {
  memory.entities = createEntities();
  memory.entityList = [...memory.entities.values()];
}
resetMemory();

const profile = {
  primaryColor: '#64748b',
  forSubGraph: (slug: string) => ({ slug, displayName: slug, color: '#38bdf8', icon: '#', description: '' }),
};

const agentsData = {
  agents: new Map(),
  list: [],
  loading: false,
  get: () => undefined,
  openAgent: vi.fn(),
};

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchContextGraphs: vi.fn(async () => ({
      contextGraphs: [{ id: 'cg-test', name: 'Context Graph Test' }],
    })),
  },
}));

vi.mock('../src/ui/api.js', () => ({
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
}));

vi.mock('../src/ui/hooks/useMemoryEntities.js', () => ({
  useMemoryEntities: () => memory,
}));

vi.mock('../src/ui/hooks/useProjectProfile.js', () => ({
  ProjectProfileContext: React.createContext(profile),
  useProjectProfile: () => profile,
}));

vi.mock('../src/ui/hooks/useAgents.js', () => ({
  AgentsContext: React.createContext(agentsData),
  useAgents: () => agentsData,
}));

vi.mock('../src/ui/stores/tabs.js', () => ({
  useTabsStore: () => vi.fn(),
}));

vi.mock('../src/ui/components/Modals/ImportFilesModal.js', () => ({
  ImportFilesModal: () => null,
}));

vi.mock('../src/ui/components/Modals/ShareProjectModal.js', () => ({
  ShareProjectModal: () => null,
}));

vi.mock('../src/ui/components/ActivityFeed.js', () => ({
  ActivityFeed: ({ onSelectEntity }: { onSelectEntity: (uri: string) => void }) =>
    React.createElement('button', {
      'data-testid': 'open-activity-entity',
      onClick: () => onSelectEntity('urn:entity:working'),
    }, 'Open activity entity'),
}));

vi.mock('../src/ui/components/SubGraphBar.js', () => ({
  SubGraphBar: ({ selected, onSelect }: { selected: string | null; onSelect: (slug: string | null) => void }) =>
    React.createElement('div', { 'data-testid': 'subgraph-bar', 'data-selected': selected ?? '' },
      React.createElement('button', { 'data-testid': 'select-subgraph-demo', onClick: () => onSelect('demo') }, 'demo'),
      React.createElement('button', { 'data-testid': 'clear-subgraph', onClick: () => onSelect(null) }, 'all')),
}));

vi.mock('../src/ui/views/project/components.js', () => ({
  ProjectHeaderStrip: ({ activeSubGraph }: { activeSubGraph: any }) =>
    React.createElement('div', { 'data-testid': 'active-subgraph' }, activeSubGraph?.slug ?? 'none'),
  LayerSwitcher: ({ active, onSwitch }: { active: string; onSwitch: (layer: string) => void }) =>
    React.createElement('div', { 'data-testid': 'active-layer', 'data-layer': active },
      React.createElement('button', { 'data-testid': 'switch-wm', onClick: () => onSwitch('wm') }, 'WM'),
      React.createElement('button', { 'data-testid': 'switch-swm', onClick: () => onSwitch('swm') }, 'SWM')),
  KADetailView: ({ entity, onNavigate, onClose }: { entity: any; onNavigate: (uri: string) => void; onClose: () => void }) =>
    React.createElement('section', { 'data-testid': 'entity-detail', 'data-entity': entity.uri },
      React.createElement('div', {}, entity.label),
      React.createElement('button', { 'data-testid': 'open-related-entity', onClick: () => onNavigate('urn:entity:other') }, 'Open related'),
      React.createElement('button', { 'data-testid': 'detail-back', onClick: onClose }, 'Back to Context Graph')),
  SubGraphDetailView: ({ slug, activeTab = 'items', onTabChange, onSelectEntity }: {
    slug: string;
    activeTab?: string;
    onTabChange: (tab: string) => void;
    onSelectEntity: (uri: string) => void;
  }) =>
    React.createElement('section', { 'data-testid': 'subgraph-detail', 'data-slug': slug, 'data-tab': activeTab },
      React.createElement('button', { 'data-testid': 'subgraph-tab-graph', onClick: () => onTabChange('graph') }, 'Graph'),
      React.createElement('div', { 'data-testid': 'subgraph-scroll', 'data-cg-scroll-key': `subgraph:${slug}:${activeTab}` },
        React.createElement('button', { 'data-testid': 'open-subgraph-entity', onClick: () => onSelectEntity('urn:entity:demo') }, 'Open demo entity'))),
  ProjectOverviewCard: () => React.createElement('div', {}, 'Overview'),
  PendingJoinRequestsBar: () => null,
  MemoryStrip: ({ expandedLayer, onExpandedLayerChange, expandTabs, onExpandTabChange, onSelectEntity }: {
    expandedLayer: 'wm' | 'swm' | 'vm' | null;
    onExpandedLayerChange: (layer: 'wm' | 'swm' | 'vm' | null) => void;
    expandTabs: Record<'wm' | 'swm' | 'vm', string>;
    onExpandTabChange: (layer: 'wm' | 'swm' | 'vm', tab: string) => void;
    onSelectEntity: (uri: string) => void;
  }) => {
    const activeTab = expandedLayer ? expandTabs[expandedLayer] : 'items';
    return React.createElement('section', {
      'data-testid': 'memory-strip',
      'data-expanded': expandedLayer ?? '',
      'data-tab': activeTab,
    },
      React.createElement('button', {
        'data-testid': 'expand-strip-swm',
        onClick: () => onExpandedLayerChange(expandedLayer === 'swm' ? null : 'swm'),
      }, 'Expand SWM'),
      expandedLayer && React.createElement(React.Fragment, {},
        React.createElement('button', {
          'data-testid': 'strip-tab-graph',
          onClick: () => onExpandTabChange(expandedLayer, 'graph'),
        }, 'Graph'),
        React.createElement('div', {
          'data-testid': 'strip-scroll',
          'data-cg-scroll-key': `layer:${expandedLayer}:${activeTab}`,
        },
          React.createElement('button', {
            'data-testid': 'open-strip-entity',
            onClick: () => onSelectEntity('urn:entity:working'),
          }, 'Open strip entity'))));
  },
  SubGraphOverviewGrid: () => null,
  ContextGraphQueryView: () => null,
  LayerDetailView: ({ layer, activeTab, onTabChange, onSelectEntity }: {
    layer: string;
    activeTab: string;
    onTabChange: (tab: string) => void;
    onSelectEntity: (uri: string) => void;
  }) =>
    React.createElement('section', { 'data-testid': 'layer-detail', 'data-layer': layer, 'data-tab': activeTab },
      React.createElement('button', { 'data-testid': 'layer-tab-graph', onClick: () => onTabChange('graph') }, 'Graph'),
      React.createElement('div', { 'data-testid': 'layer-scroll', 'data-cg-scroll-key': `layer:${layer}:${activeTab}` },
        React.createElement('button', { 'data-testid': 'open-layer-entity', onClick: () => onSelectEntity('urn:entity:working') }, 'Open layer entity'))),
  ProvenanceBar: () => null,
}));

const { ProjectView } = await import('../src/ui/views/ProjectView.js');

function query(testId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`Missing test element ${testId}`);
  return el;
}

function scrollRoot(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cg-scroll-key="${key}"]`);
  if (!el) throw new Error(`Missing scroll root ${key}`);
  return el;
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    query(testId).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('ProjectView entity detail navigation', () => {
  let root: Root;
  let originalRaf: typeof window.requestAnimationFrame;

  beforeEach(async () => {
    resetMemory();
    document.body.innerHTML = '<div id="root"></div>';
    originalRaf = window.requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    });
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: originalRaf,
    });
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('restores layer, subtab, and scroll when entity detail closes', async () => {
    await click('switch-swm');
    await click('layer-tab-graph');

    const scroller = query('layer-scroll');
    scroller.scrollTop = 86;

    await click('open-layer-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:working');

    await click('detail-back');
    await flush();

    expect(query('active-layer').dataset.layer).toBe('swm');
    expect(query('layer-detail').dataset.tab).toBe('graph');
    expect(query('layer-scroll').scrollTop).toBe(86);
  });

  it('restores overview strip expansion, subtab, and scroll when entity detail closes', async () => {
    await click('expand-strip-swm');
    await click('strip-tab-graph');

    const scroller = query('strip-scroll');
    scroller.scrollTop = 64;

    await click('open-strip-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:working');

    await click('detail-back');
    await flush();

    expect(query('active-layer').dataset.layer).toBe('overview');
    expect(query('memory-strip').dataset.expanded).toBe('swm');
    expect(query('memory-strip').dataset.tab).toBe('graph');
    expect(query('strip-scroll').scrollTop).toBe(64);
  });

  it('restores page scroll when overview activity opens while the strip is expanded', async () => {
    await click('expand-strip-swm');
    await click('strip-tab-graph');

    const pageScroller = scrollRoot('page');
    const stripScroller = query('strip-scroll');
    pageScroller.scrollTop = 140;
    stripScroller.scrollTop = 32;

    await click('open-activity-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:working');

    pageScroller.scrollTop = 0;

    await click('detail-back');
    await flush();

    expect(query('active-layer').dataset.layer).toBe('overview');
    expect(query('memory-strip').dataset.expanded).toBe('swm');
    expect(query('memory-strip').dataset.tab).toBe('graph');
    expect(scrollRoot('page').scrollTop).toBe(140);
  });

  it('keeps the originating subgraph stable while following cross-subgraph entity links', async () => {
    await click('select-subgraph-demo');
    await click('subgraph-tab-graph');
    expect(query('active-subgraph').textContent).toBe('demo');
    expect(query('subgraph-detail').dataset.tab).toBe('graph');

    await click('open-subgraph-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:demo');
    expect(query('active-subgraph').textContent).toBe('demo');

    await click('open-related-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:other');
    expect(query('active-subgraph').textContent).toBe('demo');

    await click('detail-back');
    await flush();

    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.tab).toBe('graph');
  });

  it('clears stale detail origin when the selected entity disappears', async () => {
    await click('switch-swm');
    await click('open-layer-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:working');

    await act(async () => {
      memory.entities = new Map([...memory.entities].filter(([uri]) => uri !== 'urn:entity:working'));
      memory.entityList = [...memory.entities.values()];
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();

    expect(document.querySelector('[data-testid="entity-detail"]')).toBeNull();

    await click('select-subgraph-demo');
    await click('subgraph-tab-graph');
    await click('open-subgraph-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:demo');

    await click('detail-back');
    await flush();

    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.tab).toBe('graph');
  });

});
