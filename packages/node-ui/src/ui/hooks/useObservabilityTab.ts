import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { rememberObservabilityTab, searchForTab, tabFromSearch, type ObservabilityTab } from '../lib/observabilityTab.js';

/**
 * The open Observability tab, read from the address on every render, so Back
 * and Forward show the tab their entry names. Picking a tab replaces the
 * entry, so Back leaves the page rather than stepping through tabs.
 */
export function useObservabilityTab(): [ObservabilityTab, (tab: ObservabilityTab) => void] {
  const { search } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromSearch(search);

  useEffect(() => rememberObservabilityTab(tab), [tab]);

  const setTab = useCallback((next: ObservabilityTab) => {
    navigate({ search: searchForTab(next, search) }, { replace: true });
  }, [navigate, search]);

  return [tab, setTab];
}
