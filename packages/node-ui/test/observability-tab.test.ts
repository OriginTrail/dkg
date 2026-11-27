// @vitest-environment happy-dom
// The open Observability tab lives in the address, and the address is its only
// owner: a refresh, a bookmark, Back and Forward all show the tab their entry names.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { observabilityHref, searchForTab, tabFromSearch } from '../src/ui/lib/observabilityTab.js';
import { useObservabilityTab } from '../src/ui/hooks/useObservabilityTab.js';
import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';
import { tabIdToPath } from '../src/ui/lib/tab-routes.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';

describe('Observability tab in the address', () => {
  it('reads the tab, and ignores anything unknown', () => {
    expect(tabFromSearch('?tab=network')).toBe('network');
    expect(tabFromSearch('')).toBe('operations');
    expect(tabFromSearch('?tab=nonsense')).toBe('operations');
  });

  it('writes a tab, keeps the default out of the address and keeps other values', () => {
    expect(searchForTab('network')).toBe('?tab=network');
    expect(searchForTab('operations')).toBe('');
    expect(new URLSearchParams(searchForTab('logs', '?keep=1')).get('keep')).toBe('1');
    expect(observabilityHref('network')).toBe('/observability?tab=network');
  });

  it('keeps route encoding pure: a tab always maps to the same path', () => {
    expect(tabIdToPath('operations')).toBe('/observability');
  });
});

// The page's tab buttons and body read `useObservabilityTab`; this harness renders
// exactly that, with the shell routing that opens and leaves the tab.
const seen = { tab: '', path: '', search: '', setTab: null as null | ((t: any) => void), navigate: null as null | NavigateFunction };
function Harness() {
  useShellRouting();
  const loc = useLocation();
  seen.navigate = useNavigate();
  seen.path = loc.pathname;
  seen.search = loc.search;
  return loc.pathname === '/observability' ? React.createElement(ObservabilityProbe) : null;
}
function ObservabilityProbe() {
  const [tab, setTab] = useObservabilityTab();
  seen.tab = tab;
  seen.setTab = setTab;
  return null;
}

let root: Root | null = null;
function mount(entries: string[], index = entries.length - 1) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: entries, initialIndex: index },
      React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Harness) }))));
  });
}

describe('Observability tab routing', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
  });
  afterEach(() => { act(() => root?.unmount()); root = null; });

  it('shows the tab an address names, even when another tab was shown before', () => {
    mount(['/observability?tab=logs', '/settings', '/observability?tab=network']);
    expect(seen.tab).toBe('network');
    expect(seen.search).toBe('?tab=network');
  });

  it('Back restores an earlier tab and leaves its address alone', () => {
    mount(['/observability?tab=logs', '/', '/observability?tab=network']);
    expect(seen.tab).toBe('network');
    act(() => { seen.navigate!(-2); });
    expect(seen.path).toBe('/observability');
    expect(seen.tab).toBe('logs');
    expect(seen.search).toBe('?tab=logs');
  });

  it('picking a tab replaces the entry, so Back leaves the page', () => {
    mount(['/settings', '/observability']);
    act(() => { seen.setTab!('hardware'); });
    expect(seen.search).toBe('?tab=hardware');
    act(() => { seen.navigate!(-1); });
    expect(seen.path).toBe('/settings');
  });

  it('a link to a tab opens Observability on that tab', () => {
    mount(['/settings']);
    act(() => { seen.navigate!(observabilityHref('network')); });
    expect(useTabsStore.getState().activeTabId).toBe('operations');
    expect(seen.tab).toBe('network');
  });

  it('switching back to Observability from the tab bar returns to its last tab', () => {
    mount(['/observability?tab=errors']);
    act(() => { useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true }); });
    expect(seen.path).toBe('/settings');
    act(() => { useTabsStore.getState().setActiveTab('operations'); });
    expect(seen.path).toBe('/observability');
    expect(seen.tab).toBe('errors');
  });

  it('remembers each tab on its own, and a new shell starts clean', () => {
    mount(['/observability?tab=errors']);
    act(() => { useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true }); });
    act(() => { root?.unmount(); });
    mount(['/settings']);
    act(() => { useTabsStore.getState().setActiveTab('operations'); });
    expect(seen.path).toBe('/observability');
    expect(seen.tab).toBe('operations');
  });
});
