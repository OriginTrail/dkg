import React, { useCallback, useId, useState } from 'react';
import { ChevronRight, Eye, X, RefreshCw, LogIn, Plus } from 'lucide-react';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import { chooseOpenTab, chooseTab as openTab } from '../../lib/shellNavigation.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import { useJourneyStore } from '../../stores/journey.js';
import { useContextGraphDialogs } from '../../stores/contextGraphDialogs.js';
import { useContextGraphInventory, refreshContextGraphInventory } from '../../hooks/useContextGraphInventory.js';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling.js';
import { useHiddenContextGraphIds as useHiddenProjectIds } from '../../hooks/useHiddenContextGraphIds.js';
import {
  fetchLocalAgentIntegrations,
  type LocalAgentIntegration,
  type LocalAgentIntegrationStatus,
} from '../../api.js';
import { ContextGraphMark } from '../../context-graph-colors.js';
import {
  belongsInPublicSidebar,
  belongsInMyProjectsSidebar,
  classifyPublicEntry,
  toSidebarIdentity,
  type AgentSidebarIdentity,
} from '../../lib/contextGraphSidebar.js';
import { DASHBOARD_ICON, placeIcon } from './nav-icons.js';
import { NODE_PLACE_IDS, PLACES } from '../../lib/tab-target.js';
import { Loading } from '../ds/Loading.js';

const NODE_PLACES = NODE_PLACE_IDS.map((id) => ({ id, ...PLACES[id], icon: placeIcon(id) }));

// Project tree row: a flat, clickable header that opens the project tab.
// Memory-layer expansion was removed by request — layers are surfaced inside
// the project view rather than as nested sidebar items.


// Hidden-context-graph dismiss is now the shared `useHiddenProjectIds`
// (aliased import above) so PanelLeft, the Memory Stack and the Dashboard
// filter on the identical set — required for sidebar/dashboard parity.

interface ProjectTreeItemProps {
  cg: ContextGraph;
  isActive: boolean;
  onSelect: () => void;
  onHide: () => void;
}

function ProjectTreeItem({
  cg,
  isActive,
  onSelect,
  onHide,
}: ProjectTreeItemProps) {
  return (
    <div className="v10-tree-section">
      <div
        className={`v10-tree-section-header ${isActive ? 'active' : ''}`}
        onClick={onSelect}
      >
        <ContextGraphMark id={cg.id} name={cg.name} />
        <button type="button" className="v10-tree-section-label ds-row-open">{cg.name || cg.id.slice(0, 16)}</button>
        <button
          type="button"
          className="v10-tree-hide-btn ds-btn ds-ghost ds-sm ds-icon"
          aria-label={`Hide ${cg.name || cg.id.slice(0, 16)} from the sidebar`} title="Hide this context graph from the sidebar (reversible)"
          onClick={(e) => { e.stopPropagation(); onHide(); }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

interface PublicCatalogueItemProps {
  cg: ContextGraph;
  isBrowsing: boolean;
  onBrowse: () => void;
  onSubscribe: () => void;
  onHide: () => void;
}

function PublicCatalogueItem({
  cg,
  isBrowsing,
  onBrowse,
  onSubscribe,
  onHide,
}: PublicCatalogueItemProps) {
  const label = cg.name || cg.id.slice(0, 16);
  return (
    <div className="v10-tree-section">
      <div className={`v10-tree-section-header catalogue ${isBrowsing ? 'active' : ''}`}>
        <ContextGraphMark id={cg.id} name={cg.name} />
        <span className="v10-tree-section-label">{label}</span>
        <button
          type="button"
          className="v10-tree-catalogue-btn ds-btn ds-sm"
          aria-label={`Browse ${label}`}
          onClick={onBrowse}
        >
          Browse
        </button>
        <button
          type="button"
          className="v10-tree-catalogue-btn primary ds-btn ds-primary ds-sm"
          aria-label={`Subscribe to ${label}`}
          onClick={onSubscribe}
        >
          Subscribe
        </button>
        <button
          type="button"
          className="v10-tree-hide-btn ds-btn ds-ghost ds-sm ds-icon"
          aria-label={`Hide ${cg.name || cg.id.slice(0, 16)} from the sidebar`} title="Hide this context graph from the sidebar (reversible)"
          onClick={onHide}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// Maps local-agent integration status → status-dot color. Kept inline (vs new
// CSS classes) because the four states map 1:1 to existing semantic palette
// vars and there's no shared status-dot component to extend.
function localAgentDotColor(status: LocalAgentIntegrationStatus): string {
  switch (status) {
    case 'chat_ready':
      return 'var(--accent-green)';
    case 'connecting':
    case 'degraded':
      return 'var(--accent-amber)';
    case 'bridge_offline':
      return 'var(--accent-red)';
    case 'available':
    case 'coming_soon':
    default:
      return 'var(--text-tertiary)';
  }
}

// Body of the Integrations sidebar section. Open/closed state is owned by
// the layout store; this component is only mounted while the section is
// open, so the 30s polling effect naturally pauses when the user
// collapses the section (no in-component `if (!open) return` guard).
function IntegrationsSectionBody() {
  const [localAgents, setLocalAgents] = useState<LocalAgentIntegration[]>([]);
  const [localAgentsError, setLocalAgentsError] = useState<string | null>(null);

  // BUG-007: 30 s poll now pauses while the tab is hidden via the
  // shared `useVisibilityPolling` hook (was a raw `setInterval` that
  // burned 2 calls/min while the user was off-tab). The cancelled
  // guard is no longer needed because the hook owns its own
  // tear-down lifecycle.
  const loadLocal = useCallback(() => {
    fetchLocalAgentIntegrations()
      .then((r) => { setLocalAgents(r.integrations); setLocalAgentsError(null); })
      .catch((e: Error) => setLocalAgentsError(e.message));
  }, []);
  useVisibilityPolling(loadLocal, 30_000);

  return (
    <div className="v10-tree-items" style={{ display: 'block' }}>
      <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 12px 2px 24px' }}>
        Agents
      </div>
      {localAgentsError && (
        <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-danger)', padding: '4px 12px 4px 24px' }}>
          {localAgentsError}
        </div>
      )}
      {!localAgentsError && localAgents.length === 0 && (
        <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', padding: '4px 12px 4px 24px', fontStyle: 'italic' }}>
          No agents detected.
        </div>
      )}
      {localAgents.map((a) => (
        <div
          key={a.id}
          className="v10-tree-item"
          title={a.detail}
          style={{ cursor: 'default' }}
        >
          <span
            aria-label={a.statusLabel}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: localAgentDotColor(a.status),
              flexShrink: 0,
            }}
          />
          <span className="v10-tree-item-label">{a.name}</span>
          <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', marginLeft: 4 }}>
            {a.statusLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PanelLeft() {
  const leftSectionMyProjectsOpen = useLayoutStore((s) => s.leftSectionMyProjectsOpen);
  const leftSectionIntegrationsOpen = useLayoutStore((s) => s.leftSectionIntegrationsOpen);
  const toggleLeftSectionMyProjects = useLayoutStore((s) => s.toggleLeftSectionMyProjects);
  const leftSectionPublicOpen = useLayoutStore((s) => s.leftSectionPublicOpen);
  const toggleLeftSectionPublic = useLayoutStore((s) => s.toggleLeftSectionPublic);
  const toggleLeftSectionIntegrations = useLayoutStore((s) => s.toggleLeftSectionIntegrations);
  // Stable per-render ids for the section bodies so the chevron buttons
  // can use `aria-controls` to point at the disclosed region (screen
  // readers can then programmatically associate trigger ↔ content).
  const myProjectsBodyId = useId();
  const integrationsBodyId = useId();
  const publicGraphsBodyId = useId();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const { activeProjectId, setActiveProject } = useProjectsStore();
  const { contextGraphs, error: listError, identity: sharedAgent,
    inventoryLoading, inventoryError } = useContextGraphInventory();
  const stage = useJourneyStore((s) => s.stage);

  const { hidden: hiddenIds, hide: hideProject, unhideAll } = useHiddenProjectIds();
  const agentIdentity: AgentSidebarIdentity | null = sharedAgent.data ? toSidebarIdentity(sharedAgent.data) : null;

  const visibleContextGraphs = contextGraphs.filter((cg) => !hiddenIds.has(cg.id));
  const myProjects = visibleContextGraphs.filter((cg) =>
    belongsInMyProjectsSidebar(cg, agentIdentity));
  const publicContextGraphs = visibleContextGraphs.filter((cg) =>
    belongsInPublicSidebar(cg, agentIdentity));
  const hiddenCount = contextGraphs.length - visibleContextGraphs.length;

  const openCreateModal = useContextGraphDialogs((s) => s.openCreate);
  const openJoinModal = useContextGraphDialogs((s) => s.openJoin);

  return (
    <div className="v10-panel-left">
      <nav className="v10-sidebar-places" aria-label="Places">
        <button
          type="button"
          className={`v10-tree-dashboard ${activeTabId === 'dashboard' ? 'active' : ''}`}
          aria-current={activeTabId === 'dashboard' ? 'page' : undefined}
          onClick={() => { chooseOpenTab('dashboard'); setActiveProject(null); }}
        >
          <span className="v10-sidebar-place-icon">{DASHBOARD_ICON}</span> Dashboard
        </button>
        <button
          type="button"
          className={`v10-tree-dashboard ${activeTabId === 'memory-stack' ? 'active' : ''}`}
          aria-current={activeTabId === 'memory-stack' ? 'page' : undefined}
          title={PLACES['memory-stack'].title}
          onClick={() => openTab({ id: 'memory-stack', label: PLACES['memory-stack'].label, closable: true })}
        >
          <span className="v10-sidebar-place-icon">{placeIcon('memory-stack')}</span> {PLACES['memory-stack'].label}
        </button>
      </nav>

      <div className="v10-tree-create-actions">
        <button className="v10-new-project-btn ds-btn" aria-label="New context graph" title="New context graph" onClick={openCreateModal}><Plus size={14} aria-hidden="true" />New</button>
        <button className="v10-new-project-btn ds-btn" aria-label="Join context graph" title="Join context graph" onClick={() => openJoinModal()}><LogIn size={14} aria-hidden="true" />Join</button>
      </div>

      {inventoryError && (
        <div className="v10-journey-empty-card ds-card" role="alert">
          <div>{listError ? 'Context graphs unavailable. ' : ''}{sharedAgent.error ? 'Agent identity unavailable.' : ''}</div>
          <div>{contextGraphs.length ? 'Showing the last available context graphs.' : 'Context graph membership is unknown.'}</div>
          <button type="button" className="ds-btn ds-sm" disabled={inventoryLoading} onClick={() => { void refreshContextGraphInventory(true); }}><RefreshCw size={12} />Retry</button>
        </div>
      )}
      {inventoryLoading && contextGraphs.length === 0 && <Loading label="Loading context graphs…" />}

      <div className="v10-tree-content">
          {/* Empty-state card hoisted ABOVE the collapsible sections so it
              stays visible if both sections are collapsed. */}
          {contextGraphs.length === 0 && stage <= 1 && !inventoryError && !inventoryLoading && (
            <div className="v10-journey-empty-card ds-card">
              <div className="v10-jec-title">No context graphs yet</div>
              <div className="v10-jec-hint">
                {stage === 0
                  ? 'Connect an agent to get started.'
                  : 'Create your first context graph to give your agent structured memory.'}
              </div>
              {stage === 1 && (
                <button className="v10-new-project-btn ds-btn" style={{ margin: 0 }} onClick={openCreateModal}>
                  <Plus size={14} aria-hidden="true" />Create your first context graph
                </button>
              )}
            </div>
          )}

          {/* Section A: My Context Graphs (default expanded). Uses the
              .v10-peer-group-* pattern from the right panel — polished
              focus-visible + prefers-reduced-motion + button semantics.
              Header renders even when `myProjects` is empty (but at
              least one CG exists, or the journey is past first-run) —
              otherwise a sidebar with only public CGs
              would collapse to a lone "Integrations" header
              (qa-lead). The empty-state journey card above handles the
              "no CGs at all" first-run case. */}
          {(contextGraphs.length > 0 || stage >= 2) && (
            <div className="v10-peer-group">
              <button
                type="button"
                className="v10-peer-group-header"
                aria-expanded={leftSectionMyProjectsOpen}
                aria-controls={myProjectsBodyId}
                onClick={toggleLeftSectionMyProjects}
              >
                <ChevronRight
                  size={14}
                  className={`v10-peer-group-chevron ${leftSectionMyProjectsOpen ? 'expanded' : ''}`}
                  aria-hidden="true"
                />
                <span className="v10-peer-group-label">My context graphs</span>
              </button>
              {leftSectionMyProjectsOpen && (
                <div id={myProjectsBodyId} className="v10-peer-group-body">
                  {myProjects.length === 0 ? (
                    <div
                      className="v10-tree-item"
                      style={{ cursor: 'default', color: 'var(--text-tertiary)', fontStyle: 'italic' }}
                    >
                      <span className="v10-tree-item-label">{inventoryError ? 'Context graph membership unavailable.' : inventoryLoading ? 'Loading context graphs…' : 'No context graphs in this view yet.'}</span>
                    </div>
                  ) : myProjects.map((cg) => (
                    <ProjectTreeItem
                      key={cg.id}
                      cg={cg}
                      isActive={activeProjectId === cg.id}
                      onSelect={() => {
                        setActiveProject(cg.id);
                        openTab({ id: `project:${cg.id}`, label: cg.name || cg.id.slice(0, 16), closable: true });
                      }}
                      onHide={() => {
                        hideProject(cg.id);
                        if (activeProjectId === cg.id) setActiveProject(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}


          {/* Section B: public Context Graphs this node has discovered but
              not joined. A catalogue, so rows offer browse and subscribe. */}
          {(contextGraphs.length > 0 || stage >= 2) && (
            <div className="v10-peer-group">
              <button
                type="button"
                className="v10-peer-group-header"
                aria-expanded={leftSectionPublicOpen}
                aria-controls={publicGraphsBodyId}
                onClick={toggleLeftSectionPublic}
              >
                <ChevronRight
                  size={14}
                  className={`v10-peer-group-chevron ${leftSectionPublicOpen ? 'expanded' : ''}`}
                  aria-hidden="true"
                />
                <span className="v10-peer-group-label">Public context graphs</span>
              </button>
              {leftSectionPublicOpen && (
                <div id={publicGraphsBodyId} className="v10-peer-group-body">
                  {publicContextGraphs.map((cg) => {
                    const onHide = () => {
                      hideProject(cg.id);
                      if (activeProjectId === cg.id) setActiveProject(null);
                    };
                    if (classifyPublicEntry(cg) === 'catalogue') {
                      return (
                        <PublicCatalogueItem
                          key={cg.id}
                          cg={cg}
                          isBrowsing={activeTabId === `project:${cg.id}`}
                          onBrowse={() => {
                            setActiveProject(null);
                            openTab({
                              id: `project:${cg.id}`,
                              label: cg.name || cg.id.slice(0, 16),
                              closable: true,
                            });
                          }}
                          onSubscribe={() => openJoinModal(cg.id)}
                          onHide={onHide}
                        />
                      );
                    }
                    return (
                      <ProjectTreeItem
                        key={cg.id}
                        cg={cg}
                        isActive={activeProjectId === cg.id}
                        onSelect={() => {
                          setActiveProject(cg.id);
                          openTab({ id: `project:${cg.id}`, label: cg.name || cg.id.slice(0, 16), closable: true });
                        }}
                        onHide={onHide}
                      />
                    );
                  })}
                  {publicContextGraphs.length === 0 && !inventoryError && !inventoryLoading && (
                    <p className="v10-tree-hint">Public context graphs appear here as your node discovers them. Use <strong>Join</strong> to subscribe by ID.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Section C: Integrations (default collapsed — escape-hatch
              surface). Body is only mounted while open, so the 30s
              polling effect in IntegrationsSectionBody naturally pauses
              when collapsed. */}
          {stage >= 1 && (
            <div className="v10-peer-group">
              <button
                type="button"
                className="v10-peer-group-header"
                aria-expanded={leftSectionIntegrationsOpen}
                aria-controls={integrationsBodyId}
                onClick={toggleLeftSectionIntegrations}
              >
                <ChevronRight
                  size={14}
                  className={`v10-peer-group-chevron ${leftSectionIntegrationsOpen ? 'expanded' : ''}`}
                  aria-hidden="true"
                />
                <span className="v10-peer-group-label">Integrations</span>
              </button>
              {leftSectionIntegrationsOpen && (
                <div id={integrationsBodyId} className="v10-peer-group-body">
                  <IntegrationsSectionBody />
                </div>
              )}
            </div>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="v10-tree-show-hidden"
              onClick={unhideAll}
              title="Restore all context graphs dismissed from the sidebar"
            >
              <Eye size={12} /> Show {hiddenCount} hidden context graph{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}
      </div>

      {/* Node-level places: every destination lives in the sidebar
          (DESIGN.md · Navigation); the header keeps only status and
          global controls. */}
      <nav className="v10-sidebar-node" aria-label="Node">
        <div className="v10-sidebar-group-label">Node</div>
        {NODE_PLACES.map((place) => (
          <button
            key={place.id}
            type="button"
            className={`v10-tree-dashboard v10-sidebar-place ${activeTabId === place.id ? 'active' : ''}`}
            aria-current={activeTabId === place.id ? 'page' : undefined}
            data-testid={place.testId}
            title={place.title}
            onClick={() => openTab({ id: place.id, label: place.label, closable: true })}
          >
            <span className="v10-sidebar-place-icon">{place.icon}</span>
            {place.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
