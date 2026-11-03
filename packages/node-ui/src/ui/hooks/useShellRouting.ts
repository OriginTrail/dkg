import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTabsStore } from '../stores/tabs.js';
import { useProjectsStore } from '../stores/projects.js';
import { pathToTab, tabIdToPath } from '../lib/tab-routes.js';

// Kept for callers and tests that read the place table directly.
export const URL_PATH_TO_TAB: Record<string, { id: string; label: string }> = {
  '/observability': { id: 'operations', label: 'Observability' },
  '/operations': { id: 'operations', label: 'Observability' },
  '/settings': { id: 'settings', label: 'Settings' },
  '/conviction': { id: 'conviction', label: 'Publisher Conviction' },
};
export const TAB_TO_URL_PATH: Record<string, string> = {
  operations: '/observability',
  settings: '/settings',
  conviction: '/conviction',
  dashboard: '/',
};

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
 *   it) nothing is pushed. Paths that aren't tabs (/network) are left alone.
 *
 * Tab metadata and order stay in the store; this hook only connects the
 * active tab to the address.
 */
export function useShellRouting(): void {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // The address as rendered: tab actions compare against it before pushing.
  const here = useRef(pathname);
  here.current = pathname;
  const restored = useRef(false);

  // Tab → address
  useEffect(() => useTabsStore.subscribe((state, prev) => {
    if (state.activeTabId === prev.activeTabId) return;
    if (!pathToTab(here.current)) return; // a non-tab page such as /network
    const target = tabIdToPath(state.activeTabId);
    if (target !== here.current) navigate(target);
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

  // Active tab → active graph. Back/Forward, a refreshed or bookmarked graph
  // address and the tab bar all establish the same context as picking the
  // graph in the sidebar, so the agent panel's chat and attachments target
  // the graph on screen. The dashboard clears it, like its sidebar entry;
  // other places (Settings, Observability) leave it as it was.
  useEffect(() => {
    const { setActiveProject, activeProjectId } = useProjectsStore.getState();
    if (activeTabId.startsWith('project:')) {
      const graphId = activeTabId.slice('project:'.length);
      if (graphId && graphId !== activeProjectId) setActiveProject(graphId);
    } else if (activeTabId === 'dashboard' && activeProjectId !== null) {
      setActiveProject(null);
    }
  }, [activeTabId]);
}
