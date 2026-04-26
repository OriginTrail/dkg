import { useMemo, useState, useCallback, useEffect } from 'react';
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
import type { LayerView } from './project/helpers.js';
import {
  ProjectHeaderStrip,
  LayerSwitcher,
  KADetailView,
  SubGraphDetailView,
  ProjectOverviewCard,
  PendingJoinRequestsBar,
  MemoryStrip,
  SubGraphOverviewGrid,
  LayerDetailView,
  ProvenanceBar,
} from './project/components.js';

interface ProjectViewProps {
  contextGraphId: string;
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
  const profile = useProjectProfile(contextGraphId);
  const agentsData = useAgents(contextGraphId);
  const openTab = useTabsStore((s) => s.openTab);

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
      setSelectedUri(detail.entityUri);
    };
    window.addEventListener('v10:open-entity', handler);
    return () => window.removeEventListener('v10:open-entity', handler);
  }, [contextGraphId]);

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

  // Route a sub-graph chip click to the sub-graph page. Selecting "All"
  // (null) exits the page back to the current layer view, or overview if
  // we were already on one.
  const handleSelectSubGraph = useCallback((slug: string | null) => {
    setActiveSubGraph(slug);
    setSelectedUri(null);
  }, []);

  // Cross-sub-graph jump: when the user clicks an entity link that lives
  // in a different sub-graph, switch pages and open the entity detail.
  // Falls back to just opening the detail if the entity has no sub-graph
  // origin (SWM/VM entities without WM presence).
  const handleNavigate = useCallback((uri: string) => {
    const target = rawMemory.entities.get(uri);
    if (target && target.subGraphs.size > 0) {
      // Prefer the active sub-graph if the entity lives in it (stay put);
      // otherwise hop to the first sub-graph it belongs to.
      if (!activeSubGraph || !target.subGraphs.has(activeSubGraph)) {
        const next = target.subGraphs.values().next().value;
        if (next && next !== 'meta') setActiveSubGraph(next);
      }
    }
    setSelectedUri(uri);
  }, [rawMemory.entities, activeSubGraph]);

  const handleNodeClick = useCallback((node: any) => {
    if (node?.id) handleNavigate(node.id);
  }, [handleNavigate]);

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
        onSwitch={v => { setActiveLayer(v); setSelectedUri(null); setActiveSubGraph(null); }}
        onShare={() => setShowShare(true)}
        onImport={() => setShowImport(true)}
        onRefresh={rawMemory.refresh}
      />



      {/* Drilldown overlay */}
      {selectedEntity && (
        <KADetailView
          entity={selectedEntity}
          allEntities={rawMemory.entities}
          allTriples={rawMemory.graphTriples}
          onNavigate={handleNavigate}
          onClose={() => setSelectedUri(null)}
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
            onSelectEntity={handleNavigate}
            title="Recent activity"
            limit={40}
            includeUndated={false}
            emptyHint="Once agents start proposing decisions or tasks they'll show up here as a live feed."
          />
          <MemoryStrip
            memory={rawMemory}
            onSwitchLayer={setActiveLayer}
            onSelectEntity={handleNavigate}
            contextGraphId={contextGraphId}
            onNodeClick={handleNodeClick}
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
          />
        </>
      )}

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
