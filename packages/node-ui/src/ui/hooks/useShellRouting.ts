import { useEffect, useRef } from 'react';
import { NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useTabsStore } from '../stores/tabs.js';
import { useLayoutStore } from '../stores/layout.js';
import { useProjectsStore } from '../stores/projects.js';
import { isPassiveCatalogueGraph } from '../lib/contextGraphSidebar.js';
import { pathToTab, tabIdToPath } from '../lib/tab-routes.js';
import { tabContextGraphId } from '../lib/tab-target.js';

/**
 * The address owns the active centre tab.
 *
 *   Restore (once): a saved workspace whose active tab isn't the dashboard,
 *   loaded at the root `/`, replaces `/` with that tab's address, so a
 *   refresh lands on the tab you were on (stores/tabs persists it).
 *
 *   Address → tab: from then on the address decides. Landing on, or going
 *   back/forward to, a tab's address opens and activates that tab; `/` is
 *   the dashboard.
 *
 *   Tab → address: any tab action that changes the active tab (a click, open,
 *   close, reopen) pushes that tab's address, one history entry each. When
 *   the address already shows the tab (it was the address that activated
 *   it) nothing is pushed. Paths that aren't tabs are left alone.
 *
 *   Remembered locations: each tab's last query string (an Observability
 *   tab, a graph view) is kept here, so switching back to a tab returns to
 *   where it was. Route encoders stay pure.
 *
 *   Panels: going anywhere shows the page. Every address change, the path
 *   or only the query string, collapses the expanded right panel and closes a
 *   floating one. Arriving from the old /agent-hub address is the one
 *   navigation that opens the panel instead. Choosing the tab already open
 *   doesn't change the address; lib/shellNavigation handles that case.
 *
 * Tab metadata and order stay in the store; this hook only connects the
 * active tab to the address.
 */
export function useShellRouting(): void {
  const { pathname, search, key, state } = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // The address as rendered: tab actions compare against it before pushing.
  const here = useRef(pathname);
  here.current = pathname;
  const restored = useRef(false);
  const rememberedSearch = useRef(new Map<string, string>());

  // Remember where each tab was.
  useEffect(() => {
    const route = pathToTab(pathname);
    if (route) rememberedSearch.current.set(route.id, search);
  }, [pathname, search]);

  // Going anywhere shows the page.
  useEffect(() => {
    const layout = useLayoutStore.getState();
    // The /agent-hub redirect replaces its entry with { openAgents }. That replace opens the
    // panel, which the layout store presents for the screen: expanded on a wide one, floating
    // on a narrow one. Opening sets a state rather than toggling one, so StrictMode's replayed
    // effect leaves the panel open. Coming back to the entry later with Back or Forward is a
    // POP, and shows the page like any other navigation.
    if ((state as { openAgents?: boolean } | null)?.openAgents && navigationType === NavigationType.Replace) {
      layout.openRight({ expandOnDesktop: true });
      return;
    }
    layout.revealCentre();
    // Only a new address counts: a new history entry, or a path or query string that
    // changed without one (an entry pushed outside the router has no key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pathname, search]);

  // Tab → address
  useEffect(() => useTabsStore.subscribe((state, prev) => {
    if (state.activeTabId === prev.activeTabId) return;
    if (!pathToTab(here.current)) return; // a path that isn't a tab
    const path = tabIdToPath(state.activeTabId);
    if (path !== here.current) navigate(path + (rememberedSearch.current.get(state.activeTabId) ?? ''));
  }), [navigate]);

  // Address → tab (after restoring a saved workspace once)
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const saved = useTabsStore.getState().activeTabId;
      if (pathname === '/' && saved !== 'dashboard') {
        navigate(tabIdToPath(saved), { replace: true });
        return;
      }
    }
    const route = pathToTab(pathname);
    if (!route) return;
    const { tabs, activeTabId: active, openTab } = useTabsStore.getState();
    if (route.id === active) return;
    openTab(tabs.find((t) => t.id === route.id) ?? { id: route.id, label: route.label, closable: true });
  }, [pathname, navigate]);

  // Active tab → active graph. Back/Forward, a refreshed or bookmarked
  // address and the tab bar all establish the same context as picking the
  // graph in the sidebar, so the agent panel's chat and attachments target
  // the graph on screen. That holds for every graph-scoped tab (the graph
  // itself, one of its agents, a memory layer, a document opened in it), not
  // only the graph tab. A graph only browsed from the catalogue clears the
  // target instead, like the sidebar's Browse; it's re-checked once the graph
  // list arrives (a bookmark can load before it). The dashboard clears it too;
  // other places (Settings, Observability) leave it as it was.
  const activeGraphId = tabContextGraphId(activeTabId);
  const activeGraphPassive = useProjectsStore((s) => {
    const graph = activeGraphId ? s.contextGraphs.find((cg) => cg.id === activeGraphId) : undefined;
    return graph ? isPassiveCatalogueGraph(graph) : false;
  });
  useEffect(() => {
    const { setActiveProject, activeProjectId } = useProjectsStore.getState();
    if (activeGraphId) {
      const graphId = activeGraphPassive ? null : activeGraphId;
      if (graphId !== activeProjectId) setActiveProject(graphId);
    } else if (activeTabId === 'dashboard' && activeProjectId !== null) {
      setActiveProject(null);
    }
  }, [activeTabId, activeGraphId, activeGraphPassive]);
}
