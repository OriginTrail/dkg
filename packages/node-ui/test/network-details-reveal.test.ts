// @vitest-environment happy-dom
// Details in the agents panel's Network view shows Observability's Network tab, even
// when Observability is already open behind the expanded or floating panel and only
// the query string changes.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { NetworkTab } from '../src/ui/components/Shell/PanelRight/NetworkTab.js';
import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';
import { useObservabilityTab } from '../src/ui/hooks/useObservabilityTab.js';
import { useLayoutStore } from '../src/ui/stores/layout.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const seen = { search: '', tab: '' };
function ObservabilityProbe() {
  seen.tab = useObservabilityTab()[0];
  return null;
}
function Shell() {
  useShellRouting();
  const loc = useLocation();
  seen.search = loc.search;
  return React.createElement(React.Fragment, null,
    loc.pathname === '/observability' ? React.createElement(ObservabilityProbe) : null,
    React.createElement(NetworkTab, { peerAgents: [], connections: { total: 0, direct: 0, relayed: 0, rows: [] }, loading: false, onRefresh: () => undefined }));
}

let root: Root | null = null;
let container: HTMLElement;
function mount(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: [path] },
      React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Shell) }))));
  });
}
const clickDetails = () => act(() => {
  (container.querySelector('button[aria-label="Connection details"]') as HTMLButtonElement).click();
});

describe('Connection details', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
  });
  afterEach(() => {
    act(() => root?.unmount()); root = null; document.body.innerHTML = '';
    useLayoutStore.setState({ rightExpanded: false, narrowPanel: null });
  });

  it('collapses the expanded panel when Observability is already open on another tab', () => {
    mount('/observability?tab=logs');
    expect(useTabsStore.getState().activeTabId).toBe('operations');
    act(() => useLayoutStore.getState().setRightExpanded(true));
    clickDetails();
    expect(seen.search).toBe('?tab=network');
    expect(seen.tab).toBe('network');
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('closes the floating panel on a narrow screen', () => {
    mount('/observability?tab=logs');
    act(() => useLayoutStore.setState({ narrowPanel: 'right' }));
    clickDetails();
    expect(seen.tab).toBe('network');
    expect(useLayoutStore.getState().narrowPanel).toBeNull();
  });

  it('opens Observability on Network from another page', () => {
    mount('/settings');
    act(() => useLayoutStore.getState().setRightExpanded(true));
    clickDetails();
    expect(useTabsStore.getState().activeTabId).toBe('operations');
    expect(seen.tab).toBe('network');
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });
});
