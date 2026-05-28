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
  error: null as string | null,
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
  // Codex review bug F — ProjectView now routes through api-wrapper
  // so the Subgraphs stat resolves in mock mode. Default to empty.
  fetchSubGraphs: vi.fn(async (id: string) => ({ contextGraphId: id, subGraphs: [] })),
}));

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: apiWrapperMock,
}));

vi.mock('../src/ui/api.js', () => ({
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
}));

vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({
  useNodeEvents: () => {},
  useMemoryGraphEvents: () => {},
}));

vi.mock('../src/ui/hooks/useMemoryEntities.js', () => ({
  useMemoryEntities: () => memory,
  buildMemoryEntities: buildTestMemoryEntities,
  // ProjectView imports `canonicalEntityUri` for `dedupeTriplesBySpo`.
  // Idempotent strip of `<...>` wrappers mirrors the real impl.
  canonicalEntityUri: (uri: string) => {
    const trimmed = uri.trim();
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
    return trimmed;
  },
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
  SubGraphBar: ({
    selected,
    onSelect,
    entities,
    layer,
    enabledScope,
  }: {
    selected: string | null;
    onSelect: (slug: string | null, originatingLayer?: 'wm' | 'swm' | 'vm') => void;
    entities?: ReadonlyArray<unknown>;
    layer?: 'wm' | 'swm' | 'vm';
    enabledScope?: ReadonlySet<'working' | 'shared' | 'verified'>;
  }) =>
    React.createElement('div', {
      'data-testid': 'subgraph-bar',
      'data-selected': selected ?? '',
      // PR #793 sweep 6 Bug O — comma-joined sorted trust
      // levels in `enabledScope`, `-` when absent. Lets Bug O
      // tests assert the bar's scope mirrors the detail view.
      'data-enabled-scope': enabledScope ? [...enabledScope].sort().join(',') : '-',
      // S3 Codex Bug C — surface the `entities` prop's
      // resolution so tests can assert ProjectView gates it on
      // a fully-loaded memory snapshot. `defined` while
      // hydration is mid-flight would put the chip row in
      // client-scoped counting (count contradiction with the
      // grid's daemon-side fallback).
      'data-entities': entities === undefined ? 'undefined' : 'defined',
      // PR #793 Codex sweep 2 (Bug H) — surface the bar's `layer`
      // prop so the test can distinguish layer-mode mounts (the
      // WM/SWM/VM tab path) from layer-agnostic mounts (Subgraph
      // Explorer overview + the detail-view internal bar).
      'data-layer': layer ?? '-',
    },
      // Layer-agnostic chip click — fires onSelect with no
      // originating layer. Used by the existing tests AND by
      // Bug H tests to simulate the detail-view internal bar
      // (which is mounted without `layer`).
      React.createElement('button', { 'data-testid': 'select-subgraph-demo', onClick: () => onSelect('demo') }, 'demo'),
      React.createElement('button', { 'data-testid': 'select-subgraph-other', onClick: () => onSelect('other') }, 'other'),
      // Layer-mode chip click — fires onSelect with the bar's
      // own `layer` prop forwarded as originatingLayer. Used to
      // simulate the WM/SWM/VM-tab bar's behaviour in tests.
      React.createElement('button', {
        'data-testid': 'select-subgraph-alpha-with-layer',
        onClick: () => onSelect('alpha', layer),
      }, 'alpha (with layer)'),
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
  SubGraphDetailView: ({ slug, activeTab = 'items', onTabChange, onSelectEntity, initialLayer, initialEnabledLayers, onEnabledLayersChange }: {
    slug: string;
    activeTab?: string;
    onTabChange: (tab: string) => void;
    onSelectEntity: (uri: string) => void;
    /* PR #793 Codex sweep 2 — surface the `initialLayer` prop so
       Bug H tests can assert that detail→detail navigation
       preserves the originating layer scope. `'-'` is the
       sentinel for undefined so the data attr is always a
       string (cleaner DOM assertions). */
    initialLayer?: 'wm' | 'swm' | 'vm';
    /* PR #793 sweep 3 Bug J — multi-layer seed prop. Mock
       surfaces both `data-initial-layer` (single-layer back-compat
       derived from initialEnabledLayers when size === 1) AND
       `data-initial-enabled-layers` (comma-joined trust levels,
       e.g. "working,shared"; '-' when absent). Existing Bug H
       assertions on data-initial-layer continue to pass via the
       derivation. */
    initialEnabledLayers?: ReadonlySet<'working' | 'shared' | 'verified'>;
    /* The detail view normally pushes its enabledLayers up via
       this callback so ProjectView can route the user's CURRENT
       scope through chip clicks (Bug J). Mock exposes buttons
       per layer combo so tests can simulate widening / narrowing
       inside the detail view. */
    onEnabledLayersChange?: (layers: ReadonlySet<'working' | 'shared' | 'verified'>) => void;
  }) => {
    const derivedSingleLayer =
      initialEnabledLayers && initialEnabledLayers.size === 1
        ? (() => {
            const only = initialEnabledLayers.values().next().value as string;
            if (only === 'working') return 'wm';
            if (only === 'shared') return 'swm';
            if (only === 'verified') return 'vm';
            return '-';
          })()
        : (initialLayer ?? '-');
    const enabledSummary = initialEnabledLayers
      ? [...initialEnabledLayers].sort().join(',')
      : (initialLayer === 'wm' ? 'working'
        : initialLayer === 'swm' ? 'shared'
        : initialLayer === 'vm' ? 'verified'
        : '-');
    // Bug J — the real SubGraphDetailView mirrors its
    // `enabledLayers` state up via `onEnabledLayersChange` so
    // ProjectView can route the current scope through chip
    // clicks. The mock needs to honour the same contract or
    // detail→detail tests see an empty mirror and fall to the
    // null branch.
    React.useEffect(() => {
      if (!onEnabledLayersChange) return;
      if (initialEnabledLayers && initialEnabledLayers.size > 0) {
        onEnabledLayersChange(new Set(initialEnabledLayers));
      } else if (initialLayer) {
        const only = initialLayer === 'wm' ? 'working'
          : initialLayer === 'swm' ? 'shared' : 'verified';
        onEnabledLayersChange(new Set([only as 'working' | 'shared' | 'verified']));
      } else {
        onEnabledLayersChange(new Set(['working', 'shared', 'verified']));
      }
    }, [initialEnabledLayers, initialLayer, onEnabledLayersChange]);
    return React.createElement('section', {
      'data-testid': 'subgraph-detail',
      'data-slug': slug,
      'data-tab': activeTab,
      'data-initial-layer': derivedSingleLayer,
      'data-initial-enabled-layers': enabledSummary,
    },
      React.createElement('button', { 'data-testid': 'subgraph-tab-graph', onClick: () => onTabChange('graph') }, 'Graph'),
      // Bug J — buttons to simulate the user widening / narrowing
      // inside the detail view; each fires the mirror callback so
      // ProjectView captures the current scope ahead of any
      // chip-hop click.
      React.createElement('button', {
        'data-testid': 'detail-widen-wm-swm',
        onClick: () => onEnabledLayersChange?.(new Set(['working', 'shared'])),
      }, 'widen WM+SWM'),
      React.createElement('button', {
        'data-testid': 'detail-set-vm-only',
        onClick: () => onEnabledLayersChange?.(new Set(['verified'])),
      }, 'narrow to VM'),
      React.createElement('button', {
        'data-testid': 'detail-set-all-three',
        onClick: () => onEnabledLayersChange?.(new Set(['working', 'shared', 'verified'])),
      }, 'all three'),
      React.createElement('div', { 'data-testid': 'subgraph-scroll', 'data-cg-scroll-key': `subgraph:${slug}:${activeTab}` },
        React.createElement('button', { 'data-testid': 'open-subgraph-entity', onClick: () => onSelectEntity('urn:entity:demo') }, 'Open demo entity')));
  },
  ProjectOverviewCard: ({ onOpenPrimer, participants, participantsStatus, subGraphCount, subGraphFetchFailed }: {
    onOpenPrimer: () => void;
    participants: string[];
    participantsStatus: string;
    subGraphCount?: number | null;
    subGraphFetchFailed?: boolean;
  }) =>
    React.createElement('div', {
      'data-testid': 'overview-card',
      'data-participants': participants.join(','),
      'data-participants-status': participantsStatus,
      'data-sub-graph-count': subGraphCount == null ? '' : String(subGraphCount),
      'data-sub-graph-fetch-failed': subGraphFetchFailed ? 'true' : 'false',
    },
      'Overview',
      React.createElement('button', { 'data-testid': 'open-primer', onClick: onOpenPrimer }, 'What is a Context Graph?')),
  PendingJoinRequestsSection: () => null,
  OverviewPrimerEntry: ({ onOpenPrimer }: { onOpenPrimer: () => void }) =>
    React.createElement('div', { 'data-testid': 'primer-footer' },
      React.createElement('button', { 'data-testid': 'open-primer-footer', onClick: onOpenPrimer }, 'What is a Context Graph?')),
  curatorStatusForOverview: () => 'not-curator',
  SubGraphOverviewGrid: ({ onSelectSubGraph }: { onSelectSubGraph: (slug: string) => void }) =>
    React.createElement('button', {
      'data-testid': 'select-subgraph-demo',
      onClick: () => onSelectSubGraph('demo'),
    }, 'Open demo subgraph'),
  SubGraphExplorerHeader: () =>
    React.createElement('div', { 'data-testid': 'subgraph-explorer-header' }, 'Subgraph Explorer'),
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
    apiWrapperMock.fetchSubGraphs.mockResolvedValue({ contextGraphId: 'cg-test', subGraphs: [] });
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

  it('routes the Overview Subgraphs lift through api-wrapper so mock-mode resolves (Codex bug F)', async () => {
    // ProjectView should fire its sub-graph fetch via the wrapped
    // `api.fetchSubGraphs`, NOT via a direct `../api.js` import that
    // would bypass mock/offline fallback. Asserting the wrapper was
    // called proves the route — `apiWrapperMock.fetchSubGraphs`
    // only resolves when the wrapper is actually used.
    expect(apiWrapperMock.fetchSubGraphs).toHaveBeenCalledWith('cg-test');
  });

  it('Overview Subgraphs count filters the `meta` slug', async () => {
    // Same filter as SubGraphBar (chips) and SubGraphOverviewGrid
    // (cards) — only `meta` is excluded. The daemon's
    // `listSubGraphs` returns only registered `dkg:SubGraph` rows;
    // `meta` is the auto-registered profile slug.
    apiWrapperMock.fetchSubGraphs.mockResolvedValue({
      contextGraphId: 'cg-test',
      subGraphs: [
        { name: 'meta', uri: 'urn:meta', entityCount: 0, tripleCount: 0 },
        { name: 'recipes', uri: 'urn:recipes', entityCount: 3, tripleCount: 12 },
        { name: 'reviews', uri: 'urn:reviews', entityCount: 5, tripleCount: 18 },
        { name: 'docs', uri: 'urn:docs', entityCount: 2, tripleCount: 7 },
      ],
    });

    // Remount ProjectView so the updated mockResolvedValue takes
    // effect (the global beforeEach() resolved an empty list).
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();

    // Expect 3 = 4 total - 1 (meta filtered).
    expect(query('overview-card').dataset.subGraphCount).toBe('3');
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

  // S3 Codex Bug C — SubGraphBar's `entities` prop drives client-
  // scoped chip counts. While useMemoryEntities is still hydrating
  // (`loading: true`) or has surfaced a partial-fetch failure
  // (`partial: true` / `error: !== null`), entityList is incomplete
  // and the chip counts disagree with SubGraphOverviewGrid's
  // daemon-side `sg.entityCount` fallback — same screen, two
  // numbers. ProjectView must withhold the entities prop until the
  // memory snapshot is fully loaded.
  //
  // SubGraphBar mounts only on the WM/SWM/VM layers, the
  // Subgraphs tab (graph-overview), and the in-subgraph detail
  // route. Switch to SWM before asserting on `data-entities`.
  it('does NOT pass rawMemory.entityList to SubGraphBar while memory is still loading', async () => {
    memory.loading = true;
    memory.entityList = [];
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
    await click('switch-swm');
    await flush();

    expect(query('subgraph-bar').dataset.entities).toBe('undefined');

    memory.loading = false;
    resetMemory();
  });

  it('does NOT pass rawMemory.entityList to SubGraphBar while memory is in a partial-failure state', async () => {
    memory.loading = false;
    memory.partial = true;
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
    await click('switch-swm');
    await flush();

    expect(query('subgraph-bar').dataset.entities).toBe('undefined');

    memory.partial = false;
    resetMemory();
  });

  it('passes rawMemory.entityList to SubGraphBar once memory is fully loaded', async () => {
    memory.loading = false;
    memory.partial = false;
    memory.error = null;
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
    await click('switch-swm');
    await flush();

    expect(query('subgraph-bar').dataset.entities).toBe('defined');
  });

  // S3 Codex sweep 3 Bug F — follow-on to Bug C. When all three
  // layer queries fail, `useMemoryEntities` historically left
  // `error: null` and `partial: false` (`partial` triggers only on
  // PARTIAL failure), so the `memoryReady` gate misclassed total
  // failure as "ready" and passed an empty entityList through.
  // ProjectView now opts into `signalErrors: true`, so a total
  // failure surfaces `error: 'Failed to load memory data'` and
  // the gate fires correctly. The mock here uses a non-null
  // `error` to simulate the post-fix behavior — the
  // `signalErrors` opt-in is verified at the hook unit level;
  // here we lock the downstream gate against any future "treat
  // total failure as ready" regression.
  it('does NOT pass rawMemory.entityList to SubGraphBar when all three layer queries failed (signalErrors)', async () => {
    memory.loading = false;
    memory.partial = false;
    memory.error = 'Failed to load memory data';
    memory.entityList = [];
    await act(async () => {
      root.render(React.createElement(ProjectView, { contextGraphId: 'cg-test' }));
    });
    await flush();
    await click('switch-swm');
    await flush();

    expect(query('subgraph-bar').dataset.entities).toBe('undefined');

    memory.error = null;
    resetMemory();
  });

  // S3 polish PR #793 Codex sweep 2 (Bug H) — `handleSelectSubGraph`
  // was unconditionally writing `null` to `subGraphInitialLayer`
  // whenever `originatingLayer === undefined`. The detail-view
  // internal SubGraphBar is mounted without a `layer` prop (it's
  // layer-agnostic by design), so a WM → recipes → bakers nav
  // silently widened scope back to all three layers on hop 2.
  // Three call patterns must route differently — see the new
  // discriminator in handleSelectSubGraph.
  it('preserves subGraphInitialLayer on detail→detail navigation (Bug H load-bearing)', async () => {
    // 1. Land on WM tab.
    await click('switch-wm');
    await flush();
    // The WM tab's SubGraphBar mount carries `layer="wm"`.
    expect(query('subgraph-bar').dataset.layer).toBe('wm');

    // 2. Click `alpha (with layer)` — layer-mode click → enters
    //    subgraph detail with initialLayer === 'wm'.
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('alpha');
    expect(query('subgraph-detail').dataset.initialLayer).toBe('wm');
    // The detail-view internal bar is layer-agnostic.
    expect(query('subgraph-bar').dataset.layer).toBe('-');

    // 3. Click `demo` — layer-agnostic click from inside an
    //    already-scoped detail. Pre-fix this silently widened to
    //    all-three; post-fix it preserves WM.
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialLayer).toBe('wm');

    // 4. One more hop — `other` chip; scope still preserved.
    await click('select-subgraph-other');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('other');
    expect(query('subgraph-detail').dataset.initialLayer).toBe('wm');
  });

  it('keeps initialLayer === undefined on fresh entry from Subgraph Explorer overview (Bug H regression guard)', async () => {
    // 1. Land on the Subgraphs tab — no activeSubGraph yet, the
    //    bar mounts layer-agnostic.
    await click('switch-subgraphs');
    await flush();
    expect(query('subgraph-bar').dataset.layer).toBe('-');

    // 2. Click `demo` from the overview — layer-agnostic but
    //    activeSubGraph was null before the click → fresh entry
    //    path → initialLayer stays undefined (detail lands at
    //    all-three).
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialLayer).toBe('-');
  });

  it('exit (slug === null) clears any prior initialLayer scope (Bug H regression guard)', async () => {
    // 1. WM tab → alpha with layer → scope is WM.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialLayer).toBe('wm');

    // 2. Click clear (the All chip — layer-agnostic, slug === null).
    //    The detail view unmounts; we re-enter via Subgraphs tab
    //    overview to confirm scope was cleared.
    await click('clear-subgraph');
    await flush();
    // No detail view at this point — we should be back on WM tab.
    expect(document.querySelector('[data-testid="subgraph-detail"]')).toBeNull();

    // 3. Switch to Subgraphs tab and enter detail fresh — must
    //    land at all-three (initialLayer === undefined),
    //    confirming the exit cleared the prior WM scope rather
    //    than preserving it across the round-trip.
    await click('switch-subgraphs');
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialLayer).toBe('-');
  });

  // S3 polish PR #793 Codex sweep 3 (Bug J) — `handleSelectSubGraph`
  // was preserving the STALE seed across detail→detail hops, not
  // the user's current scope. A WM-tab entry that widens to
  // WM+SWM in the detail view then hops to another subgraph
  // silently snapped back to WM-only. Fix: ProjectView reads
  // the detail view's current scope from a mirror ref (populated
  // via `onEnabledLayersChange`) and routes it through.
  it('detail→detail nav preserves USER\'S CURRENT scope after widening, not the stale seed (Bug J load-bearing)', async () => {
    // 1. WM tab → alpha-with-layer → detail seeds Set(['working']).
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');

    // 2. User widens to WM+SWM inside the detail view (mock
    //    button drives the mirror callback directly).
    await click('detail-widen-wm-swm');
    await flush();

    // 3. Hop to a different subgraph via the detail-view internal
    //    bar (layer-agnostic click). Pre-fix this re-seeded to WM
    //    only (the stale seed); post-fix it carries WM+SWM.
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('shared,working');
  });

  it('detail→detail nav carries narrowed-to-VM scope through the hop (Bug J symmetric)', async () => {
    // 1. WM tab → alpha-with-layer → detail seeds Set(['working']).
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();

    // 2. User switches focus entirely to VM (a different single
    //    layer from the seed).
    await click('detail-set-vm-only');
    await flush();

    // 3. Hop — next detail seeds Set(['verified']), not the
    //    stale 'working' seed.
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('verified');
  });

  it('detail→detail nav when current scope === seed still preserves correctly (Bug J / Bug H regression guard)', async () => {
    // The Bug H case must continue to work — the user hasn't
    // touched the seed, so the hop should carry it through.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    // (no widen/narrow click — current scope === seed)
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');
  });

  it('detail→detail nav when user widens to all-three carries multi-layer scope through (Bug J)', async () => {
    // Edge case: user reverts to all-three inside the detail
    // view, then hops. Next detail should land at all-three, not
    // the WM seed.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    await click('detail-set-all-three');
    await flush();
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('shared,verified,working');
  });

  // S3 polish PR #793 Codex sweep 4 (Bug L) — `detailScopeRef.current`
  // was only refreshed by SubGraphDetailView's mirror effect, which
  // fires AFTER React paints. A fast chip-to-chip hop that fires
  // before the mirror effect would read a stale ref → seeds lost.
  // The fix writes the ref synchronously in every branch of
  // handleSelectSubGraph that updates the seed state.
  //
  // Testing approach: pack both clicks into a single act() block
  // without flushing between them. The mirror useEffect's setState
  // batches into the act() boundary, so when the second click fires
  // mid-batch the ref is the only sync state available — exactly the
  // race window Bug L closes.
  it('WM-tab → A → B fast hop synchronously preserves the WM seed (Bug L load-bearing)', async () => {
    await click('switch-wm');
    await flush();

    // Two clicks in a single act() block — mimics a user-input
    // burst that completes before React's effect schedule runs the
    // mirror useEffect for the A detail mount. Pre-Bug-L the second
    // click would read ref=null and route through the layer-agnostic
    // overview branch, losing the WM seed.
    await act(async () => {
      query('select-subgraph-alpha-with-layer').click();
      query('select-subgraph-demo').click();
    });
    await flush();

    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');
  });

  it('exit-then-immediate-entry clears scope synchronously (Bug L exit-branch guard)', async () => {
    // 1. WM tab → alpha (seeds WM, ref=Set(['working'])).
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');

    // 2. Exit → Subgraphs → demo in a single batch. The exit
    //    branch's sync ref clear is load-bearing: pre-fix, the
    //    Subgraphs → demo hop would read the stale Set(['working'])
    //    ref and silently narrow scope to WM-only.
    await act(async () => {
      query('clear-subgraph').click();
    });
    await flush();
    await act(async () => {
      query('switch-subgraphs').click();
      query('select-subgraph-demo').click();
    });
    await flush();

    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('-');
  });

  it('overview → A → B fast hop reads non-null ref on the layer-agnostic path (Bug L cold-start)', async () => {
    // Overview path: A click sets ref=null (fresh entry). Before
    // A's mirror effect runs (which would push Set(['working',
    // 'shared', 'verified']) — the default — into the ref), B
    // click fires. The B click's layer-agnostic branch reads
    // `activeSubGraph !== null && detailScopeRef.current` — Bug L
    // ensures `detailScopeRef.current` was nulled SYNCHRONOUSLY
    // by A's click, so B correctly falls to the fresh-entry path
    // (initialEnabledLayers === undefined → all-three default).
    // Pre-fix this race could leave a STALE seed from a prior
    // detail visit in the ref, contaminating the new chip click.
    await click('switch-subgraphs');
    await flush();

    await act(async () => {
      query('select-subgraph-demo').click();
      query('select-subgraph-other').click();
    });
    await flush();

    expect(query('subgraph-detail').dataset.slug).toBe('other');
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('-');
  });

  // S3 polish PR #793 Codex sweep 5 (Bug N) — `activeSubGraphRef`
  // and `detailScopeRef` go stale on any state-mutation path
  // that bypasses the sync helper. Pre-Bug-N the layer-switcher
  // and detail-close paths called `setActiveSubGraph` directly,
  // so the next layer-agnostic chip click would misclassify
  // itself as a detail→detail hop and reuse stale scope.
  it('subgraph A (WM-seeded) → layer switch → overview → click B is a FRESH overview entry (Bug N load-bearing)', async () => {
    // 1. WM tab → alpha-with-layer → seeds Set(['working']).
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');

    // 2. Switch to WM tab again (layer-switch path). Pre-fix
    //    this called setActiveSubGraph(null) directly, leaving
    //    activeSubGraphRef='alpha' AND detailScopeRef=Set(['working']).
    await click('switch-wm');
    await flush();
    // Detail view unmounts; we're back on the WM layer page.
    expect(document.querySelector('[data-testid="subgraph-detail"]')).toBeNull();

    // 3. Go to the Subgraphs overview, click `demo`. The chip
    //    click is layer-agnostic. Pre-Bug-N the stale refs would
    //    misroute this through the detail→detail branch and
    //    re-seed Set(['working']). Post-fix the helper clears
    //    both refs so demo lands at all-three.
    await click('switch-subgraphs');
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('demo');
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('-');
  });

  it('subgraph A → layer switch → layer-mode chip click still seeds the new layer (Bug N regression guard)', async () => {
    // Layer-mode entry path must remain correct after a
    // layer-switch reset — proves the helper's null-clear didn't
    // accidentally break the originating-layer carry-over for
    // the next chip click.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');

    // Switch to SWM tab (this clears scope via the helper).
    await click('switch-swm');
    await flush();

    // Click the layer-mode chip from SWM — should seed Set(['shared']).
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('shared');
  });

  it('subgraph A → open entity → detail-close → click B is a FRESH layer-tab entry (Bug N close-path)', async () => {
    // The detail-close path restores M2 origin. Pre-Bug-N this
    // called setActiveSubGraph(origin.activeSubGraph) directly,
    // leaving refs stale across the round-trip. Verify the close
    // path goes through the helper and the next chip click sees
    // a clean state matching the restored origin.

    // 1. WM tab → open an entity directly from the layer list
    //    (no sub-graph in scope). detail.activeSubGraph in
    //    origin is null.
    await click('switch-wm');
    await click('open-layer-overlap-entity');
    await flush();
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');

    // 2. detail-back → handleDetailClose restores origin
    //    (activeSubGraph=null since we opened from a layer tab).
    //    Helper must clear refs.
    await click('detail-back');
    await flush();
    expect(document.querySelector('[data-testid="entity-detail"]')).toBeNull();

    // 3. Navigate to Subgraphs overview → click `demo`. Must
    //    land at all-three (fresh overview entry).
    await click('switch-subgraphs');
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('-');
  });

  // S3 polish PR #793 Codex sweep 6 (Bug O) — the SubGraphBar
  // mounted alongside an active subgraph detail must receive the
  // detail's current `enabledLayers` scope so its chip counts
  // reflect the same filtered slice. Pre-fix the bar was
  // layer-agnostic (showing all-three counts) above a layer-
  // filtered detail body — same-screen disagreement.
  it('detail-view sibling SubGraphBar receives the detail scope as enabledScope (Bug O load-bearing — single-layer entry)', async () => {
    // WM-tab entry → seeds Set(['working']) on both the detail
    // AND the sibling bar.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');
    // The detail-view sibling bar mounts on this branch — assert
    // its enabledScope matches.
    expect(query('subgraph-bar').dataset.enabledScope).toBe('working');
  });

  it('detail-view sibling SubGraphBar updates when the user widens detail scope (Bug O multi-layer)', async () => {
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    // Baseline: WM only.
    expect(query('subgraph-bar').dataset.enabledScope).toBe('working');

    // User widens the detail's scope to WM+SWM. The mirror
    // callback updates the parent state → bar re-renders.
    await click('detail-widen-wm-swm');
    await flush();

    expect(query('subgraph-bar').dataset.enabledScope).toBe('shared,working');
  });

  it('detail-view sibling SubGraphBar reflects all-three scope on overview-entry (Bug O regression guard)', async () => {
    // Fresh-entry from Subgraphs overview: detail seeds at
    // all-three; bar's enabledScope should reflect the same
    // (or fall through to layer-agnostic, which the mock
    // surfaces identically when scope is the full set).
    await click('switch-subgraphs');
    await click('select-subgraph-demo');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('-');
    // The mirror effect fires on mount with all-three. The bar
    // receives that Set; per the bar's collapse rule (sweep 6
    // Bug O — size 3 is treated as layer-agnostic in display
    // logic but the carrier still flows through) the mock
    // surfaces the comma-joined string.
    expect(query('subgraph-bar').dataset.enabledScope).toBe('shared,verified,working');
  });

  it('exit from detail clears the sibling SubGraphBar scope state (Bug O exit invariant)', async () => {
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-bar').dataset.enabledScope).toBe('working');

    // Exit to the WM tab — sync helper's null-clear branch
    // wipes both the ref and the bar's scope state.
    await click('clear-subgraph');
    await flush();
    // Detail view unmounted; the WM-tab branch's bar (a different
    // mount) has no enabledScope by design (it's the layer-tab
    // mount, which uses the legacy `layer={activeLayer}` path).
    expect(query('subgraph-bar').dataset.enabledScope).toBe('-');
  });

  // S3 polish PR #793 Codex sweep 6 (Bug P) — handleDetailClose
  // restored activeSubGraph but never restored the user's
  // current `enabledLayers` scope, so the SubGraphDetailView
  // would remount from the stale `subGraphInitialEnabledLayers`
  // seed and snap back to the original scope. Fix: DetailOrigin
  // captures `subGraphEnabledLayers` at entity-open; close-path
  // restores from the snapshot.
  it('subgraph A widened to WM+SWM → open entity → close-back → scope stays at WM+SWM (Bug P load-bearing)', async () => {
    // 1. WM tab → alpha (seeds Set(['working'])).
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').dataset.initialEnabledLayers).toBe('working');

    // 2. User widens to WM+SWM in the detail view. Mirror
    //    callback updates currentDetailScope.
    await click('detail-widen-wm-swm');
    await flush();
    expect(query('subgraph-bar').dataset.enabledScope).toBe('shared,working');

    // 3. Open an entity from inside the subgraph detail. This
    //    captures the DetailOrigin including the current scope.
    await click('open-subgraph-entity');
    await flush();
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:demo');
    expect(document.querySelector('[data-testid="subgraph-detail"]')).toBeNull();

    // 4. Close the entity → handleDetailClose restores from
    //    origin. Pre-Bug-P this would snap back to WM-only
    //    (stale seed); post-fix preserves WM+SWM.
    await click('detail-back');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('alpha');
    // `data-initial-enabled-layers` is the Set carrier; assert
    // both layers survive the round-trip.
    expect(query('subgraph-detail').getAttribute('data-initial-enabled-layers')).toBe('shared,working');
    // Single-layer alias collapses to '-' for size > 1 (the
    // mock's derivation only resolves a layer abbreviation when
    // scope size === 1).
    expect(query('subgraph-detail').dataset.initialLayer).toBe('-');
    // The sibling bar receives the restored scope.
    expect(query('subgraph-bar').dataset.enabledScope).toBe('shared,working');
  });

  it('subgraph A at seed scope → open entity → close-back → scope still at seed (Bug P regression guard)', async () => {
    // No-op case — user didn't widen/narrow, the restored scope
    // equals the seed.
    await click('switch-wm');
    await click('select-subgraph-alpha-with-layer');
    await flush();
    expect(query('subgraph-detail').getAttribute('data-initial-enabled-layers')).toBe('working');

    await click('open-subgraph-entity');
    await flush();
    await click('detail-back');
    await flush();
    expect(query('subgraph-detail').dataset.slug).toBe('alpha');
    expect(query('subgraph-detail').getAttribute('data-initial-enabled-layers')).toBe('working');
  });

  it('entity opened from a layer-tab origin → close-back → no scope restoration (Bug P origin-shape guard)', async () => {
    // When the entity opens from a layer-tab page (no subgraph
    // in scope), origin.activeSubGraph is null. The restore
    // branch must NOT touch the scope mirrors — there was no
    // scope to preserve. Proves Bug P's null guard.
    await click('switch-wm');
    await click('open-layer-overlap-entity');
    await flush();
    expect(query('entity-detail').dataset.entity).toBe('urn:entity:overlap');

    await click('detail-back');
    await flush();
    // Back on the WM tab — no subgraph-detail mount.
    expect(document.querySelector('[data-testid="subgraph-detail"]')).toBeNull();
    // The WM-tab bar mount uses the legacy `layer={activeLayer}`
    // path, not enabledScope, so `data-enabled-scope` is '-'
    // (the mock returns '-' when enabledScope is undefined).
    expect(query('subgraph-bar').dataset.enabledScope).toBe('-');
  });

});
