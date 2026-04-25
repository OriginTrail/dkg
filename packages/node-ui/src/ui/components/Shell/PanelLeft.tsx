import React, { useCallback, useEffect, useState } from 'react';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import { useJourneyStore } from '../../stores/journey.js';
import { api } from '../../api-wrapper.js';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { ImportFilesModal } from '../Modals/ImportFilesModal.js';
import { useNodeEvents } from '../../hooks/useNodeEvents.js';

const CHEVRON_ICON = '▸';
const COLLAPSE_ICON = '◂';

type TreeMode = 'explorer' | 'oracle';

// ─── Local per-project organisation ─────────────────────────────
// Two concerns, both backed by localStorage because the daemon doesn't
// currently expose per-project metadata we'd need to drive them:
//
//   1. Hidden — dismiss leftover test/demo projects.
//   2. Participating — manually mark a project as "joined someone
//      else's" rather than "mine". When the daemon starts returning
//      a `createdBy` / `owner` field on /api/paranet/list we'll switch
//      the detection automatic and this local override stays as a
//      user preference that wins over the heuristic.
const HIDDEN_KEY = 'v10:hiddenProjectIds';
const HIDDEN_CHANGE_EVENT = 'v10:hidden-projects-change';
const PARTICIPATING_KEY = 'v10:participatingProjectIds';
const PARTICIPATING_CHANGE_EVENT = 'v10:participating-projects-change';

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

// ─── "Participating in" tagging ─────────────────────────────────
function loadParticipatingIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PARTICIPATING_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveParticipatingIds(ids: Set<string>): void {
  try {
    localStorage.setItem(PARTICIPATING_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new Event(PARTICIPATING_CHANGE_EVENT));
  } catch { /* non-critical */ }
}

function useParticipatingIds(): {
  participating: Set<string>;
  toggle: (id: string) => void;
} {
  const [participating, setParticipating] = useState<Set<string>>(() => loadParticipatingIds());
  useEffect(() => {
    const sync = () => setParticipating(loadParticipatingIds());
    window.addEventListener(PARTICIPATING_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PARTICIPATING_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const toggle = useCallback((id: string) => {
    const next = new Set(loadParticipatingIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveParticipatingIds(next);
  }, []);
  return { participating, toggle };
}

interface ProjectTreeItemProps {
  cg: ContextGraph;
  isActive: boolean;
  isParticipating: boolean;
  onSelect: () => void;
  onImport: () => void;
  onHide: () => void;
  onToggleParticipating: () => void;
}

function ProjectTreeItem({
  cg,
  isActive,
  isParticipating,
  onSelect,
  onImport,
  onHide,
  onToggleParticipating,
}: ProjectTreeItemProps) {
  const [open, setOpen] = useState(false);
  const { openTab } = useTabsStore();
  const assetCount = cg.assetCount ?? cg.assets ?? 0;

  return (
    <div className="v10-tree-section">
      <div
        className={`v10-tree-section-header ${isActive ? 'active' : ''}`}
        onClick={() => { setOpen((v) => !v); onSelect(); }}
      >
        <span className={`v10-tree-chevron ${open ? 'open' : ''}`}>{CHEVRON_ICON}</span>
        <span className="v10-tree-project-dot" />
        <span className="v10-tree-section-label">{cg.name || cg.id.slice(0, 16)}</span>
        <span className="v10-tree-section-badge">{assetCount}</span>
        <button
          type="button"
          className="v10-tree-move-btn"
          title={isParticipating
            ? 'Move to "My Projects"'
            : 'Mark as participating (move to "Participating")'}
          onClick={(e) => { e.stopPropagation(); onToggleParticipating(); }}
        >
          ⤑
        </button>
        <button
          type="button"
          className="v10-tree-hide-btn"
          title="Hide this project from the sidebar (reversible)"
          onClick={(e) => { e.stopPropagation(); onHide(); }}
        >
          ×
        </button>
      </div>
      {open && (
        <div className="v10-tree-items">
          <div className="v10-tree-layer-header">Working Memory</div>
          <div
            className="v10-tree-item"
            onClick={() => openTab({ id: `wm:${cg.id}`, label: `WM · ${cg.name || cg.id.slice(0,12)}`, closable: true })}
          >
            <span className="v10-tree-item-icon" style={{ color: 'var(--layer-working)' }}>◇</span>
            <span className="v10-tree-item-label">agent drafts</span>
          </div>
          <div
            className="v10-tree-item"
            onClick={(e) => { e.stopPropagation(); onImport(); }}
            style={{ paddingLeft: 32 }}
          >
            <span className="v10-tree-item-icon" style={{ fontSize: 11 }}>↑</span>
            <span className="v10-tree-item-label" style={{ color: 'var(--text-tertiary)' }}>Import files…</span>
          </div>

          <div className="v10-tree-layer-header" style={{ marginTop: 6 }}>Shared Memory</div>
          <div
            className="v10-tree-item"
            onClick={() => openTab({ id: `swm:${cg.id}`, label: `SWM · ${cg.name || cg.id.slice(0,12)}`, closable: true })}
          >
            <span className="v10-tree-item-icon" style={{ color: 'var(--layer-shared)' }}>◈</span>
            <span className="v10-tree-item-label">team workspace</span>
          </div>

          <div className="v10-tree-layer-header" style={{ marginTop: 6 }}>Verified Memory</div>
          <div
            className="v10-tree-item"
            onClick={() => openTab({ id: `vm:${cg.id}`, label: `VM · ${cg.name || cg.id.slice(0,12)}`, closable: true })}
          >
            <span className="v10-tree-item-icon" style={{ color: 'var(--layer-verified)' }}>◉</span>
            <span className="v10-tree-item-label">verified assets</span>
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationsSection() {
  const [open, setOpen] = useState(false);

  return (
    <div className="v10-tree-section">
      <div className="v10-tree-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`v10-tree-chevron ${open ? 'open' : ''}`}>{CHEVRON_ICON}</span>
        <span className="v10-tree-integration-dot" />
        <span className="v10-tree-section-label">Integrations</span>
      </div>
      {open && (
        <div className="v10-tree-items" style={{ display: 'block' }}>
          <div className="v10-tree-item">
            <span className="v10-tree-item-icon">⬡</span>
            <span className="v10-tree-item-label">Obsidian</span>
          </div>
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
  const { participating: participatingIds, toggle: toggleParticipating } = useParticipatingIds();
  const visibleContextGraphs = contextGraphs.filter((cg) => !hiddenIds.has(cg.id));
  const myProjects = visibleContextGraphs.filter((cg) => !participatingIds.has(cg.id));
  const participatingProjects = visibleContextGraphs.filter((cg) => participatingIds.has(cg.id));
  const hiddenCount = contextGraphs.length - visibleContextGraphs.length;

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [importTarget, setImportTarget] = useState<ContextGraph | null>(null);

  const loadCGs = useCallback(() => {
    setLoading(true);
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

          {contextGraphs.length > 0 && (
            <div
              className={`v10-tree-dashboard ${activeTabId === 'memory-stack' ? 'active' : ''}`}
              onClick={() => openTab({ id: 'memory-stack', label: 'Memory Stack', closable: true })}
            >
              <span>▤</span> Memory Stack
            </div>
          )}

          {contextGraphs.length > 0 && (
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="v10-new-project-btn" onClick={() => setShowCreateModal(true)}>+ New Project</button>
              <button className="v10-new-project-btn" onClick={() => setShowJoinModal(true)}>↗ Join Project</button>
            </div>
          )}

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

          {/* Projects split into two groups. Default everything lives
              under "My Projects"; the user can mark individual projects
              as "participating" via the ⤑ button on the row, which
              moves them to the Participating group. This is a
              client-local tag (localStorage) — once the daemon exposes
              real creator/owner metadata we'll auto-populate from that
              and keep the manual override as a user preference. */}
          {myProjects.length > 0 && (
            <>
              <div className="v10-tree-group-label">My Projects</div>
              {myProjects.map((cg) => (
                <ProjectTreeItem
                  key={cg.id}
                  cg={cg}
                  isActive={activeProjectId === cg.id}
                  isParticipating={false}
                  onSelect={() => {
                    setActiveProject(cg.id);
                    openTab({ id: `project:${cg.id}`, label: cg.name || cg.id.slice(0, 16), closable: true });
                  }}
                  onImport={() => setImportTarget(cg)}
                  onHide={() => {
                    hideProject(cg.id);
                    if (activeProjectId === cg.id) setActiveProject(null);
                  }}
                  onToggleParticipating={() => toggleParticipating(cg.id)}
                />
              ))}
            </>
          )}

          {participatingProjects.length > 0 && (
            <>
              <div className="v10-tree-group-label">Participating Projects</div>
              {participatingProjects.map((cg) => (
                <ProjectTreeItem
                  key={cg.id}
                  cg={cg}
                  isActive={activeProjectId === cg.id}
                  isParticipating={true}
                  onSelect={() => {
                    setActiveProject(cg.id);
                    openTab({ id: `project:${cg.id}`, label: cg.name || cg.id.slice(0, 16), closable: true });
                  }}
                  onImport={() => setImportTarget(cg)}
                  onHide={() => {
                    hideProject(cg.id);
                    if (activeProjectId === cg.id) setActiveProject(null);
                  }}
                  onToggleParticipating={() => toggleParticipating(cg.id)}
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
          <div className="v10-oracle-placeholder">
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 24, textAlign: 'center' }}>
              Context Oracle browser coming soon.
            </p>
          </div>
        </div>
      )}

      <CreateProjectModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <JoinProjectModal open={showJoinModal} onClose={() => setShowJoinModal(false)} />
      {importTarget && (
        <ImportFilesModal
          open
          onClose={() => setImportTarget(null)}
          contextGraphId={importTarget.id}
          contextGraphName={importTarget.name}
        />
      )}
    </div>
  );
}
