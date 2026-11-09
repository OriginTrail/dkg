import React, { useCallback, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  ChevronRight,
  ClipboardList,
  Compass,
  KeyRound,
  LayoutDashboard,
  LogIn,
  Plus,
  ServerCog,
  ShoppingBag,
  Store,
} from 'lucide-react';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import { useJourneyStore } from '../../stores/journey.js';
import { CreateProjectModal } from '../Modals/CreateProjectModal.js';
import { JoinProjectModal } from '../Modals/JoinProjectModal.js';
import { useContextGraphInventory, refreshContextGraphInventory } from '../../hooks/useContextGraphInventory.js';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling.js';
import { useHiddenContextGraphIds as useHiddenProjectIds } from '../../hooks/useHiddenContextGraphIds.js';
import {
  fetchLocalAgentIntegrations,
  type LocalAgentIntegration,
  type LocalAgentIntegrationStatus,
} from '../../api.js';
import {
  belongsInContextOracleSidebar,
  belongsInMyProjectsSidebar,
  classifyContextOracleEntry,
  toSidebarIdentity,
  type AgentSidebarIdentity,
} from '../../lib/contextGraphSidebar.js';
import { MARKETPLACE_TABS, MARKETPLACE_TAB_IDS, marketplaceEnabled } from '../../marketplace/tabs.js';

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

interface OracleCatalogueItemProps {
  cg: ContextGraph;
  isBrowsing: boolean;
  onBrowse: () => void;
  onSubscribe: () => void;
  onHide: () => void;
}

function OracleCatalogueItem({
  cg,
  isBrowsing,
  onBrowse,
  onSubscribe,
  onHide,
}: OracleCatalogueItemProps) {
  const label = cg.name || cg.id.slice(0, 16);
  return (
    <div className="v10-tree-section">
      <div className={`v10-tree-section-header catalogue ${isBrowsing ? 'active' : ''}`}>
        <span className="v10-tree-project-dot" />
        <span className="v10-tree-section-label">{label}</span>
        <button
          type="button"
          className="v10-tree-catalogue-btn"
          aria-label={`Browse ${label}`}
          onClick={onBrowse}
        >
          Browse
        </button>
        <button
          type="button"
          className="v10-tree-catalogue-btn primary"
          aria-label={`Subscribe to ${label}`}
          onClick={onSubscribe}
        >
          Subscribe
        </button>
        <button
          type="button"
          className="v10-tree-hide-btn"
          title="Hide this context graph from the sidebar (reversible)"
          onClick={onHide}
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
      <div style={{ fontSize: 'var(--font-size-caption)', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 12px 2px 24px' }}>
        Agents
      </div>
      {localAgentsError && (
        <div style={{ fontSize: 'var(--font-size-caption)', color: 'var(--accent-orange, #f97316)', padding: '4px 12px 4px 24px' }}>
          {localAgentsError}
        </div>
      )}
      {!localAgentsError && localAgents.length === 0 && (
        <div style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-tertiary)', padding: '4px 12px 4px 24px', fontStyle: 'italic' }}>
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
          <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-tertiary)', marginLeft: 4 }}>
            {a.statusLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PanelLeft() {
  const leftSectionMarketplaceOpen = useLayoutStore((s) => s.leftSectionMarketplaceOpen);
  const toggleLeftSectionMarketplace = useLayoutStore((s) => s.toggleLeftSectionMarketplace);
  const leftSectionMyProjectsOpen = useLayoutStore((s) => s.leftSectionMyProjectsOpen);
  const leftSectionContextOracleOpen = useLayoutStore((s) => s.leftSectionContextOracleOpen);
  const leftSectionIntegrationsOpen = useLayoutStore((s) => s.leftSectionIntegrationsOpen);
  const toggleLeftSectionMyProjects = useLayoutStore((s) => s.toggleLeftSectionMyProjects);
  const toggleLeftSectionContextOracle = useLayoutStore((s) => s.toggleLeftSectionContextOracle);
  const toggleLeftSectionIntegrations = useLayoutStore((s) => s.toggleLeftSectionIntegrations);
  // Stable per-render ids for the section bodies so the chevron buttons
  // can use `aria-controls` to point at the disclosed region (screen
  // readers can then programmatically associate trigger ↔ content).
  const marketplaceBodyId = useId();
  const myProjectsBodyId = useId();
  const contextOracleBodyId = useId();
  const integrationsBodyId = useId();
  const { openTab, activeTabId, setActiveTab } = useTabsStore();
  const { activeProjectId, setActiveProject } = useProjectsStore();
  const { contextGraphs, error: listError, identity: sharedAgent,
    inventoryLoading, inventoryError } = useContextGraphInventory();
  const stage = useJourneyStore((s) => s.stage);

  const { hidden: hiddenIds, hide: hideProject, unhideAll } = useHiddenProjectIds();
  const agentIdentity: AgentSidebarIdentity | null = sharedAgent.data ? toSidebarIdentity(sharedAgent.data) : null;

  const visibleContextGraphs = contextGraphs.filter((cg) => !hiddenIds.has(cg.id));
  const myProjects = visibleContextGraphs.filter((cg) =>
    belongsInMyProjectsSidebar(cg, agentIdentity));
  const contextOracleProjects = visibleContextGraphs.filter((cg) =>
    belongsInContextOracleSidebar(cg, agentIdentity));
  const hiddenCount = contextGraphs.length - visibleContextGraphs.length;

  // The marketplace section is still flagged: `?marketplace` once turns it on.
  const showMarketplace = marketplaceEnabled();
  const marketplaceActive = MARKETPLACE_TAB_IDS.includes(activeTabId);
  const openMarketplaceTab = (tab: { id: string; label: string }) => {
    openTab({ id: tab.id, label: tab.label, closable: true });
    setActiveTab(tab.id);
    setActiveProject(null);
  };
  const marketplaceRows = [
    { tab: MARKETPLACE_TABS.browse, label: 'Browse', icon: <Store size={15} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.plans, label: 'Plans', icon: <ClipboardList size={15} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.access, label: 'Access', icon: <KeyRound size={15} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.operate, label: 'Operate', icon: <Activity size={15} aria-hidden="true" /> },
  ];

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinContextGraphId, setJoinContextGraphId] = useState<string | undefined>();

  const openJoinModal = useCallback((contextGraphId?: string) => {
    setJoinContextGraphId(contextGraphId);
    setShowJoinModal(true);
  }, []);

  const closeJoinModal = useCallback(() => {
    setShowJoinModal(false);
    setJoinContextGraphId(undefined);
  }, []);

  const membershipNote = inventoryError
    ? 'Context graph membership unavailable.'
    : inventoryLoading
      ? 'Loading context graphs…'
      : null;

  return (
    <div className="v10-panel-left">
      <div className="v10-tree-content v10-sidebar-content">
        <button
          type="button"
          className={`v10-sidebar-nav-row ${activeTabId === 'dashboard' ? 'active' : ''}`}
          aria-current={activeTabId === 'dashboard' ? 'page' : undefined}
          onClick={() => { setActiveTab('dashboard'); setActiveProject(null); }}
        >
          <LayoutDashboard size={18} aria-hidden="true" />
          <span>Dashboard</span>
        </button>

        {showMarketplace && (
          <div className="v10-peer-group v10-sidebar-group v10-sidebar-marketplace">
            <button
              type="button"
              className={`v10-peer-group-header v10-sidebar-group-header v10-sidebar-product-header ${marketplaceActive ? 'active' : ''}`}
              aria-expanded={leftSectionMarketplaceOpen}
              aria-controls={marketplaceBodyId}
              onClick={toggleLeftSectionMarketplace}
            >
              <ShoppingBag size={18} aria-hidden="true" />
              <span className="v10-peer-group-label">Marketplace</span>
              <ChevronRight
                size={14}
                className={`v10-peer-group-chevron ${leftSectionMarketplaceOpen ? 'expanded' : ''}`}
                aria-hidden="true"
              />
            </button>
            {leftSectionMarketplaceOpen && (
              <div
                id={marketplaceBodyId}
                className="v10-peer-group-body v10-sidebar-group-body v10-sidebar-marketplace-items"
              >
                {marketplaceRows.map(({ tab, label, icon }) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`v10-sidebar-nav-row v10-sidebar-sub-row ${activeTabId === tab.id ? 'active' : ''}`}
                    aria-current={activeTabId === tab.id ? 'page' : undefined}
                    onClick={() => openMarketplaceTab(tab)}
                  >
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {inventoryError && (
          <div className="v10-journey-empty-card" role="alert">
            <div>{listError ? 'Context graphs unavailable. ' : ''}{sharedAgent.error ? 'Agent identity unavailable.' : ''}</div>
            <div>{contextGraphs.length ? 'Showing the last available context graphs.' : 'Context graph membership is unknown.'}</div>
            <button type="button" disabled={inventoryLoading} onClick={() => { void refreshContextGraphInventory(true); }}>Retry</button>
          </div>
        )}

        <div className="v10-sidebar-divider" />

        <div className="v10-peer-group v10-sidebar-group">
          <button
            type="button"
            className="v10-peer-group-header v10-sidebar-group-header"
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
            <span className="v10-peer-group-count">{myProjects.length}</span>
          </button>
          {leftSectionMyProjectsOpen && (
            <div id={myProjectsBodyId} className="v10-peer-group-body v10-sidebar-group-body">
              {contextGraphs.length === 0 && stage <= 1 && !inventoryError && !inventoryLoading ? (
                <div className="v10-sidebar-empty">
                  <strong>No context graphs yet</strong>
                  <span>
                    {stage === 0
                      ? 'Connect an agent to get started.'
                      : 'Create your first graph to give your agent structured memory.'}
                  </span>
                </div>
              ) : myProjects.length === 0 ? (
                <div className="v10-sidebar-empty" role={membershipNote ? 'status' : undefined}>
                  <span>{membershipNote ?? 'No context graphs in this section yet.'}</span>
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

              <div className="v10-sidebar-inline-actions">
                <button
                  type="button"
                  aria-label="New Context Graph"
                  onClick={() => setShowCreateModal(true)}
                >
                  <Plus size={15} aria-hidden="true" />
                  New
                </button>
                <button
                  type="button"
                  aria-label="Join Context Graph"
                  onClick={() => openJoinModal()}
                >
                  <LogIn size={15} aria-hidden="true" />
                  Join
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="v10-peer-group v10-sidebar-group">
          <button
            type="button"
            className="v10-peer-group-header v10-sidebar-group-header v10-sidebar-product-header"
            aria-expanded={leftSectionContextOracleOpen}
            aria-controls={contextOracleBodyId}
            onClick={toggleLeftSectionContextOracle}
          >
            <Compass size={17} aria-hidden="true" />
            <span className="v10-peer-group-label">Public Graphs</span>
            <span className="v10-peer-group-count">{contextOracleProjects.length}</span>
            <ChevronRight
              size={14}
              className={`v10-peer-group-chevron ${leftSectionContextOracleOpen ? 'expanded' : ''}`}
              aria-hidden="true"
            />
          </button>
          {leftSectionContextOracleOpen && (
            <div id={contextOracleBodyId} className="v10-peer-group-body v10-sidebar-group-body v10-sidebar-public-graphs">
              {contextOracleProjects.length > 0 ? contextOracleProjects.map((cg) => {
                const onHide = () => {
                  hideProject(cg.id);
                  if (activeProjectId === cg.id) setActiveProject(null);
                };
                if (classifyContextOracleEntry(cg) === 'catalogue') {
                  return (
                    <OracleCatalogueItem
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
              }) : (
                <div className="v10-sidebar-empty" role={membershipNote ? 'status' : undefined}>
                  <span>{membershipNote ?? 'Discovered public graphs will appear here. Use Join to subscribe by ID.'}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {stage >= 1 && (
        <div className="v10-sidebar-footer">
          <div className="v10-peer-group v10-sidebar-group">
            <button
              type="button"
              className="v10-peer-group-header v10-sidebar-group-header v10-sidebar-product-header"
              aria-expanded={leftSectionIntegrationsOpen}
              aria-controls={integrationsBodyId}
              onClick={toggleLeftSectionIntegrations}
            >
              <ServerCog size={18} aria-hidden="true" />
              <span className="v10-peer-group-label">Integrations</span>
              <ChevronRight
                size={14}
                className={`v10-peer-group-chevron ${leftSectionIntegrationsOpen ? 'expanded' : ''}`}
                aria-hidden="true"
              />
            </button>
            {leftSectionIntegrationsOpen && (
              <div id={integrationsBodyId} className="v10-peer-group-body v10-sidebar-group-body">
                <IntegrationsSectionBody />
              </div>
            )}
          </div>
        </div>
      )}

      {/* The panel's glass chrome (backdrop-filter) would make it the containing
          block for the modals' fixed overlay, so they render on document.body. */}
      {createPortal(
        <>
          <CreateProjectModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
          <JoinProjectModal
            open={showJoinModal}
            onClose={closeJoinModal}
            initialContextGraphId={joinContextGraphId}
          />
        </>,
        document.body,
      )}
    </div>
  );
}
