import React, { useCallback, useEffect, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import { useJourneyStore } from '../../stores/journey.js';
import { api } from '../../api-wrapper.js';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { useNodeEvents } from '../../hooks/useNodeEvents.js';
import { useHiddenContextGraphIds as useHiddenProjectIds } from '../../hooks/useHiddenContextGraphIds.js';
import {
  fetchCurrentAgent,
  fetchLocalAgentIntegrations,
  type AgentIdentity,
  type LocalAgentIntegration,
  type LocalAgentIntegrationStatus,
} from '../../api.js';
import {
  belongsInContextOracleSidebar,
  belongsInMyProjectsSidebar,
  toSidebarIdentity,
  type AgentSidebarIdentity,
} from '../../lib/contextGraphSidebar.js';

// Project tree row: a flat, clickable header that opens the project tab.
// Memory-layer expansion was removed by request — layers are surfaced inside
// the project view rather than as nested sidebar items.

type TreeMode = 'explorer' | 'oracle';

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
        <span className="v10-tree-project-dot" />
        <span className="v10-tree-section-label">{cg.name || cg.id.slice(0, 16)}</span>
        <button
          type="button"
          className="v10-tree-hide-btn"
          title="Hide this context graph from the sidebar (reversible)"
          onClick={(e) => { e.stopPropagation(); onHide(); }}
        >
          ×
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
      return 'var(--accent-green, #22c55e)';
    case 'connecting':
      return 'var(--accent-yellow, #eab308)';
    case 'degraded':
    case 'bridge_offline':
      return 'var(--accent-orange, #f97316)';
    case 'available':
    case 'coming_soon':
    default:
      return 'var(--text-tertiary, #6b7280)';
  }
}

// Body of the Integrations sidebar section. Open/closed state is owned by
// the layout store; this component is only mounted while the section is
// open, so the 30s polling effect naturally pauses when the user
// collapses the section (no in-component `if (!open) return` guard).
function IntegrationsSectionBody() {
  const [localAgents, setLocalAgents] = useState<LocalAgentIntegration[]>([]);
  const [localAgentsError, setLocalAgentsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadLocal = () => {
      fetchLocalAgentIntegrations()
        .then((r) => { if (!cancelled) { setLocalAgents(r.integrations); setLocalAgentsError(null); } })
        .catch((e: Error) => { if (!cancelled) setLocalAgentsError(e.message); });
    };
    loadLocal();
    const iv = setInterval(loadLocal, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  return (
    <div className="v10-tree-items" style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 12px 2px 24px' }}>
        Agents
      </div>
      {localAgentsError && (
        <div style={{ fontSize: 11, color: 'var(--accent-orange, #f97316)', padding: '4px 12px 4px 24px' }}>
          {localAgentsError}
        </div>
      )}
      {!localAgentsError && localAgents.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 12px 4px 24px', fontStyle: 'italic' }}>
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
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 4 }}>
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
  const toggleLeftSectionIntegrations = useLayoutStore((s) => s.toggleLeftSectionIntegrations);
  // Stable per-render ids for the section bodies so the chevron buttons
  // can use `aria-controls` to point at the disclosed region (screen
  // readers can then programmatically associate trigger ↔ content).
  const myProjectsBodyId = useId();
  const integrationsBodyId = useId();
  const { openTab, activeTabId, setActiveTab } = useTabsStore();
  const { contextGraphs, setContextGraphs, setLoading, activeProjectId, setActiveProject } = useProjectsStore();
  const stage = useJourneyStore((s) => s.stage);
  const [treeMode, setTreeMode] = useState<TreeMode>('explorer');

  const { hidden: hiddenIds, hide: hideProject, unhideAll } = useHiddenProjectIds();
  const [agentIdentity, setAgentIdentity] = useState<AgentSidebarIdentity | null>(null);

  const visibleContextGraphs = contextGraphs.filter((cg) => !hiddenIds.has(cg.id));
  const myProjects = visibleContextGraphs.filter((cg) =>
    belongsInMyProjectsSidebar(cg, agentIdentity));
  const contextOracleProjects = visibleContextGraphs.filter((cg) =>
    belongsInContextOracleSidebar(cg, agentIdentity));
  const hiddenCount = contextGraphs.length - visibleContextGraphs.length;

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

  const loadCGs = useCallback(() => {
    setLoading(true);
    fetchCurrentAgent().then((a: AgentIdentity) => setAgentIdentity(toSidebarIdentity(a))).catch(() => {});
    api.fetchContextGraphs()
      .then(({ contextGraphs: cgs }: any) => setContextGraphs(cgs ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [setContextGraphs, setLoading]);

  useEffect(() => {
    loadCGs();
    const iv = setInterval(loadCGs, 60_000);
    return () => clearInterval(iv);
  }, [loadCGs]);

  useNodeEvents(useCallback((event) => {
    if (event.type === 'join_approved' || event.type === 'project_synced') {
      loadCGs();
    }
  }, [loadCGs]));

  return (
    <div className="v10-panel-left">
      <div style={{ display: 'flex', gap: 4, padding: '8px 8px 4px' }}>
        <button className="v10-new-project-btn" onClick={() => setShowCreateModal(true)}>+ New Context Graph</button>
        <button className="v10-new-project-btn" onClick={() => setShowJoinModal(true)}>↗ Join Context Graph</button>
      </div>

      <div className="v10-tree-header">
        <button
          className={`v10-tree-mode-btn ${treeMode === 'explorer' ? 'active' : ''}`}
          onClick={() => setTreeMode('explorer')}
        >
          Context Graphs
        </button>
        <button
          className={`v10-tree-mode-btn ${treeMode === 'oracle' ? 'active' : ''}`}
          onClick={() => setTreeMode('oracle')}
        >
          Context Oracle
        </button>
      </div>

      {treeMode === 'explorer' && (
        <div className="v10-tree-content">
          <div
            className={`v10-tree-dashboard ${activeTabId === 'dashboard' ? 'active' : ''}`}
            onClick={() => { setActiveTab('dashboard'); setActiveProject(null); }}
          >
            <span>▦</span> Dashboard
          </div>

          {/* Empty-state card hoisted ABOVE the collapsible sections so it
              stays visible if both sections are collapsed. */}
          {contextGraphs.length === 0 && stage <= 1 && (
            <div className="v10-journey-empty-card">
              <div className="v10-jec-title">No context graphs yet</div>
              <div className="v10-jec-hint">
                {stage === 0
                  ? 'Connect an agent to get started.'
                  : 'Create your first context graph to give your agent structured memory.'}
              </div>
              {stage === 1 && (
                <button className="v10-new-project-btn" style={{ margin: 0 }} onClick={() => setShowCreateModal(true)}>
                  + Create First Context Graph
                </button>
              )}
            </div>
          )}

          {/* Section A: My Context Graphs (default expanded). Uses the
              .v10-peer-group-* pattern from the right panel — polished
              focus-visible + prefers-reduced-motion + button semantics.
              Header renders even when `myProjects` is empty (but at
              least one CG exists, or the journey is past first-run) —
              otherwise a sidebar with CGs only in the Context Oracle
              view would collapse to a lone "Integrations" header
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
                <span className="v10-peer-group-label">My Context Graphs</span>
              </button>
              {leftSectionMyProjectsOpen && (
                <div id={myProjectsBodyId} className="v10-peer-group-body">
                  {myProjects.length === 0 ? (
                    <div
                      className="v10-tree-item"
                      style={{ cursor: 'default', color: 'var(--text-tertiary)', fontStyle: 'italic' }}
                    >
                      <span className="v10-tree-item-label">No context graphs in this view yet.</span>
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

          {hiddenCount > 0 && (
            <button
              type="button"
              className="v10-tree-show-hidden"
              onClick={unhideAll}
              title="Restore all context graphs dismissed from the sidebar"
            >
              ↺ Show {hiddenCount} hidden context graph{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}

          {/* Section B: Integrations (default collapsed — escape-hatch
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
        </div>
      )}

      {treeMode === 'oracle' && (
        <div className="v10-tree-content">
          {contextOracleProjects.length > 0 && (
            <>
              <div className="v10-tree-group-label">Context Oracle</div>
              {contextOracleProjects.map((cg) => (
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
            </>
          )}
          {contextOracleProjects.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '20px 12px', textAlign: 'center', lineHeight: 1.5 }}>
              No public catalogue entries yet. Context graphs you sync or curate appear under <strong>Context Graphs</strong>; non-private graphs you discover but haven&apos;t joined list here — use <strong>Join Context Graph</strong> to subscribe.
            </p>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="v10-tree-show-hidden"
              onClick={unhideAll}
              title="Restore all context graphs dismissed from the sidebar"
            >
              ↺ Show {hiddenCount} hidden context graph{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

      <CreateProjectModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <JoinProjectModal open={showJoinModal} onClose={() => setShowJoinModal(false)} />
    </div>
  );
}
