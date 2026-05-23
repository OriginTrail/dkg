import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { listParticipants } from '../api.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../components/Modals/ShareProjectModal.js';
import { useMemoryEntities } from '../hooks/useMemoryEntities.js';
import { useProjectProfile, ProjectProfileContext } from '../hooks/useProjectProfile.js';
import { useAgents, AgentsContext } from '../hooks/useAgents.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { SubGraphBar } from '../components/SubGraphBar.js';
import { useTabsStore } from '../stores/tabs.js';
import type { LayerView, LayerContentTab, SubGraphTab } from './project/helpers.js';
import {
  ProjectHeaderStrip,
  LayerSwitcher,
  KADetailView,
  SubGraphDetailView,
  ProjectOverviewCard,
  PendingJoinRequestsBar,
  MemoryStrip,
  SubGraphOverviewGrid,
  ContextGraphQueryView,
  LayerDetailView,
  ProvenanceBar,
} from './project/components.js';

interface ProjectViewProps {
  contextGraphId: string;
}

type MemoryLayerView = Extract<LayerView, 'wm' | 'swm' | 'vm'>;

interface DetailOrigin {
  activeLayer: LayerView;
  activeSubGraph: string | null;
  layerTabs: Record<MemoryLayerView, LayerContentTab>;
  overviewExpandedLayer: MemoryLayerView | null;
  overviewLayerTabs: Record<MemoryLayerView, LayerContentTab>;
  subGraphTabs: Record<string, SubGraphTab>;
  scroll: { key: string; top: number };
}

const DEFAULT_LAYER_TABS: Record<MemoryLayerView, LayerContentTab> = {
  wm: 'items',
  swm: 'items',
  vm: 'items',
};

function isMemoryLayerView(layer: LayerView): layer is MemoryLayerView {
  return layer === 'wm' || layer === 'swm' || layer === 'vm';
}

function scrollElementFor(key: string, fallback: HTMLElement | null): HTMLElement | null {
  if (typeof document === 'undefined') return fallback;
  const elements = document.querySelectorAll<HTMLElement>('[data-cg-scroll-key]');
  for (const element of elements) {
    if (element.dataset.cgScrollKey === key) return element;
  }
  return fallback;
}

export function ProjectView({ contextGraphId }: ProjectViewProps) {
  const { data: cgData } = useFetch(api.fetchContextGraphs, [], 30_000);
  const [showImport, setShowImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerView>('overview');
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  // Active sub-graph *page* — when set, the middle pane renders the sub-graph
  // detail view instead of the overview / layer views. This is structurally
  // a sibling of `activeLayer`, not a filter over it: sub-graphs are a peer
  // axis to layers, and each axis gets its own first-class page.
  const [activeSubGraph, setActiveSubGraph] = useState<string | null>(null);
  const [layerContentTabs, setLayerContentTabs] = useState<Record<MemoryLayerView, LayerContentTab>>(
    DEFAULT_LAYER_TABS,
  );
  const [overviewExpandedLayer, setOverviewExpandedLayer] = useState<MemoryLayerView | null>(null);
  const [overviewLayerTabs, setOverviewLayerTabs] = useState<Record<MemoryLayerView, LayerContentTab>>(
    DEFAULT_LAYER_TABS,
  );
  const [subGraphTabs, setSubGraphTabs] = useState<Record<string, SubGraphTab>>({});
  const pageRef = useRef<HTMLElement | null>(null);
  const detailOriginRef = useRef<DetailOrigin | null>(null);
  const pendingScrollRestoreRef = useRef<DetailOrigin['scroll'] | null>(null);
  const profile = useProjectProfile(contextGraphId);
  const agentsData = useAgents(contextGraphId);
  const openTab = useTabsStore((s) => s.openTab);

  const currentScrollKey = useCallback(() => {
    if (activeSubGraph) {
      return `subgraph:${activeSubGraph}:${subGraphTabs[activeSubGraph] ?? 'items'}`;
    }
    if (isMemoryLayerView(activeLayer)) {
      return `layer:${activeLayer}:${layerContentTabs[activeLayer]}`;
    }
    return 'page';
  }, [activeLayer, activeSubGraph, layerContentTabs, subGraphTabs]);

  const captureDetailOrigin = useCallback((originScrollKey?: string): DetailOrigin => {
    const key = originScrollKey ?? currentScrollKey();
    const scrollEl = scrollElementFor(key, pageRef.current);
    return {
      activeLayer,
      activeSubGraph,
      layerTabs: { ...layerContentTabs },
      overviewExpandedLayer,
      overviewLayerTabs: { ...overviewLayerTabs },
      subGraphTabs: { ...subGraphTabs },
      scroll: { key, top: scrollEl?.scrollTop ?? 0 },
    };
  }, [
    activeLayer,
    activeSubGraph,
    currentScrollKey,
    layerContentTabs,
    overviewExpandedLayer,
    overviewLayerTabs,
    subGraphTabs,
  ]);

  const restoreScroll = useCallback((scroll: DetailOrigin['scroll']) => {
    const restore = () => {
      const scrollEl = scrollElementFor(scroll.key, pageRef.current);
      if (scrollEl) scrollEl.scrollTop = scroll.top;
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(restore);
    } else {
      setTimeout(restore, 0);
    }
  }, []);

  const openEntityDetail = useCallback((uri: string, originScrollKey?: string) => {
    if (!selectedUri || !detailOriginRef.current) {
      detailOriginRef.current = captureDetailOrigin(originScrollKey);
    }
    setSelectedUri(uri);
  }, [captureDetailOrigin, selectedUri]);

  const clearDetailOrigin = useCallback(() => {
    detailOriginRef.current = null;
  }, []);

  useEffect(() => {
    if (selectedUri) return;
    const scroll = pendingScrollRestoreRef.current;
    if (!scroll) return;
    pendingScrollRestoreRef.current = null;
    restoreScroll(scroll);
  }, [selectedUri, activeLayer, activeSubGraph, layerContentTabs, subGraphTabs, restoreScroll]);

  // Cross-tab entity open — e.g. the agent profile page in another tab
  // fires a CustomEvent("v10:open-entity", { contextGraphId, entityUri })
  // when the user clicks an activity row. We honour it when it's scoped
  // to *this* project.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail) return;
      if (detail.contextGraphId !== contextGraphId) return;
      if (typeof detail.entityUri !== 'string') return;
      openEntityDetail(detail.entityUri);
    };
    window.addEventListener('v10:open-entity', handler);
    return () => window.removeEventListener('v10:open-entity', handler);
  }, [contextGraphId, openEntityDetail]);

  const openAgent = useCallback((uri: string) => {
    const slug = uri.startsWith('urn:dkg:agent:')
      ? uri.slice('urn:dkg:agent:'.length)
      : uri;
    const name = agentsData.get(uri)?.name ?? slug;
    openTab({
      id: `agent:${contextGraphId}|${slug}`,
      label: `@ ${name}`,
      closable: true,
    });
  }, [agentsData, contextGraphId, openTab]);

  // Inject the project-aware `openAgent` into the context so every
  // AgentChip under this ProjectView click-opens an agent profile tab
  // without having to thread callbacks through wrapper components.
  const agentsContextValue = useMemo(
    () => ({ ...agentsData, openAgent }),
    [agentsData, openAgent],
  );

  const cg = useMemo(
    () => cgData?.contextGraphs?.find((c: any) => c.id === contextGraphId),
    [cgData, contextGraphId]
  );

  const rawMemory = useMemoryEntities(contextGraphId);

  const refreshParticipants = useCallback(() => {
    if (cg?.id) {
      listParticipants(cg.id)
        .then(data => setParticipants(data.allowedAgents))
        .catch(() => setParticipants([]));
    }
  }, [cg?.id]);

  useEffect(() => { refreshParticipants(); }, [refreshParticipants]);

  const selectedEntity = useMemo(
    () => selectedUri ? rawMemory.entities.get(selectedUri) ?? null : null,
    [selectedUri, rawMemory.entities]
  );

  useEffect(() => {
    if (!selectedUri || selectedEntity || rawMemory.loading) return;
    setSelectedUri(null);
    clearDetailOrigin();
  }, [selectedUri, selectedEntity, rawMemory.loading, clearDetailOrigin]);

  // Route a sub-graph chip click to the sub-graph page. Selecting "All"
  // (null) exits the page back to the current layer view, or overview if
  // we were already on one.
  const handleSelectSubGraph = useCallback((slug: string | null) => {
    clearDetailOrigin();
    setActiveSubGraph(slug);
    setSelectedUri(null);
  }, [clearDetailOrigin]);

  const handleLayerSwitch = useCallback((layer: LayerView) => {
    clearDetailOrigin();
    setActiveLayer(layer);
    setSelectedUri(null);
    setActiveSubGraph(null);
  }, [clearDetailOrigin]);

  const handleLayerTabChange = useCallback((layer: MemoryLayerView, tab: LayerContentTab) => {
    setLayerContentTabs(prev => prev[layer] === tab ? prev : { ...prev, [layer]: tab });
  }, []);

  const handleOverviewLayerTabChange = useCallback((layer: MemoryLayerView, tab: LayerContentTab) => {
    setOverviewLayerTabs(prev => prev[layer] === tab ? prev : { ...prev, [layer]: tab });
  }, []);

  const handleSubGraphTabChange = useCallback((slug: string, tab: SubGraphTab) => {
    setSubGraphTabs(prev => prev[slug] === tab ? prev : { ...prev, [slug]: tab });
  }, []);

  // M2 keeps the user's origin stable: linked entities open in the detail
  // pane, but the underlying layer/sub-graph page does not silently change
  // until S5 adds breadcrumbs that can make that movement visible.
  const handleNavigate = useCallback((uri: string, originScrollKey?: string) => {
    openEntityDetail(uri, originScrollKey);
  }, [openEntityDetail]);

  const handleDetailClose = useCallback(() => {
    const origin = detailOriginRef.current;
    detailOriginRef.current = null;
    setSelectedUri(null);
    if (!origin) return;
    setActiveLayer(origin.activeLayer);
    setActiveSubGraph(origin.activeSubGraph);
    setLayerContentTabs(origin.layerTabs);
    setOverviewExpandedLayer(origin.overviewExpandedLayer);
    setOverviewLayerTabs(origin.overviewLayerTabs);
    setSubGraphTabs(origin.subGraphTabs);
    pendingScrollRestoreRef.current = origin.scroll;
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    if (node?.id) handleNavigate(node.id);
  }, [handleNavigate]);

  const handleOverviewActivityNavigate = useCallback((uri: string) => {
    handleNavigate(uri, 'page');
  }, [handleNavigate]);

  const handleOverviewStripNavigate = useCallback((uri: string) => {
    const key = overviewExpandedLayer
      ? `layer:${overviewExpandedLayer}:${overviewLayerTabs[overviewExpandedLayer]}`
      : 'page';
    handleNavigate(uri, key);
  }, [handleNavigate, overviewExpandedLayer, overviewLayerTabs]);

  const handleOverviewStripNodeClick = useCallback((node: any) => {
    if (node?.id) handleOverviewStripNavigate(node.id);
  }, [handleOverviewStripNavigate]);

  if (!cg) {
    return (
      <div className="v10-view-placeholder">
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading context graph...</p>
      </div>
    );
  }

  // Active sub-graph binding (for the breadcrumb strip) — stays in scope
  // across sub-graph / layer / overview routes.
  const activeSubGraphBinding = activeSubGraph ? profile.forSubGraph(activeSubGraph) : null;
  const activePage = selectedEntity
    ? 'entity'
    : activeSubGraph
      ? 'subgraph'
      : activeLayer;

  return (
    <ProjectProfileContext.Provider value={profile}>
    <AgentsContext.Provider value={agentsContextValue}>
    <div className="v10-memory-explorer">
      {/* Persistent project chrome — always visible so the user never
          loses "which project am I in" context when drilling into a
          sub-graph, a layer, or an entity detail. */}
      <ProjectHeaderStrip
        cg={cg}
        profile={profile}
        activeSubGraph={activeSubGraphBinding}
        onClearSubGraph={() => handleSelectSubGraph(null)}
      />

      {/* Layer Switcher — always visible now. Clicking a layer from within
          a sub-graph page exits back to that layer's top-level view, which
          is the least surprising thing a persistent top-nav can do. */}
      <LayerSwitcher
        active={activeLayer}
        counts={rawMemory.counts}
        onSwitch={handleLayerSwitch}
        onShare={() => setShowShare(true)}
        onImport={() => setShowImport(true)}
        onRefresh={rawMemory.refresh}
      />

      <main className="v10-memory-explorer-page" data-view={activePage} data-cg-scroll-key="page" ref={pageRef}>
      {/* Drilldown overlay */}
      {selectedEntity && (
        <KADetailView
          entity={selectedEntity}
          allEntities={rawMemory.entities}
          allTriples={rawMemory.graphTriples}
          onNavigate={handleNavigate}
          onClose={handleDetailClose}
          contextGraphId={contextGraphId}
          onRefresh={rawMemory.refresh}
        />
      )}

      {/* Sub-graph page mode — first-class peer of the layer views */}
      {activeSubGraph && !selectedEntity && (
        <>
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          <SubGraphDetailView
            slug={activeSubGraph}
            rawMemory={rawMemory}
            contextGraphId={contextGraphId}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleNavigate}
            activeTab={subGraphTabs[activeSubGraph] ?? 'items'}
            onTabChange={tab => handleSubGraphTabChange(activeSubGraph, tab)}
          />
        </>
      )}

      {/* Overview View */}
      {!activeSubGraph && activeLayer === 'overview' && !selectedEntity && (
        <>
          <ProjectOverviewCard cg={cg} memory={rawMemory} participants={participants} />
          <PendingJoinRequestsBar contextGraphId={contextGraphId} onParticipantsChanged={refreshParticipants} />
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          {rawMemory.loading && (
            <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
          )}
          {rawMemory.error && (
            <div className="v10-me-error">Error: {rawMemory.error}</div>
          )}
          <ActivityFeed
            entities={rawMemory.entityList}
            onSelectEntity={handleOverviewActivityNavigate}
            title="Recent activity"
            limit={40}
            includeUndated={false}
            emptyHint="Once agents start proposing decisions or tasks they'll show up here as a live feed."
            className="v10-overview-activity"
          />
          <MemoryStrip
            memory={rawMemory}
            onSwitchLayer={handleLayerSwitch}
            onSelectEntity={handleOverviewStripNavigate}
            contextGraphId={contextGraphId}
            onNodeClick={handleOverviewStripNodeClick}
            expandedLayer={overviewExpandedLayer}
            onExpandedLayerChange={setOverviewExpandedLayer}
            expandTabs={overviewLayerTabs}
            onExpandTabChange={handleOverviewLayerTabChange}
          />
        </>
      )}

      {/* Graph Overview — one mini graph per sub-graph, side-by-side */}
      {!activeSubGraph && activeLayer === 'graph-overview' && !selectedEntity && (
        <SubGraphOverviewGrid
          contextGraphId={contextGraphId}
          memory={rawMemory}
          onNodeClick={handleNodeClick}
          onSelectSubGraph={handleSelectSubGraph}
        />
      )}

      {!activeSubGraph && activeLayer === 'query' && !selectedEntity && (
        <ContextGraphQueryView contextGraphId={contextGraphId} />
      )}

      {/* Layer Detail Views */}
      {!activeSubGraph && (activeLayer === 'wm' || activeLayer === 'swm' || activeLayer === 'vm') && !selectedEntity && (
        <>
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          <LayerDetailView
            layer={activeLayer}
            memory={rawMemory}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleNavigate}
            contextGraphId={contextGraphId}
            activeTab={layerContentTabs[activeLayer]}
            onTabChange={tab => handleLayerTabChange(activeLayer, tab)}
          />
        </>
      )}

      </main>

      {/* Provenance Bar */}
      <ProvenanceBar memory={rawMemory} />

      <ImportFilesModal
        open={showImport}
        onClose={() => setShowImport(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
      <ShareProjectModal
        open={showShare}
        onClose={() => setShowShare(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
    </div>
    </AgentsContext.Provider>
    </ProjectProfileContext.Provider>
  );
}
