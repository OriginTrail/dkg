import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTabsStore } from '../stores/tabs.js';

// Map between deep-link URL paths and centre-tab IDs. Keeping this here
// (rather than inside `useTabsStore`) lets the route layer stay a thin
// adapter — the store is still the source of truth for which tabs are
// open, but a fresh navigation to e.g. `/observability` opens that tab on
// mount and clicking the tab pushes the corresponding URL.
export const URL_PATH_TO_TAB: Record<string, { id: string; label: string }> = {
  '/observability': { id: 'operations', label: 'Observability' },
  '/operations': { id: 'operations', label: 'Observability' },
  '/settings': { id: 'settings', label: 'Settings' },
  '/admin': { id: 'admin', label: 'Admin' },
};
export const TAB_TO_URL_PATH: Record<string, string> = {
  operations: '/observability',
  settings: '/settings',
  admin: '/admin',
  dashboard: '/',
};

/**
 * Two-way sync between the address bar and the centre-tab id (BUG-018).
 *
 *   Step 1: a deep-link landing on `/observability` / `/settings` opens
 *           the matching centre tab. Keyed on `pathname` so browser
 *           back/forward also re-opens the corresponding tab.
 *
 *   Step 2: when the user clicks a deep-linkable tab the URL syncs to
 *           the mapped path so a refresh / bookmark / back+forward
 *           restores the same view. When the active tab is NOT
 *           deep-linkable (project:…, context-graph-primer, etc.)
 *           but the URL is still showing one of the deep-link paths,
 *           reset to `/` so a refresh doesn't ping-pong the user back
 *           into the old tab. Other routes (/network, /context-graph-
 *           primer) aren't in the mapping table, so they stay
 *           untouched.
 *
 * We intentionally do NOT force-switch the active tab to the dashboard
 * at `/`: other routes (e.g. the Context-Graph primer) redirect to `/`
 * after opening their own tab, and stomping the active tab here would
 * ping-pong the user back to the dashboard mid-flow.
 */
export function useShellRouting(): void {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openTab = useTabsStore((s) => s.openTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  useEffect(() => {
    const match = URL_PATH_TO_TAB[pathname];
    if (match) {
      openTab({ id: match.id, label: match.label, closable: true });
    }
  }, [pathname, openTab]);

  useEffect(() => {
    const target = TAB_TO_URL_PATH[activeTabId];
    if (target) {
      if (target !== pathname) navigate(target, { replace: true });
      return;
    }
    if (URL_PATH_TO_TAB[pathname]) {
      navigate('/', { replace: true });
    }
  }, [activeTabId, pathname, navigate]);
}
