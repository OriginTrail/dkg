// @vitest-environment happy-dom
// The expanded right panel covers the centre, so going anywhere has to bring it back,
// including to the tab that's already open. The shell routing owns that rule; the tab
// store only records activations.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useLayoutStore } from '../src/ui/stores/layout.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';

const seen = { path: '' };
function Shell() {
  useShellRouting();
  seen.path = useLocation().pathname;
  return null;
}

let root: Root | null = null;
function mount(path: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: [path] },
      React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Shell) }))));
  });
}

describe('expanded right panel', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
    mount('/');
    act(() => useLayoutStore.getState().setRightExpanded(true));
  });
  afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

  it('collapses when a tab opens', () => {
    act(() => useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true }));
    expect(seen.path).toBe('/settings');
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('collapses when the active tab is chosen again', () => {
    act(() => useTabsStore.getState().setActiveTab(useTabsStore.getState().activeTabId));
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('collapses when the open tab is opened again', () => {
    act(() => useTabsStore.getState().openTab({ id: 'dashboard', label: 'Dashboard', closable: false }));
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('collapses when the panel closes', () => {
    act(() => useLayoutStore.getState().toggleRight());
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('leaves the panel alone when nothing navigates', () => {
    act(() => useTabsStore.getState().renameTab('dashboard', 'Home'));
    expect(useLayoutStore.getState().rightExpanded).toBe(true);
  });

  it('shows the page, and closes a floating panel, when asked to reveal the centre', () => {
    act(() => useLayoutStore.setState({ narrowPanel: 'right' }));
    act(() => useLayoutStore.getState().revealCentre());
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
    expect(useLayoutStore.getState().narrowPanel).toBeNull();
  });
});
