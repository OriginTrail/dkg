import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { useMemoryGraphEvents } from '../hooks/useNodeEvents.js';
import { isUserFacingSubGraph } from '../lib/subGraphs.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../components/Modals/ShareProjectModal.js';
import {
  buildMemoryEntities,
  canonicalEntityUri,
  useMemoryEntities,
  type LayeredTriple,
  type TrustLevel,
} from '../hooks/useMemoryEntities.js';
import { useProjectProfile, ProjectProfileContext } from '../hooks/useProjectProfile.js';
import { useAgents, AgentsContext } from '../hooks/useAgents.js';
import { useCurrentAgent } from '../hooks/useCurrentAgent.js';
import { useSwmAttributions } from '../hooks/useSwmAttributions.js';
import { useAssertionLifecycleEvents } from '../hooks/useAssertionLifecycleEvents.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { SubGraphBar } from '../components/SubGraphBar.js';
import { CONTEXT_GRAPH_PRIMER_TAB } from '../lib/contextGraphPrimer.js';
import { useTabsStore } from '../stores/tabs.js';
import { shouldFetchSwmAttribution, type LayerView, type LayerContentTab, type SubGraphTab } from './project/helpers.js';
import {
  ProjectHeaderStrip,
  LayerSwitcher,
  KADetailView,
  SubGraphDetailView,
  ProjectOverviewCard,
  PendingJoinRequestsSection,
  OverviewPrimerEntry,
  curatorStatusForOverview,
  SubGraphOverviewGrid,
  ContextGraphQueryView,
  LayerDetailView,
} from './project/components.js';

interface ProjectViewProps {
  contextGraphId: string;
}

type MemoryLayerView = Extract<LayerView, 'wm' | 'swm' | 'vm'>;
type ParticipantsStatus = 'loading' | 'ok' | 'error';
type ParticipantsState = {
  contextGraphId: string | null;
  list: string[];
  status: ParticipantsStatus;
};

interface DetailOrigin {
  activeLayer: LayerView;
  activeSubGraph: string | null;
  layerTabs: Record<MemoryLayerView, LayerContentTab>;
  subGraphTabs: Record<string, SubGraphTab>;
  scroll: { key: string; top: number };
}

const DEFAULT_LAYER_TABS: Record<MemoryLayerView, LayerContentTab> = {
  wm: 'items',
  swm: 'items',
  vm: 'items',
};

const TRUST_FOR_LAYER: Record<MemoryLayerView, TrustLevel> = {
  wm: 'working',
  swm: 'shared',
  vm: 'verified',
};

function isMemoryLayerView(layer: LayerView): layer is MemoryLayerView {
  return layer === 'wm' || layer === 'swm' || layer === 'vm';
}

function dedupeTriplesBySpo<T extends { subject: string; predicate: string; object: string }>(triples: T[]): T[] {
  const seen = new Set<string>();
  return triples.filter(t => {
    // Canonicalise wrapped/bare IRIs so this dedup agrees with
    // `buildEntities`' per-entity `tripleCount` dedup
    // (`useMemoryEntities.ts` builds its SPO key from canonical
    // subject/object). Daemon sometimes ships wrapped `<urn:...>`
    // for the same triple it returns bare elsewhere; without
    // canonicalisation here the detail-page Triples tab would show
    // two rows for what the badge counts as one.
    const key = `${canonicalEntityUri(t.subject)}|${t.predicate}|${canonicalEntityUri(t.object)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const [participantsState, setParticipantsState] = useState<ParticipantsState>({
    contextGraphId: null,
    list: [],
    status: 'loading',
  });
  // S2 finalize — Overview "At a glance" needs a subgraph count.
  // Lifted from SubGraphBar's identical fetch so we don't sneak a
  // peer hook into useMemoryEntities. `null` = not yet known; the
  // stat strip then suppresses the cell rather than rendering "0".
  // Reserved bookkeeping slugs ('meta', 'assertion') never count.
  // `subGraphFetchFailed` distinguishes "still loading" from
  // "permanently unavailable" (Codex review bug D).
  const [subGraphCount, setSubGraphCount] = useState<number | null>(null);
  const [subGraphFetchFailed, setSubGraphFetchFailed] = useState(false);
  const subGraphRequestRef = useRef(0);
  // Active sub-graph *page* — when set, the middle pane renders the sub-graph
  // detail view instead of the overview / layer views. This is structurally
  // a sibling of `activeLayer`, not a filter over it: sub-graphs are a peer
  // axis to layers, and each axis gets its own first-class page.
  const [activeSubGraph, setActiveSubGraph] = useState<string | null>(null);
  const [selectedLayerContext, setSelectedLayerContext] = useState<MemoryLayerView | null>(null);
  // Mirror `selectedUri` into a ref so `handleNavigate` can read the
  // current value without listing it in deps — listing it caused the
  // callback identity to churn on every entity click and re-ran every
  // downstream memo that consumed `handleNavigate`.
  const selectedUriRef = useRef<string | null>(null);
  useEffect(() => { selectedUriRef.current = selectedUri; }, [selectedUri]);
  const [layerContentTabs, setLayerContentTabs] = useState<Record<MemoryLayerView, LayerContentTab>>(
    DEFAULT_LAYER_TABS,
  );
  const [subGraphTabs, setSubGraphTabs] = useState<Record<string, SubGraphTab>>({});
  const pageRef = useRef<HTMLElement | null>(null);
  const detailOriginRef = useRef<DetailOrigin | null>(null);
  const pendingScrollRestoreRef = useRef<DetailOrigin['scroll'] | null>(null);
  const participantsRequestRef = useRef(0);
  const profile = useProjectProfile(contextGraphId);
  const agentsData = useAgents(contextGraphId);
  const openTab = useTabsStore((s) => s.openTab);
  const { data: currentAgent, loading: currentAgentLoading, error: currentAgentError } = useCurrentAgent();

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
      subGraphTabs: { ...subGraphTabs },
      scroll: { key, top: scrollEl?.scrollTop ?? 0 },
    };
  }, [
    activeLayer,
    activeSubGraph,
    currentScrollKey,
    layerContentTabs,
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

  // Reads `selectedUri` via `selectedUriRef` so the callback identity
  // stays stable across navigation — listing `selectedUri` here would
  // recreate `openEntityDetail` on every entity click, which in turn
  // recreates `handleNavigate` and the cross-tab listener effect (R2-2).
  const openEntityDetail = useCallback((uri: string, originScrollKey?: string) => {
    if (!selectedUriRef.current || !detailOriginRef.current) {
      detailOriginRef.current = captureDetailOrigin(originScrollKey);
    }
    setSelectedUri(uri);
  }, [captureDetailOrigin]);

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
  // to *this* project. R2-3 fix: clear `selectedLayerContext` before
  // routing to `openEntityDetail`. Without this, an in-progress detail
  // open (e.g. user opened a WM entity then alt-tabbed without closing)
  // leaves `detailEntities` scoped to the prior layer, so a cross-tab
  // open for a non-WM entity lands in a slice that doesn't contain it,
  // `selectedEntity` resolves to null, and the cleanup effect silently
  // clears the selection — the cross-tab open is dropped on the floor.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail) return;
      if (detail.contextGraphId !== contextGraphId) return;
      if (typeof detail.entityUri !== 'string') return;
      setSelectedLayerContext(null);
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
  // SWM attribution drives the SWM graph's agent-tint legend (its
  // sole remaining consumer). PR #694 review — the Overview no
  // longer reads this stream (lifecycle source replaced it), so the
  // gate is `'swm'`-only now (see `shouldFetchSwmAttribution`); the
  // 5k-row SPARQL no longer fires on Overview renders.
  const swmAttributionNeeded = shouldFetchSwmAttribution({ activeLayer, activeSubGraph });
  const swmAttributionsResult = useSwmAttributions(swmAttributionNeeded ? contextGraphId : undefined);

  // N6 polish (task #23) — bundle-keyed lifecycle events feed the
  // Overview activity feed. Gated to Overview only (PR #694 Comment
  // 20 — we don't fire the 5k-row SPARQL on WM/SWM/VM/Query tabs
  // where nothing consumes it). The hook now PRESERVES its last
  // successful result when the gate flips off (PR #694 Comment 16),
  // so returning to Overview shows the cached events immediately
  // while a background refresh runs — no empty-feed flicker. SWM
  // graph attribution coloring stays on `useSwmAttributions`
  // (separate source of truth for the legend).
  const overviewIsActive = !activeSubGraph && activeLayer === 'overview';
  const lifecycleEventsResult = useAssertionLifecycleEvents(
    overviewIsActive ? contextGraphId : undefined,
  );
  // PR #694 review fix (Comment 6) — when the Overview is the
  // active consumer, pass `[]` during the transition window (cold
  // load, project switch, or post-leave-and-return) instead of
  // `undefined`. The joiner contract is presence-keyed: `[]` opts
  // INTO the lifecycle source (legacy `dcterms:created`-derived
  // `'added'` rows are suppressed); `undefined` falls back to the
  // legacy path. Passing `undefined` mid-transition let legacy
  // rows render briefly before the fetch resolved, then flipped
  // to lifecycle rows — exactly the shape-change Comment 4 was
  // meant to prevent. Empty briefly is better than wrong-shape
  // briefly. Off-Overview we still pass `undefined` so other
  // callers (none today; future surfaces) get the legacy path.
  const overviewLifecycleEvents = overviewIsActive
    ? (lifecycleEventsResult.resultContextGraphId === contextGraphId
        ? lifecycleEventsResult.events
        : [])
    : undefined;
  // PR #694 Comment 8 — plumb the lifecycle error so the feed can
  // distinguish "loaded with zero rows" from "the query failed".
  // After the Comment 3 fix, `resultContextGraphId` advances in
  // both success and catch paths, so consumers can't infer failure
  // from the events array alone. Only surface the error to the
  // Overview consumer; off-Overview the prop stays undefined so
  // legacy callers don't grow an error pathway they don't use.
  const overviewLifecycleError = overviewIsActive
    && lifecycleEventsResult.resultContextGraphId === contextGraphId
    ? lifecycleEventsResult.error
    : null;

  const refreshParticipants = useCallback(() => {
    const targetId = cg?.id;
    if (!targetId) return;
    const requestId = participantsRequestRef.current + 1;
    participantsRequestRef.current = requestId;
    setParticipantsState({ contextGraphId: targetId, list: [], status: 'loading' });
    api.listParticipants(targetId)
      .then(data => {
        if (participantsRequestRef.current !== requestId) return;
        setParticipantsState({ contextGraphId: targetId, list: data.allowedAgents, status: 'ok' });
      })
      .catch(() => {
        if (participantsRequestRef.current !== requestId) return;
        setParticipantsState({ contextGraphId: targetId, list: [], status: 'error' });
      });
  }, [cg?.id]);

  useEffect(() => { refreshParticipants(); }, [refreshParticipants]);

  const refreshSubGraphCount = useCallback(() => {
    const requestId = ++subGraphRequestRef.current;
    // Codex review bug F — route through api-wrapper so the
    // Subgraphs stat resolves in mock mode (the direct
    // `../api.js` import bypassed the mock/offline fallback and
    // left the cell stuck in the loading state forever).
    api.fetchSubGraphs(contextGraphId)
      .then(res => {
        if (subGraphRequestRef.current !== requestId) return;
        // Codex review issue M — single source of truth for the
        // reserved-slug rule. Used by SubGraphBar (chips),
        // SubGraphOverviewGrid (cards), and this Overview stat.
        // Previously diverged between sites; centralising avoids
        // future drift.
        const count = (res.subGraphs ?? []).filter(isUserFacingSubGraph).length;
        setSubGraphCount(count);
        setSubGraphFetchFailed(false);
      })
      .catch(() => {
        if (subGraphRequestRef.current !== requestId) return;
        // Codex review bug D — distinguish "still loading" (count
        // null + failed=false) from "permanently unavailable"
        // (count null + failed=true) so the stat strip can render
        // 'Unavailable' instead of a perpetual ellipsis.
        setSubGraphCount(null);
        setSubGraphFetchFailed(true);
      });
  }, [contextGraphId]);

  useEffect(() => {
    setSubGraphCount(null);
    setSubGraphFetchFailed(false);
    refreshSubGraphCount();
  }, [refreshSubGraphCount]);
  useMemoryGraphEvents(contextGraphId, refreshSubGraphCount);

  const selectedLayerTrust = selectedLayerContext ? TRUST_FOR_LAYER[selectedLayerContext] : null;
  const detailEntityTriples = useMemo(
    () => selectedLayerTrust
      ? rawMemory.allTriples.filter(t => t.layer === selectedLayerTrust)
      : rawMemory.graphTriples,
    [rawMemory.allTriples, rawMemory.graphTriples, selectedLayerTrust],
  );
  const detailTriples = useMemo(
    () => selectedLayerTrust ? dedupeTriplesBySpo(detailEntityTriples) : detailEntityTriples,
    [detailEntityTriples, selectedLayerTrust],
  );
  const detailEntities = useMemo(
    () => selectedLayerTrust
      ? buildMemoryEntities(detailEntityTriples as LayeredTriple[])
      : rawMemory.entities,
    [detailEntityTriples, rawMemory.entities, selectedLayerTrust],
  );
  const selectedEntity = useMemo(
    () => selectedUri ? detailEntities.get(selectedUri) ?? null : null,
    [selectedUri, detailEntities]
  );

  useEffect(() => {
    if (!selectedUri || selectedEntity || rawMemory.loading) return;
    setSelectedUri(null);
    setSelectedLayerContext(null);
    clearDetailOrigin();
  }, [selectedUri, selectedEntity, rawMemory.loading, clearDetailOrigin]);

  // Route a sub-graph chip click to the sub-graph page. Selecting "All"
  // (null) exits the page back to the current layer view, or overview if
  // we were already on one.
  const handleSelectSubGraph = useCallback((slug: string | null) => {
    clearDetailOrigin();
    setActiveSubGraph(slug);
    setSelectedUri(null);
    setSelectedLayerContext(null);
  }, [clearDetailOrigin]);

  const handleLayerSwitch = useCallback((layer: LayerView) => {
    clearDetailOrigin();
    setActiveLayer(layer);
    setSelectedUri(null);
    setSelectedLayerContext(null);
    setActiveSubGraph(null);
  }, [clearDetailOrigin]);

  const handleLayerTabChange = useCallback((layer: MemoryLayerView, tab: LayerContentTab) => {
    setLayerContentTabs(prev => prev[layer] === tab ? prev : { ...prev, [layer]: tab });
  }, []);

  const handleSubGraphTabChange = useCallback((slug: string, tab: SubGraphTab) => {
    setSubGraphTabs(prev => prev[slug] === tab ? prev : { ...prev, [slug]: tab });
  }, []);

  // M2 keeps the user's origin stable: linked entities open in the detail
  // pane, but the underlying layer/sub-graph page does not silently change
  // until S5 adds breadcrumbs that can make that movement visible.
  //
  // Intent: a brand-new top-level open (no selected entity yet) resets
  // the layer context; in-detail navigation (a click inside an open
  // detail) keeps the prior layer context. We read both `selectedUri`
  // (via ref) and the prior `selectedLayerContext` (via the setter
  // `prev` argument) so the callback identity stays stable — listing
  // them in deps would re-create `handleNavigate` on every navigation
  // and rebuild every downstream memo / callback that consumes it.
  const handleNavigate = useCallback((uri: string, originScrollKey?: string, layerContext?: MemoryLayerView) => {
    const hadSelection = selectedUriRef.current != null;
    openEntityDetail(uri, originScrollKey);
    setSelectedLayerContext(prev => layerContext ?? (hadSelection ? prev : null));
  }, [openEntityDetail]);

  const handleDetailClose = useCallback(() => {
    const origin = detailOriginRef.current;
    detailOriginRef.current = null;
    setSelectedUri(null);
    setSelectedLayerContext(null);
    if (!origin) return;
    setActiveLayer(origin.activeLayer);
    setActiveSubGraph(origin.activeSubGraph);
    setLayerContentTabs(origin.layerTabs);
    setSubGraphTabs(origin.subGraphTabs);
    pendingScrollRestoreRef.current = origin.scroll;
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    if (!node?.id) return;
    const layerContext = isMemoryLayerView(node.trustLayer) ? node.trustLayer : undefined;
    handleNavigate(node.id, undefined, layerContext);
  }, [handleNavigate]);

  const handleLayerSelectEntity = useCallback((uri: string) => {
    const layerContext = isMemoryLayerView(activeLayer) ? activeLayer : undefined;
    handleNavigate(uri, undefined, layerContext);
  }, [activeLayer, handleNavigate]);

  const handleOverviewActivityNavigate = useCallback((uri: string) => {
    handleNavigate(uri, 'page');
  }, [handleNavigate]);

  const handleOpenPrimer = useCallback(() => {
    openTab(CONTEXT_GRAPH_PRIMER_TAB);
  }, [openTab]);

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
  const participantsForCurrentGraph = participantsState.contextGraphId === cg.id
    ? participantsState.list
    : [];
  const participantsStatusForCurrentGraph = participantsState.contextGraphId === cg.id
    ? participantsState.status
    : 'loading';

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
          allEntities={detailEntities}
          allTriples={detailTriples}
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

      {/* Overview View — S2 finalize section order (§4.2.1):
          identity row + At a glance + Knowledge Pipeline + Participant
          agents live inside ProjectOverviewCard. Pending join requests
          is a peer section below it (curator-only). Recent activity
          moves to the last content row before the primer escape hatch
          which lives inside the card's footer. */}
      {!activeSubGraph && activeLayer === 'overview' && !selectedEntity && (
        <>
          <ProjectOverviewCard
            cg={cg}
            memory={rawMemory}
            subGraphCount={subGraphCount}
            subGraphFetchFailed={subGraphFetchFailed}
            participants={participantsForCurrentGraph}
            participantsStatus={participantsStatusForCurrentGraph}
            currentAgent={currentAgent ?? null}
            currentAgentStatus={currentAgentLoading ? 'loading' : currentAgentError ? 'error' : 'ok'}
            onSwitchLayer={handleLayerSwitch}
            onOpenPrimer={handleOpenPrimer}
          />
          <PendingJoinRequestsSection
            contextGraphId={contextGraphId}
            curatorStatus={curatorStatusForOverview({
              cg,
              currentAgent: currentAgent ?? null,
              currentAgentStatus: currentAgentLoading ? 'loading' : currentAgentError ? 'error' : 'ok',
            })}
            onParticipantsChanged={refreshParticipants}
          />
          {rawMemory.loading && (
            <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
          )}
          {rawMemory.error && (
            <div className="v10-me-error">Error: {rawMemory.error}</div>
          )}
          <div data-section="activity">
            <ActivityFeed
              entities={rawMemory.entityList}
              lifecycleEvents={overviewLifecycleEvents}
              lifecycleError={overviewLifecycleError}
              onSelectEntity={handleOverviewActivityNavigate}
              title="Recent activity"
              limit={40}
              includeUndated={false}
              emptyHint="Once knowledge starts being added and managed in this context graph, activities will show up here as a live feed."
              className="v10-overview-activity"
            />
          </div>
          <OverviewPrimerEntry onOpenPrimer={handleOpenPrimer} />
        </>
      )}

      {/* Subgraphs — one mini graph per sub-graph, side-by-side */}
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
            layer={activeLayer}
          />
          <LayerDetailView
            layer={activeLayer}
            memory={rawMemory}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleLayerSelectEntity}
            contextGraphId={contextGraphId}
            activeTab={layerContentTabs[activeLayer]}
            onTabChange={tab => handleLayerTabChange(activeLayer, tab)}
            swmAttribution={swmAttributionsResult}
          />
        </>
      )}

      </main>

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
