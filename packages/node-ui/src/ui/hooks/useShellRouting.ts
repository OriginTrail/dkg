import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTabsStore } from '../stores/tabs.js';
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
 * Two-way sync between the address bar and the active centre tab.
 *
 *   Address → tab: landing on (or going back/forward to) a tab's address
 *   opens and activates that tab. The dashboard path `/` only re-activates
 *   the dashboard on back/forward, never on first load, so a refresh keeps
 *   the restored workspace (stores/tabs persists it).
 *
 *   Tab → address: switching tabs pushes the tab's address, so back and
 *   forward step through the tabs you visited and a refresh lands on the
 *   same one. Paths that aren't tabs (/network) are left alone.
 */
export function useShellRouting(): void {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openTab = useTabsStore((s) => s.openTab);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const firstLoad = useRef(true);
  const firstSync = useRef(true);
  const lastPushed = useRef<string | null>(null);

  // Address → tab
  useEffect(() => {
    const route = pathToTab(pathname);
    const isFirst = firstLoad.current;
    firstLoad.current = false;
    if (!route) return;
    if (pathname === lastPushed.current) return; // our own push, nothing to do
    if (route.id === 'dashboard') {
      // On first load "/" is just the app's root: keep the restored active tab.
      if (!isFirst) setActiveTab('dashboard');
      return;
    }
    const { tabs } = useTabsStore.getState();
    const existing = tabs.find((t) => t.id === route.id);
    openTab(existing ?? { id: route.id, label: route.label, closable: true });
  }, [pathname, openTab, setActiveTab]);

  // Tab → address
  useEffect(() => {
    const route = pathToTab(pathname);
    if (!route && pathname !== '/') return; // a non-tab page such as /network
    // Read the live store: the address effect above may have just opened a tab
    // in this same commit, which `activeTabId` from render doesn't see yet.
    const active = useTabsStore.getState().activeTabId;
    const target = tabIdToPath(active);
    const initial = firstSync.current;
    firstSync.current = false;
    if (target === pathname) return;
    lastPushed.current = target;
    // The first sync (restoring a saved workspace at "/") replaces rather than
    // adding a history entry; later tab switches push one each.
    navigate(target, { replace: initial || route === null || route.id === active });
  }, [activeTabId, pathname, navigate]);
}
