// @vitest-environment happy-dom
// The Agent hub page is gone: its old address opens the right panel, expanded on a
// wide screen and floating on a narrow one, over the tab that was open.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { useLayoutStore } from '../src/ui/stores/layout.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: { fetchStatus: vi.fn(async () => ({ synced: true, peers: 0 })) },
  detectMockMode: async () => false,
  isUsingMocks: () => false,
  subscribeMockMode: () => () => {},
}));
vi.mock('../src/ui/api.js', () => ({ authHeaders: () => ({}), fileUrl: () => '' }));
vi.mock('../src/ui/components/Shell/Header.js', () => ({ Header: () => React.createElement('header') }));
vi.mock('../src/ui/components/Shell/PanelLeft.js', () => ({ PanelLeft: () => React.createElement('aside') }));
vi.mock('../src/ui/components/Shell/PanelCenter.js', () => ({ PanelCenter: () => React.createElement('main', { 'data-testid': 'centre' }) }));
vi.mock('../src/ui/components/Shell/PanelBottom.js', () => ({ PanelBottom: () => React.createElement('footer') }));
vi.mock('../src/ui/components/Shell/PanelRight.js', () => ({ PanelRight: () => React.createElement('aside', { 'data-testid': 'right-panel' }) }));
vi.mock('../src/ui/hooks/useNodeState.js', () => ({ useNodeStatusPolling: () => undefined }));

const { App } = await import('../src/ui/App.js');

const seen = { path: '', state: null as unknown, navigate: null as null | ReturnType<typeof useNavigate> };
function Probe() {
  const loc = useLocation();
  seen.path = loc.pathname;
  seen.state = loc.state;
  seen.navigate = useNavigate();
  return null;
}

function setNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    onchange: null, dispatchEvent: () => false,
  })) as any;
}

let root: Root | null = null;
async function visit(path: string, strict = false) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    const tree = React.createElement(MemoryRouter, { initialEntries: [path] },
      React.createElement(App), React.createElement(Probe));
    root!.render(strict ? React.createElement(React.StrictMode, null, tree) : tree);
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe('/agent-hub', () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }, { id: 'settings', label: 'Settings', closable: true }],
      activeTabId: 'settings',
    });
    useLayoutStore.setState({ rightCollapsed: true, rightExpanded: false, narrowPanel: null });
  });
  afterEach(async () => {
    await act(async () => root?.unmount()); root = null; document.body.innerHTML = '';
  });

  it('opens the right panel expanded on a wide screen, over the open tab', async () => {
    setNarrow(false);
    await visit('/agent-hub');
    expect(seen.path).toBe('/settings');
    expect(seen.state).toEqual({ agentsOpened: true });
    const layout = useLayoutStore.getState();
    expect(layout.rightCollapsed).toBe(false);
    expect(layout.rightExpanded).toBe(true);
    expect(useTabsStore.getState().activeTabId).toBe('settings');
  });

  it('opens the floating panel on a narrow screen', async () => {
    setNarrow(true);
    await visit('/agent-hub');
    expect(seen.path).toBe('/settings');
    const layout = useLayoutStore.getState();
    expect(layout.narrowPanel).toBe('right');
    expect(layout.rightExpanded).toBe(false);
  });

  it('stays open under StrictMode, which runs the redirect effect twice (narrow)', async () => {
    setNarrow(true);
    await visit('/agent-hub', true);
    expect(seen.path).toBe('/settings');
    expect(useLayoutStore.getState().narrowPanel).toBe('right');
  });

  it('stays expanded under StrictMode (wide)', async () => {
    setNarrow(false);
    await visit('/agent-hub', true);
    const layout = useLayoutStore.getState();
    expect(layout.rightCollapsed).toBe(false);
    expect(layout.rightExpanded).toBe(true);
  });

  it('a later navigation still shows the page', async () => {
    setNarrow(false);
    await visit('/agent-hub');
    await act(async () => { useTabsStore.getState().openTab({ id: 'dashboard', label: 'Dashboard', closable: false }); });
    expect(seen.path).toBe('/');
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  // The redirect marks its entry, and only its own replace keeps the panel open.
  for (const strict of [false, true]) {
    it(`Back to the redirected entry shows the page${strict ? ' (StrictMode)' : ''}`, async () => {
      setNarrow(false);
      await visit('/agent-hub', strict);
      expect(seen.path).toBe('/settings');
      expect(useLayoutStore.getState().rightExpanded).toBe(true);
      await act(async () => { useTabsStore.getState().openTab({ id: 'operations', label: 'Observability', closable: true }); });
      expect(seen.path).toBe('/observability');
      await act(async () => { useLayoutStore.getState().setRightExpanded(true); });
      await act(async () => { seen.navigate!(-1); });
      expect(seen.path).toBe('/settings');
      expect(seen.state).toEqual({ agentsOpened: true });
      expect(useTabsStore.getState().activeTabId).toBe('settings');
      expect(useLayoutStore.getState().rightExpanded).toBe(false);
    });
  }

  it('Back to the redirected entry closes the floating panel on a narrow screen', async () => {
    setNarrow(true);
    await visit('/agent-hub');
    expect(useLayoutStore.getState().narrowPanel).toBe('right');
    await act(async () => { useTabsStore.getState().openTab({ id: 'operations', label: 'Observability', closable: true }); });
    await act(async () => { useLayoutStore.getState().openRight(); });
    expect(useLayoutStore.getState().narrowPanel).toBe('right');
    await act(async () => { seen.navigate!(-1); });
    expect(seen.path).toBe('/settings');
    expect(useLayoutStore.getState().narrowPanel).toBe(null);
  });
});
