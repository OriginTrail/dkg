// @vitest-environment happy-dom
// The marketplace section inside the shell: the real sidebar, centre panel and
// address routing, mounted under the app's catch-all route, on the fixture
// node. Each sidebar row opens its own view, loaded from the node, and the
// address follows; a deep link to an enabled section lands on its view.
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PanelLeft } from '../src/ui/components/Shell/PanelLeft.js';
import { PanelCenter } from '../src/ui/components/Shell/PanelCenter.js';
import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { useLayoutStore } from '../src/ui/stores/layout.js';
import { useProjectsStore } from '../src/ui/stores/projects.js';
import { MARKETPLACE_FLAG_KEY, activateMarketplaceFromUrl } from '../src/ui/marketplace/tabs.js';
import { fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { byTestId, click, render, unmountAll } from './helpers/marketplace-render.js';
import { json, waitUntil } from './helpers/marketplace-nodes.js';

// The shell opens on the dashboard, which has its own suites and reads half
// the node; a stand-in keeps this suite on the marketplace.
vi.mock('../src/ui/views/DashboardView.js', () => ({
  DashboardView: () => React.createElement('div', { 'data-testid': 'dashboard' }, 'Dashboard'),
}));

const VIEWS = [
  { row: 'Browse', path: '/marketplace', tab: 'marketplace', label: 'NeuroSymbolic Marketplace', view: 'mkt-marketplace', loaded: 'ok' },
  { row: 'Plans', path: '/marketplace/plans', tab: 'marketplace-plans', label: 'Plans', view: 'mkt-plans', loaded: 'active' },
  { row: 'Access', path: '/marketplace/access', tab: 'marketplace-access', label: 'Access', view: 'mkt-access', loaded: 'ok' },
  { row: 'Operate', path: '/marketplace/operate', tab: 'marketplace-operate', label: 'Operate', view: 'mkt-operate', loaded: 'active' },
] as const;

/** The fixture node: its marketplace, and the little the sidebar reads besides (status, an empty graph list, the agent). */
function shellNode(): void {
  const marketplace = fixtureFetch('active');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(url, 'http://node.localhost');
    if (pathname === '/api/status') return json({ ok: true });
    if (pathname === '/api/context-graph/list') return json({ contextGraphs: [] });
    if (pathname === '/api/agent/identity') return json({ agentAddress: '0x00000000000000000000000000000000000000a1', agentDid: 'did:dkg:agent:fixture', name: 'Fixture agent', peerId: 'fixture-peer', nodeIdentityId: '7' });
    return marketplace(input, init);
  });
  // The sidebar listens for node events; the fixture node sends none.
  vi.stubGlobal('EventSource', class {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  });
}

/** What AppShell mounts for the address, with the path it ends up on kept in `at`. */
function shellAt(path: string, at: { current: string }): React.ReactElement {
  function Shell() {
    at.current = useLocation().pathname;
    useShellRouting();
    return React.createElement(React.Fragment, null, React.createElement(PanelLeft), React.createElement(PanelCenter));
  }
  return React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Shell) })));
}

/** A row of the sidebar's Marketplace section, and nothing else (the tab bar has buttons named the same). */
function row(shell: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(shell.querySelectorAll<HTMLButtonElement>('.v10-sidebar-marketplace-items button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no Marketplace row "${label}" in the sidebar`);
  return found;
}

/** The view is loaded from the node, and it is the only marketplace view on show. */
async function showsOnly(shell: HTMLElement, v: (typeof VIEWS)[number]): Promise<void> {
  await waitUntil(() => byTestId(shell, v.view)?.getAttribute('data-state') === v.loaded, `${v.row} to show its view, loaded`);
  for (const other of VIEWS) if (other !== v) expect(byTestId(shell, other.view)).toBeNull();
}

function expectAt(shell: HTMLElement, at: { current: string }, v: (typeof VIEWS)[number]): void {
  expect(at.current).toBe(v.path);
  expect(useTabsStore.getState().activeTabId).toBe(v.tab);
  expect(shell.querySelector('.v10-center-tab.active')?.textContent).toBe(v.label);
  for (const other of VIEWS) expect(row(shell, other.row).getAttribute('aria-current')).toBe(other === v ? 'page' : null);
}

describe('marketplace in the shell', () => {
  // The views load as their tabs open; loading their modules once here keeps
  // the first open of each from racing its timeout. The shell still opens each
  // through its own loader.
  beforeAll(async () => {
    await Promise.all([
      import('../src/ui/marketplace/views/MarketplaceView.js'),
      import('../src/ui/marketplace/views/PlansView.js'),
      import('../src/ui/marketplace/views/AccessView.js'),
      import('../src/ui/marketplace/views/OperateView.js'),
    ]);
  }, 30_000);

  beforeEach(() => {
    useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
    useProjectsStore.setState({ activeProjectId: null });
    useLayoutStore.setState({ leftSectionMarketplaceOpen: true, leftSectionMyProjectsOpen: true, leftSectionContextOracleOpen: false, leftSectionIntegrationsOpen: false });
    shellNode();
  });

  afterEach(async () => {
    await unmountAll();
    window.history.replaceState({}, '', '/');
  });

  it('opens Browse, Plans, Access and Operate from their sidebar rows, each its own view, and the address follows', async () => {
    localStorage.setItem(MARKETPLACE_FLAG_KEY, '1');
    const at = { current: '' };
    const shell = await render(shellAt('/', at));
    expect(byTestId(shell, 'dashboard')).not.toBeNull();
    expect(at.current).toBe('/');
    for (const v of VIEWS) {
      await click(row(shell, v.row));
      await showsOnly(shell, v);
      expect(byTestId(shell, 'dashboard')).toBeNull();
      expectAt(shell, at, v);
    }
  });

  it.each(VIEWS)('lands a deep link to $path on its view, once the section is enabled', async (v) => {
    localStorage.setItem(MARKETPLACE_FLAG_KEY, '1');
    const at = { current: '' };
    const shell = await render(shellAt(v.path, at));
    await showsOnly(shell, v);
    expectAt(shell, at, v);
  });

  it('lands a first visit through a link that enables the section on the view it names', async () => {
    // As the app starts: the link's ?marketplace turns the section on before anything renders.
    window.history.replaceState({}, '', '/marketplace/access?marketplace');
    activateMarketplaceFromUrl();
    const at = { current: '' };
    const shell = await render(shellAt('/marketplace/access?marketplace', at));
    const access = VIEWS[2];
    await showsOnly(shell, access);
    expectAt(shell, at, access);
  });
});
