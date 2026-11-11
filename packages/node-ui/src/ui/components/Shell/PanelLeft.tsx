import React, { useCallback, useState } from 'react';
import { Activity, ClipboardList, Eye, KeyRound, RefreshCw, Store, X } from 'lucide-react';
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
import { MARKETPLACE_TABS, MARKETPLACE_TAB_IDS, marketplaceEnabled } from '../../marketplace/tabs.js';
import { SidebarSection } from './SidebarSection.js';
import { DASHBOARD_ICON, placeIcon } from './nav-icons.js';
import { NODE_PLACE_IDS, PLACES } from '../../lib/tab-target.js';

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
          aria-label={`Hide ${label} from the sidebar`} title="Hide this context graph from the sidebar (reversible)"
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
      return 'var(--accent-amber)';
    case 'degraded':
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
  const leftSectionMarketplaceOpen = useLayoutStore((s) => s.leftSectionMarketplaceOpen);
  const toggleLeftSectionMarketplace = useLayoutStore((s) => s.toggleLeftSectionMarketplace);
  const leftSectionMyProjectsOpen = useLayoutStore((s) => s.leftSectionMyProjectsOpen);
  const leftSectionContextOracleOpen = useLayoutStore((s) => s.leftSectionContextOracleOpen);
  const leftSectionIntegrationsOpen = useLayoutStore((s) => s.leftSectionIntegrationsOpen);
  const toggleLeftSectionMyProjects = useLayoutStore((s) => s.toggleLeftSectionMyProjects);
  const toggleLeftSectionContextOracle = useLayoutStore((s) => s.toggleLeftSectionContextOracle);
  const toggleLeftSectionIntegrations = useLayoutStore((s) => s.toggleLeftSectionIntegrations);
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

  // The marketplace section is still flagged: `?marketplace` once turns it on.
  const showMarketplace = marketplaceEnabled();
  const marketplaceActive = MARKETPLACE_TAB_IDS.includes(activeTabId);
  const openMarketplaceTab = (tab: { id: string; label: string }) => {
    openTab({ id: tab.id, label: tab.label, closable: true });
    setActiveProject(null);
  };
  const marketplaceRows = [
    { tab: MARKETPLACE_TABS.browse, label: 'Browse', icon: <Store size={14} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.plans, label: 'Plans', icon: <ClipboardList size={14} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.access, label: 'Access', icon: <KeyRound size={14} aria-hidden="true" /> },
    { tab: MARKETPLACE_TABS.operate, label: 'Operate', icon: <Activity size={14} aria-hidden="true" /> },
  ];

  // The create and join dialogs belong to the shell (ContextGraphDialogs), so
  // they outlive this panel closing on navigation or a resize.
  const openCreateModal = useContextGraphDialogs((s) => s.openCreate);
  const openJoinModal = useContextGraphDialogs((s) => s.openJoin);

  const showEmptyCard = contextGraphs.length === 0 && stage <= 1 && !inventoryError && !inventoryLoading;
  // On first run the empty card carries New and Join; otherwise they close the group.
  const showCardActions = showEmptyCard && stage === 1;

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
          className={`v10-tree-dashboard v10-sidebar-place ${activeTabId === 'dashboard' ? 'active' : ''}`}
          aria-current={activeTabId === 'dashboard' ? 'page' : undefined}
          onClick={() => { chooseOpenTab('dashboard'); setActiveProject(null); }}
        >
          <span className="v10-sidebar-place-icon">{DASHBOARD_ICON}</span>
          Dashboard
        </button>
        <button
          type="button"
          className={`v10-tree-dashboard v10-sidebar-place ${activeTabId === 'memory-stack' ? 'active' : ''}`}
          aria-current={activeTabId === 'memory-stack' ? 'page' : undefined}
          title={PLACES['memory-stack'].title}
          onClick={() => openTab({ id: 'memory-stack', label: PLACES['memory-stack'].label, closable: true })}
        >
          <span className="v10-sidebar-place-icon">{placeIcon('memory-stack')}</span>
          {PLACES['memory-stack'].label}
        </button>

        {showMarketplace && (
          <SidebarSection
            label="NS Marketplace"
            active={marketplaceActive}
            open={leftSectionMarketplaceOpen}
            onToggle={toggleLeftSectionMarketplace}
            className="v10-sidebar-marketplace"
            bodyClassName="v10-sidebar-marketplace-items"
          >
            {marketplaceRows.map(({ tab, label, icon }) => (
              <button
                key={tab.id}
                type="button"
                className={`v10-tree-dashboard v10-sidebar-place ${activeTabId === tab.id ? 'active' : ''}`}
                aria-current={activeTabId === tab.id ? 'page' : undefined}
                onClick={() => openMarketplaceTab(tab)}
              >
                <span className="v10-sidebar-place-icon">{icon}</span>
                {label}
              </button>
            ))}
          </SidebarSection>
        )}

        {inventoryError && (
          <div className="v10-journey-empty-card ds-card" role="alert">
            <div>{listError ? 'Context graphs unavailable. ' : ''}{sharedAgent.error ? 'Agent identity unavailable.' : ''}</div>
            <div>{contextGraphs.length ? 'Showing the last available context graphs.' : 'Context graph membership is unknown.'}</div>
            <button type="button" className="ds-btn ds-sm" disabled={inventoryLoading} onClick={() => { void refreshContextGraphInventory(true); }}><RefreshCw size={12} />Retry</button>
          </div>
        )}

        <SidebarSection
          label="My context graphs"
          count={myProjects.length}
          open={leftSectionMyProjectsOpen}
          onToggle={toggleLeftSectionMyProjects}
        >
          {showEmptyCard ? (
            <div className="v10-sidebar-empty v10-sidebar-first-run">
              <strong>No context graphs yet</strong>
              <span>
                {stage === 0
                  ? 'Connect an agent to get started.'
                  : 'Create your first context graph to give your agent structured memory, or join one by ID.'}
              </span>
              {showCardActions && (
                <div className="v10-sidebar-inline-actions">
                  <button type="button" className="ds-btn ds-primary ds-sm" aria-label="New context graph" onClick={openCreateModal}>New</button>
                  <button type="button" className="ds-btn ds-sm" aria-label="Join context graph" onClick={() => openJoinModal()}>Join</button>
                </div>
              )}
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
              <Eye size={12} /> Show {hiddenCount} hidden context graph{hiddenCount !== 1 ? 's' : ''}
            </button>
          )}

          {!showCardActions && (
            <div className="v10-sidebar-inline-actions">
              <button type="button" className="ds-btn ds-ghost ds-sm" aria-label="New context graph" onClick={openCreateModal}>New</button>
              <button type="button" className="ds-btn ds-ghost ds-sm" aria-label="Join context graph" onClick={() => openJoinModal()}>Join</button>
            </div>
          )}
        </SidebarSection>

        <SidebarSection
          label="Public graphs"
          count={publicContextGraphs.length}
          open={leftSectionContextOracleOpen}
          onToggle={toggleLeftSectionContextOracle}
          bodyClassName="v10-sidebar-public-graphs"
        >
          {publicContextGraphs.length > 0 ? publicContextGraphs.map((cg) => {
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
          }) : (
            <div className="v10-sidebar-empty" role={membershipNote ? 'status' : undefined}>
              <span>{membershipNote ?? 'Discovered public graphs will appear here. Use Join to subscribe by ID.'}</span>
            </div>
          )}
        </SidebarSection>

        {stage >= 1 && (
          <SidebarSection
            label="Integrations"
            open={leftSectionIntegrationsOpen}
            onToggle={toggleLeftSectionIntegrations}
          >
            <IntegrationsSectionBody />
          </SidebarSection>
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
