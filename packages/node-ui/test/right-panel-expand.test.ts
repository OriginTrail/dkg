// @vitest-environment happy-dom
// Going anywhere shows the page. The shell routing owns that rule: every address
// change, the path or only the query string, collapses the expanded right panel and
// closes a floating one. Choosing the tab already open changes no address, so the
// shell's own controls handle it through lib/shellNavigation.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useLayoutStore } from '../src/ui/stores/layout.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';
import { chooseOpenTab, chooseTab } from '../src/ui/lib/shellNavigation.js';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { UI, uiFiles } from './helpers/jsx.js';

const seen = { path: '', navigate: null as NavigateFunction | null };
function Shell() {
  useShellRouting();
  seen.path = useLocation().pathname;
  seen.navigate = useNavigate();
  return null;
}

let root: Root | null = null;
function mount(entries: string[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: entries, initialIndex: entries.length - 1 },
      React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Shell) }))));
  });
}
const expand = () => act(() => useLayoutStore.getState().setRightExpanded(true));
const expanded = () => useLayoutStore.getState().rightExpanded;

describe('showing the page on navigation', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
    useLayoutStore.setState({ rightExpanded: false, narrowPanel: null });
  });
  afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

  it('collapses when a tab opens', () => {
    mount(['/']); expand();
    act(() => useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true }));
    expect(seen.path).toBe('/settings');
    expect(expanded()).toBe(false);
  });

  it('collapses when only the query string changes', () => {
    mount(['/observability?tab=logs']); expand();
    act(() => seen.navigate!('/observability?tab=network'));
    expect(expanded()).toBe(false);
  });

  it('collapses on Back, and closes a floating panel', () => {
    mount(['/settings', '/observability']); expand();
    act(() => useLayoutStore.setState({ narrowPanel: 'right' }));
    act(() => seen.navigate!(-1));
    expect(seen.path).toBe('/settings');
    expect(expanded()).toBe(false);
    expect(useLayoutStore.getState().narrowPanel).toBeNull();
  });

  it('collapses when the shell chooses the tab already open', () => {
    mount(['/']); expand();
    act(() => chooseOpenTab('dashboard'));
    expect(expanded()).toBe(false);
    expand();
    act(() => chooseTab({ id: 'dashboard', label: 'Dashboard', closable: false }));
    expect(expanded()).toBe(false);
  });

  it('collapses when the shell chooses another tab, through the address', () => {
    mount(['/']); expand();
    act(() => chooseTab({ id: 'settings', label: 'Settings', closable: true }));
    expect(seen.path).toBe('/settings');
    expect(expanded()).toBe(false);
  });

  it('collapses when the panel closes', () => {
    mount(['/']); expand();
    act(() => useLayoutStore.getState().toggleRight());
    expect(expanded()).toBe(false);
  });

  it('leaves the panel alone when nothing navigates', () => {
    mount(['/']); expand();
    act(() => useTabsStore.getState().renameTab('dashboard', 'Home'));
    expect(expanded()).toBe(true);
  });

  it('opens the panel instead when the /agent-hub redirect replaces its entry', () => {
    act(() => useLayoutStore.setState({ rightCollapsed: true }));
    mount(['/agent-hub']);
    // What the redirect does: replace the entry with the open tab's address and { openAgents }.
    act(() => seen.navigate!('/settings', { replace: true, state: { openAgents: true } }));
    expect(seen.path).toBe('/settings');
    expect(useLayoutStore.getState().rightCollapsed).toBe(false);
    expect(expanded()).toBe(true);
  });

  it('shows the page when it loads an entry the redirect left (a reload or Back is a POP)', () => {
    act(() => useLayoutStore.setState({ rightCollapsed: false, rightExpanded: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(MemoryRouter, { initialEntries: [{ pathname: '/settings', state: { openAgents: true } }] },
        React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Shell) }))));
    });
    expect(expanded()).toBe(false);
  });
});

describe('one way to open a tab from the UI', () => {
  it('goes through lib/shellNavigation, which shows the page even when the tab is already open', () => {
    // Only the store, the helper and the shell routing (which follows the address) touch openTab.
    const allowed = new Set(['stores/tabs.ts', 'lib/shellNavigation.ts', 'hooks/useShellRouting.ts']);
    const raw = uiFiles
      .filter((f) => /\.tsx?$/.test(f) && !allowed.has(relative(UI, f).replace(/\\/g, '/')))
      .filter((f) => /useTabsStore[^;\n]*\bopenTab\b|\{[^}]*\bopenTab\b[^}]*\} = useTabsStore/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(UI, f));
    expect(raw).toEqual([]);
  });
});
