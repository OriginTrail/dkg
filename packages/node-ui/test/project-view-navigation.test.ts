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
    ['urn:entity:overlap', {
      uri: 'urn:entity:overlap',
      label: 'Shared overlap',
      types: ['http://schema.org/Thing'],
      trustLevel: 'shared',
      layers: new Set(['working', 'shared']),
      subGraphs: new Set(['demo']),
      properties: new Map([['http://schema.org/name', ['Shared overlap']]]),
      connections: [],
    }],
  ]);
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NAME = 'http://schema.org/name';

function buildTestMemoryEntities(layered: any[]) {
  const entities = new Map<string, any>();
  const connectionKeys = new Map<string, Set<string>>();
  const get = (uri: string) => {
    let entity = entities.get(uri);
    if (!entity) {
      entity = {
        uri,
        label: uri,
        types: [],
        trustLevel: 'working',
        layers: new Set(),
        subGraphs: new Set(),
        properties: new Map(),
        connections: [],
      };
      entities.set(uri, entity);
    }
    return entity;
  };
  for (const triple of layered) {
    const entity = get(triple.subject);
    entity.layers.add(triple.layer);
    if (triple.subGraph) entity.subGraphs.add(triple.subGraph);
    if (triple.predicate === RDF_TYPE) {
      entity.types.push(triple.object);
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(triple.object)) {
      const target = get(triple.object);
      target.layers.add(triple.layer);
      if (triple.subGraph) target.subGraphs.add(triple.subGraph);
      const keys = connectionKeys.get(entity.uri) ?? new Set<string>();
      const key = `${triple.predicate}\0${triple.object}`;
      if (!keys.has(key)) {
        keys.add(key);
        connectionKeys.set(entity.uri, keys);
        entity.connections.push({
          predicate: triple.predicate,
          targetUri: triple.object,
          targetLabel: triple.object,
        });
      }
    } else {
      const vals = entity.properties.get(triple.predicate) ?? [];
      vals.push(triple.object);
      entity.properties.set(triple.predicate, vals);
      if (triple.predicate === NAME) entity.label = triple.object;
    }
  }
  for (const entity of entities.values()) {
    if (entity.layers.has('verified')) entity.trustLevel = 'verified';
    else if (entity.layers.has('shared')) entity.trustLevel = 'shared';
  }
  return entities;
}

const initialLayeredTriples = [
  { subject: 'urn:entity:working', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
  { subject: 'urn:entity:working', predicate: NAME, object: 'Working entity', layer: 'working' },
  { subject: 'urn:entity:overlap', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'working' },
  { subject: 'urn:entity:overlap', predicate: NAME, object: 'Working overlap', layer: 'working' },
  { subject: 'urn:entity:overlap', predicate: RDF_TYPE, object: 'http://schema.org/Thing', layer: 'shared' },
  { subject: 'urn:entity:overlap', predicate: NAME, object: 'Shared overlap', layer: 'shared' },
  { subject: 'urn:entity:overlap', predicate: 'related', object: 'urn:entity:other', layer: 'shared', subGraph: 'demo' },
  { subject: 'urn:entity:overlap', predicate: 'related', object: 'urn:entity:other', layer: 'shared', subGraph: 'other' },
] as any[];

const memory = {
  entities: createEntities(),
  entityList: [] as any[],
  allTriples: [...initialLayeredTriples],
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
  memory.allTriples = [...initialLayeredTriples];
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

const tabsStoreMock = vi.hoisted(() => ({
  openTab: vi.fn(),
}));

const apiWrapperMock = vi.hoisted(() => ({
  fetchContextGraphs: vi.fn(),
  fetchCurrentAgent: vi.fn(),
  listParticipants: vi.fn(),
}));

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: apiWrapperMock,
}));

vi.mock('../src/ui/api.js', () => ({
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
}));

vi.mock('../src/ui/hooks/useMemoryEntities.js', () => ({
  useMemoryEntities: () => memory,
  buildMemoryEntities: buildTestMemoryEntities,
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
  useTabsStore: (selector?: (state: { openTab: typeof tabsStoreMock.openTab }) => unknown) => {
    const state = { openTab: tabsStoreMock.openTab };
    return selector ? selector(state) : state;
  },
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
      React.createElement('button', { 'data-testid': 'switch-swm', onClick: () => onSwitch('swm') }, 'SWM'),
      React.createElement('button', { 'data-testid': 'switch-subgraphs', onClick: () => onSwitch('graph-overview') }, 'Subgraphs')),
  KADetailView: ({ entity, onNavigate, onClose }: { entity: any; onNavigate: (uri: string) => void; onClose: () => void }) =>
    React.createElement('section', { 'data-testid': 'entity-detail', 'data-entity': entity.uri, 'data-trust': entity.trustLevel, 'data-connections': String(entity.connections.length), 'data-subgraphs': [...entity.subGraphs].sort().join(',') },
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
  ProjectOverviewCard: ({ onOpenPrimer, participants, participantsStatus }: {
    onOpenPrimer: () => void;
    participants: string[];
    participantsStatus: string;
  }) =>
    React.createElement('div', {
      'data-testid': 'overview-card',
      'data-participants': participants.join(','),
      'data-participants-status': participantsStatus,
    },
      'Overview',
      React.createElement('button', { 'data-testid': 'open-primer', onClick: onOpenPrimer }, 'What is a Context Graph?')),
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
  SubGraphOverviewGrid: ({ onSelectSubGraph }: { onSelectSubGraph: (slug: string) => void }) =>
    React.createElement('button', {
      'data-testid': 'select-subgraph-demo',
      onClick: () => onSelectSubGraph('demo'),
    }, 'Open demo subgraph'),
  ContextGraphQueryView: () => null,
  LayerDetailView: ({ layer, activeTab, onTabChange, onSelectEntity, onNodeClick }: {
    layer: string;
    activeTab: string;
    onTabChange: (tab: string) => void;
    onSelectEntity: (uri: string) => void;
    onNodeClick: (node: any) => void;
  }) =>
    React.createElement('section', { 'data-testid': 'layer-detail', 'data-layer': layer, 'data-tab': activeTab },
      React.createElement('button', { 'data-testid': 'layer-tab-graph', onClick: () => onTabChange('graph') }, 'Graph'),
      React.createElement('div', { 'data-testid': 'layer-scroll', 'data-cg-scroll-key': `layer:${layer}:${activeTab}` },
        React.createElement('button', { 'data-testid': 'open-layer-entity', onClick: () => onSelectEntity('urn:entity:working') }, 'Open layer entity'),
        React.createElement('button', { 'data-testid': 'open-layer-overlap-entity', onClick: () => onSelectEntity('urn:entity:overlap') }, 'Open overlap entity'),
        React.createElement('button', { 'data-testid': 'open-layer-graph-node', onClick: () => onNodeClick({ id: 'urn:entity:overlap', trustLayer: layer }) }, 'Open graph node'))),
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
    apiWrapperMock.fetchContextGraphs.mockResolvedValue({
      contextGraphs: [{ id: 'cg-test', name: 'Context Graph Test' }],
    });
    apiWrapperMock.fetchCurrentAgent.mockResolvedValue({
      agentDid: 'did:dkg:agent:0xabc',
      peerId: 'peer-1',
    });
    apiWrapperMock.listParticipants.mockResolvedValue({ allowedAgents: [] });
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

    await click('open-layer-overlap-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');

    await click('detail-back');
    await flush();

    expect(query('active-layer').dataset.layer).toBe('swm');
    expect(query('layer-detail').dataset.tab).toBe('graph');
    expect(query('layer-scroll').scrollTop).toBe(86);
  });

  it('restores page scroll when overview activity opens an entity detail', async () => {
    const pageScroller = scrollRoot('page');
    pageScroller.scrollTop = 140;

    await click('open-activity-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:working');

    pageScroller.scrollTop = 0;

    await click('detail-back');
    await flush();

    expect(query('active-layer').dataset.layer).toBe('overview');
    expect(scrollRoot('page').scrollTop).toBe(140);
  });

  it('opens graph nodes with the layer context they came from', async () => {
    await click('switch-wm');
    await click('layer-tab-graph');
    await click('open-layer-graph-node');

    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');
    expect(query('entity-detail').dataset.trust).toBe('working');
    expect(query('entity-detail').textContent).toContain('Working overlap');

    await click('detail-back');
    await flush();

    await click('switch-swm');
    await click('layer-tab-graph');
    await click('open-layer-graph-node');

    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');
    expect(query('entity-detail').dataset.trust).toBe('shared');
    expect(query('entity-detail').dataset.connections).toBe('1');
    expect(query('entity-detail').dataset.subgraphs).toBe('demo,other');
    expect(query('entity-detail').textContent).toContain('Shared overlap');
  });

  it('opens layer list selections with the active layer context', async () => {
    await click('switch-wm');
    await click('open-layer-overlap-entity');

    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');
    expect(query('entity-detail').dataset.trust).toBe('working');
    expect(query('entity-detail').textContent).toContain('Working overlap');
  });

  it('opens the primer as a tab without mutating browser history', async () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    await click('open-primer');

    expect(tabsStoreMock.openTab).toHaveBeenCalledWith({
      id: 'context-graph-primer',
      label: 'What is a Context Graph?',
      closable: true,
    });
    expect(pushStateSpy).not.toHaveBeenCalled();

    pushStateSpy.mockRestore();
  });

  it('does not pass participants loaded for another context graph into Overview', async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);

    apiWrapperMock.fetchContextGraphs.mockResolvedValue({
      contextGraphs: [
        { id: 'cg-test', name: 'Context Graph Test' },
        { id: 'cg-next', name: 'Next Context Graph' },
      ],
    });
    apiWrapperMock.listParticipants.mockReset();
    apiWrapperMock.listParticipants
      .mockResolvedValueOnce({ allowedAgents: ['0xabc'] })
      .mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
    expect(query('overview-card').dataset.participants).toBe('0xabc');
    expect(query('overview-card').dataset.participantsStatus).toBe('ok');

    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-next' }));
    });
    await flush();

    expect(query('overview-card').dataset.participants).toBe('');
    expect(query('overview-card').dataset.participantsStatus).toBe('loading');
  });

  it('keeps the originating subgraph stable while following cross-subgraph entity links', async () => {
    await click('switch-subgraphs');
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
    await click('open-layer-overlap-entity');
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');

    await act(async () => {
      memory.allTriples = memory.allTriples.filter((t: any) => t.subject !== 'urn:entity:overlap');
      memory.entities = new Map([...memory.entities].filter(([uri]) => uri !== 'urn:entity:overlap'));
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
