import React, { useCallback, useEffect, useState } from 'react';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import { useJourneyStore } from '../../stores/journey.js';
import { api } from '../../api-wrapper.js';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { useNodeEvents } from '../../hooks/useNodeEvents.js';
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

const CHEVRON_ICON = '▸';
const COLLAPSE_ICON = '◂';

// Project tree row: a flat, clickable header that opens the project tab.
// Memory-layer expansion was removed by request — layers are surfaced inside
// the project view rather than as nested sidebar items.

type TreeMode = 'explorer' | 'oracle';

// ─── Hidden projects (local dismiss) — ─────────────────────────────
// My Projects vs Context Oracle: daemon subscription + curator + policy
// (GET /api/context-graph/list); no manual overrides (see sidebar helper).
const HIDDEN_KEY = 'v10:hiddenProjectIds';
const HIDDEN_CHANGE_EVENT = 'v10:hidden-projects-change';

function loadHiddenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveHiddenIds(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new Event(HIDDEN_CHANGE_EVENT));
  } catch { /* non-critical */ }
}

function useHiddenProjectIds(): {
  hidden: Set<string>;
  hide: (id: string) => void;
  unhideAll: () => void;
} {
  const [hidden, setHidden] = useState<Set<string>>(() => loadHiddenIds());
  useEffect(() => {
    const sync = () => setHidden(loadHiddenIds());
    window.addEventListener(HIDDEN_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const hide = useCallback((id: string) => {
    const next = new Set(loadHiddenIds());
    next.add(id);
    saveHiddenIds(next);
  }, []);
  const unhideAll = useCallback(() => { saveHiddenIds(new Set()); }, []);
  return { hidden, hide, unhideAll };
}

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
  const assetCount = cg.assetCount ?? cg.assets ?? 0;

  return (
    <div className="v10-tree-section">
      <div
        className={`v10-tree-section-header ${isActive ? 'active' : ''}`}
        onClick={onSelect}
      >
        <span className="v10-tree-project-dot" />
        <span className="v10-tree-section-label">{cg.name || cg.id.slice(0, 16)}</span>
        <span className="v10-tree-section-badge">{assetCount}</span>
        <button
          type="button"
          className="v10-tree-hide-btn"
          title="Hide this project from the sidebar (reversible)"
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

function IntegrationsSection() {
  const [open, setOpen] = useState(false);
  const [localAgents, setLocalAgents] = useState<LocalAgentIntegration[]>([]);
  const [localAgentsError, setLocalAgentsError] = useState<string | null>(null);

  // Lazy-load on first open and refresh every 30s while open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const loadLocal = () => {
      fetchLocalAgentIntegrations()
        .then((r) => { if (!cancelled) { setLocalAgents(r.integrations); setLocalAgentsError(null); } })
        .catch((e: Error) => { if (!cancelled) setLocalAgentsError(e.message); });
    };

    loadLocal();
    const iv = setInterval(loadLocal, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [open]);

  return (
    <div className="v10-tree-section">
      <div className="v10-tree-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`v10-tree-chevron ${open ? 'open' : ''}`}>{CHEVRON_ICON}</span>
        <span className="v10-tree-integration-dot" />
        <span className="v10-tree-section-label">Integrations</span>
      </div>
      {open && (
        <div className="v10-tree-items" style={{ display: 'block' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 12px 2px 38px' }}>
            Agents
          </div>
          {localAgentsError && (
            <div style={{ fontSize: 11, color: 'var(--accent-orange, #f97316)', padding: '4px 12px 4px 38px' }}>
              {localAgentsError}
            </div>
          )}
          {!localAgentsError && localAgents.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 12px 4px 38px', fontStyle: 'italic' }}>
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
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 4 }}>
                {a.statusLabel}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PanelLeft() {
  const { toggleLeft } = useLayoutStore();
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
        <button className="v10-new-project-btn" onClick={() => setShowCreateModal(true)}>+ New Project</button>
        <button className="v10-new-project-btn" onClick={() => setShowJoinModal(true)}>↗ Join Project</button>
      </div>

      <div className="v10-tree-header">
        <button
          className={`v10-tree-mode-btn ${treeMode === 'explorer' ? 'active' : ''}`}
          onClick={() => setTreeMode('explorer')}
        >
          Projects
        </button>
        <button
          className={`v10-tree-mode-btn ${treeMode === 'oracle' ? 'active' : ''}`}
          onClick={() => setTreeMode('oracle')}
        >
          Context Oracle
        </button>
        <button className="v10-collapse-btn" onClick={toggleLeft} style={{ marginLeft: 4, padding: '0 6px' }}>
          {COLLAPSE_ICON}
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

          {contextGraphs.length === 0 && stage <= 1 && (
            <div className="v10-journey-empty-card">
              <div className="v10-jec-title">No projects yet</div>
              <div className="v10-jec-hint">
                {stage === 0
                  ? 'Connect an agent to get started.'
                  : 'Create your first project to give your agent structured memory.'}
              </div>
              {stage === 1 && (
                <button className="v10-new-project-btn" style={{ margin: 0 }} onClick={() => setShowCreateModal(true)}>
                  + Create First Project
                </button>
              )}
            </div>
          )}

          {myProjects.length > 0 && (
            <>
              <div className="v10-tree-group-label">My Projects</div>
              {myProjects.map((cg) => (
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

          {hiddenCount > 0 && (
            <button
              type="button"
              className="v10-tree-show-hidden"
              onClick={unhideAll}
              title="Restore all projects dismissed from the sidebar"
            >
              ↺ Show {hiddenCount} hidden project{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}

          {stage >= 1 && <IntegrationsSection />}
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
              No public catalogue entries yet. Projects you sync or curate appear under <strong>Projects</strong>; non-private graphs you discover but haven&apos;t joined list here — use <strong>Join Project</strong> to subscribe.
            </p>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="v10-tree-show-hidden"
              onClick={unhideAll}
              title="Restore all projects dismissed from the sidebar"
            >
              ↺ Show {hiddenCount} hidden project{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

      <CreateProjectModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <JoinProjectModal open={showJoinModal} onClose={() => setShowJoinModal(false)} />
    </div>
  );
}
