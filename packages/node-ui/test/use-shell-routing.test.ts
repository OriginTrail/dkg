// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';

import { useShellRouting } from '../src/ui/hooks/useShellRouting.js';
import { pathToTab, tabIdToPath } from '../src/ui/lib/tab-routes.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { useProjectsStore } from '../src/ui/stores/projects.js';
import { encodeDocTabId } from '../src/ui/lib/doc-tab-id.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

/**
 * A tiny harness that calls `useShellRouting` and exposes the current
 * pathname + active tab id back to the test through a ref-like
 * out-parameter. We render it inside a `MemoryRouter` so React Router
 * is fully functional in the test environment.
 */
function ShellRoutingHarness({ pathnameRef, navRef }: { pathnameRef: { current: string }; navRef?: { current: NavigateFunction | null } }) {
  const loc = useLocation();
  const navigate = useNavigate();
  pathnameRef.current = loc.pathname;
  if (navRef) navRef.current = navigate;
  useShellRouting();
  return null;
}

function mountAtPath(initialPath: string, pathnameRef: { current: string }, navRef?: { current: NavigateFunction | null }): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '*',
            element: React.createElement(ShellRoutingHarness, { pathnameRef, navRef }),
          }),
        ),
      ),
    );
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
}

function resetTabsStore() {
  useTabsStore.setState({
    tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }],
    activeTabId: 'dashboard',
  });
  useProjectsStore.setState({ activeProjectId: null });
}

describe('useShellRouting (BUG-018 + Codex unmapped-tab follow-up)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    resetTabsStore();
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    resetTabsStore();
  });

  describe('tab-routes is the one route registry', () => {
    it('round-trips every place and typed tab: path → tab id → the same path', () => {
      for (const path of ['/', '/observability', '/settings', '/conviction', '/primer', '/memory-stack', '/agent-hub', '/graph/foo', '/pca/12', '/agent/cg/slug', '/open/doc:abc']) {
        const tab = pathToTab(path);
        expect(tab, path).not.toBeNull();
        expect(tabIdToPath(tab!.id), path).toBe(path);
      }
    });

    it('keeps the legacy /operations alias landing on Observability at its canonical address', () => {
      expect(pathToTab('/operations')).toEqual({ id: 'operations', label: 'Observability' });
      expect(tabIdToPath('operations')).toBe('/observability');
      expect(pathToTab('/network')).toBeNull();
    });
  });

  describe('Step 1 — deep-link landing opens the matching tab', () => {
    it('landing on /settings opens the Settings tab and makes it active', () => {
      const ref = { current: '' };
      mountAtPath('/settings', ref);
      const { tabs, activeTabId } = useTabsStore.getState();
      expect(tabs.find((t) => t.id === 'settings')).toBeDefined();
      expect(activeTabId).toBe('settings');
    });

    it('landing on /observability opens the Observability tab', () => {
      const ref = { current: '' };
      mountAtPath('/observability', ref);
      const { activeTabId } = useTabsStore.getState();
      expect(activeTabId).toBe('operations');
    });

    it('landing on /operations is a back-compat alias for /observability', () => {
      const ref = { current: '' };
      mountAtPath('/operations', ref);
      const { activeTabId } = useTabsStore.getState();
      expect(activeTabId).toBe('operations');
    });

    it('landing on a non-deep-link path leaves the dashboard tab active', () => {
      const ref = { current: '' };
      mountAtPath('/network', ref);
      const { activeTabId } = useTabsStore.getState();
      expect(activeTabId).toBe('dashboard');
    });

    it('ignores marketplace deep links while the section is disabled', () => {
      localStorage.removeItem('dkg-marketplace-enabled');
      const ref = { current: '' };
      mountAtPath('/marketplace/plans', ref);
      expect(useTabsStore.getState().activeTabId).toBe('dashboard');
    });

    it('turns nothing on from routing a deep link with ?marketplace: only the app\'s start-up does', () => {
      localStorage.removeItem('dkg-marketplace-enabled');
      window.history.replaceState({}, '', '/ui/marketplace/plans?marketplace');
      try {
        const ref = { current: '' };
        mountAtPath('/marketplace/plans', ref);
        expect(useTabsStore.getState().activeTabId).toBe('dashboard');
        expect(localStorage.getItem('dkg-marketplace-enabled')).toBeNull();
      } finally {
        window.history.replaceState({}, '', '/');
      }
    });

    it('opens a marketplace deep link once the section is enabled', () => {
      localStorage.setItem('dkg-marketplace-enabled', '1');
      try {
        const ref = { current: '' };
        mountAtPath('/marketplace/plans', ref);
        expect(useTabsStore.getState().activeTabId).toBe('marketplace-plans');
      } finally {
        localStorage.removeItem('dkg-marketplace-enabled');
      }
    });
  });

  describe('restoring a saved workspace', () => {
    async function settle() {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    it('a refresh at / lands on the saved tab, replacing / instead of adding history', async () => {
      useTabsStore.setState({
        tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }, { id: 'project:foo', label: 'Foo', closable: true }],
        activeTabId: 'project:foo',
      });
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/', ref, nav);
      await settle();
      expect([ref.current, useTabsStore.getState().activeTabId]).toEqual(['/graph/foo', 'project:foo']);
      // No entry for "/": Back has nowhere to go inside the app.
      await act(async () => { nav.current!(-1); });
      await settle();
      expect(ref.current).toBe('/graph/foo');
    });

    it('after restoring, going back to / shows the dashboard', async () => {
      useTabsStore.setState({
        tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }, { id: 'settings', label: 'Settings', closable: true }],
        activeTabId: 'settings',
      });
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/', ref, nav);
      await settle();
      await act(async () => { useTabsStore.getState().setActiveTab('dashboard'); });
      await settle();
      expect(ref.current).toBe('/');
      await act(async () => { nav.current!(-1); });
      await settle();
      expect([ref.current, useTabsStore.getState().activeTabId]).toEqual(['/settings', 'settings']);
      await act(async () => { nav.current!(1); });
      await settle();
      expect([ref.current, useTabsStore.getState().activeTabId]).toEqual(['/', 'dashboard']);
    });
  });

  describe('Step 2 — URL syncs to the active tab', () => {
    it('opens /settings → user clicks Operations tab → URL navigates to /observability', async () => {
      const ref = { current: '' };
      mountAtPath('/settings', ref);
      expect(ref.current).toBe('/settings');

      // Simulate the user clicking the Observability tab
      await act(async () => {
        useTabsStore.getState().openTab({ id: 'operations', label: 'Observability', closable: true });
      });
      expect(ref.current).toBe('/observability');
    });

    it('every tab has an address: opening a graph from /settings moves the URL to /graph/<id>', async () => {
      // Replaces the old "reset to /" rule: unmapped tabs used to drop the
      // URL back to / so a refresh lost them. Now every tab has an address.
      const ref = { current: '' };
      mountAtPath('/settings', ref);
      expect(ref.current).toBe('/settings');

      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:foo', label: 'Foo', closable: true });
      });
      expect(ref.current).toBe('/graph/foo');
    });

    it('opening a graph from the dashboard moves the URL off /', async () => {
      const ref = { current: '' };
      mountAtPath('/', ref);
      expect(ref.current).toBe('/');

      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:bar', label: 'Bar', closable: true });
      });
      expect(ref.current).toBe('/graph/bar');
    });

    it('landing on a graph address opens that graph tab', () => {
      const ref = { current: '' };
      mountAtPath('/graph/baz', ref);
      expect(useTabsStore.getState().activeTabId).toBe('project:baz');
      expect(ref.current).toBe('/graph/baz');
    });

    it('idempotent — switching to the active tab does not push history when URL already matches', async () => {
      const ref = { current: '' };
      mountAtPath('/settings', ref);
      expect(ref.current).toBe('/settings');

      // Re-asserting the same active tab should be a no-op for the
      // address bar. The hook uses `navigate(..., { replace: true })`
      // and only navigates when `target !== pathname`.
      await act(async () => {
        useTabsStore.getState().setActiveTab('settings');
      });
      expect(ref.current).toBe('/settings');
    });
  });

  describe('Back and Forward step through the tabs you visited', () => {
    async function settle() {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    it('Back returns to the previous tab and Forward restores the next one', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/settings', ref, nav);
      await settle();
      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:foo', label: 'Foo', closable: true });
      });
      await settle();
      expect(ref.current).toBe('/graph/foo');

      await act(async () => { nav.current!(-1); });
      await settle();
      expect(ref.current).toBe('/settings');
      expect(useTabsStore.getState().activeTabId).toBe('settings');

      await act(async () => { nav.current!(1); });
      await settle();
      expect(ref.current).toBe('/graph/foo');
      expect(useTabsStore.getState().activeTabId).toBe('project:foo');
    });

    it('repeated Back and Forward keep the address and the active tab in step', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/settings', ref, nav);
      await settle();
      for (const id of ['project:a', 'operations', 'project:b']) {
        await act(async () => { useTabsStore.getState().openTab({ id, label: id, closable: true }); });
        await settle();
      }
      expect(ref.current).toBe('/graph/b');

      const expectAt = (path: string, tab: string) => {
        expect(ref.current).toBe(path);
        expect(useTabsStore.getState().activeTabId).toBe(tab);
      };
      for (const [step, path, tab] of [
        [-1, '/observability', 'operations'],
        [-1, '/graph/a', 'project:a'],
        [1, '/observability', 'operations'],
        [1, '/graph/b', 'project:b'],
        [-1, '/observability', 'operations'],
        [1, '/graph/b', 'project:b'],
      ] as const) {
        await act(async () => { nav.current!(step); });
        await settle();
        expectAt(path, tab);
      }
    });

    it('Back to the dashboard address re-activates the dashboard, Forward returns to the graph', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/', ref, nav);
      await settle();
      await act(async () => { useTabsStore.getState().openTab({ id: 'project:foo', label: 'Foo', closable: true }); });
      await settle();
      expect(ref.current).toBe('/graph/foo');

      await act(async () => { nav.current!(-1); });
      await settle();
      expect(ref.current).toBe('/');
      expect(useTabsStore.getState().activeTabId).toBe('dashboard');

      await act(async () => { nav.current!(1); });
      await settle();
      expect(ref.current).toBe('/graph/foo');
      expect(useTabsStore.getState().activeTabId).toBe('project:foo');
    });

    it('revisiting a tab adds one entry per switch and none for re-selecting the active tab', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/', ref, nav);
      await settle();
      const open = async (id: string) => {
        await act(async () => { useTabsStore.getState().openTab({ id, label: id, closable: true }); });
        await settle();
      };
      await open('project:foo');                // /graph/foo
      await open('settings');                   // /settings
      await open('project:foo');                // revisit → /graph/foo again
      await act(async () => { useTabsStore.getState().setActiveTab('project:foo'); }); // no-op
      await settle();
      expect(ref.current).toBe('/graph/foo');

      // History is exactly: /, /graph/foo, /settings, /graph/foo.
      const visited: Array<[string, string]> = [];
      for (let i = 0; i < 4; i++) {
        await act(async () => { nav.current!(-1); });
        await settle();
        visited.push([ref.current, useTabsStore.getState().activeTabId]);
      }
      expect(visited).toEqual([
        ['/settings', 'settings'],
        ['/graph/foo', 'project:foo'],
        ['/', 'dashboard'],
        ['/', 'dashboard'], // nothing further back
      ]);
      for (const [path, tab] of [['/graph/foo', 'project:foo'], ['/settings', 'settings'], ['/graph/foo', 'project:foo']]) {
        await act(async () => { nav.current!(1); });
        await settle();
        expect([ref.current, useTabsStore.getState().activeTabId]).toEqual([path, tab]);
      }
    });

    it('switching tabs pushes history entries instead of replacing them', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/settings', ref, nav);
      await settle();
      await act(async () => { useTabsStore.getState().openTab({ id: 'project:foo', label: 'Foo', closable: true }); });
      await settle();
      await act(async () => { useTabsStore.getState().setActiveTab('settings'); });
      await settle();
      expect(ref.current).toBe('/settings');
      // Two Backs: /graph/foo, then the original /settings entry.
      await act(async () => { nav.current!(-1); });
      await settle();
      expect(ref.current).toBe('/graph/foo');
      await act(async () => { nav.current!(-1); });
      await settle();
      expect(ref.current).toBe('/settings');
    });
  });

  // The agent panel's chat and attachments target `activeProjectId`; every
  // way of reaching a graph tab must set it like the sidebar does.
  describe('the active graph follows the active tab', () => {
    async function settle() {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    const activeGraph = () => useProjectsStore.getState().activeProjectId;

    it('refreshing or bookmarking a graph address sets the active graph', async () => {
      const ref = { current: '' };
      mountAtPath('/graph/baz', ref);
      await settle();
      expect(activeGraph()).toBe('baz');
    });

    it('Back and Forward between graphs keep the active graph on the graph shown', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/graph/a', ref, nav);
      await settle();
      await act(async () => { useTabsStore.getState().openTab({ id: 'project:b', label: 'B', closable: true }); });
      await settle();
      expect([ref.current, activeGraph()]).toEqual(['/graph/b', 'b']);

      await act(async () => { nav.current!(-1); });
      await settle();
      expect([ref.current, useTabsStore.getState().activeTabId, activeGraph()]).toEqual(['/graph/a', 'project:a', 'a']);

      await act(async () => { nav.current!(1); });
      await settle();
      expect([ref.current, activeGraph()]).toEqual(['/graph/b', 'b']);
    });

    it("an agent, memory-layer or document tab sets the graph it belongs to, not the previous one", async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/graph/b', ref, nav);
      await settle();
      expect(activeGraph()).toBe('b');
      // The reviewer's case: from graph B to graph A's agent by address.
      await act(async () => { nav.current!('/agent/a/alice'); });
      await settle();
      expect([useTabsStore.getState().activeTabId, activeGraph()]).toEqual(['agent:a|alice', 'a']);
      await act(async () => { nav.current!(-1); });
      await settle();
      expect(activeGraph()).toBe('b');
      await act(async () => { useTabsStore.getState().openTab({ id: 'vm:c', label: 'VM', closable: true }); });
      await settle();
      expect(activeGraph()).toBe('c');
      await act(async () => { useTabsStore.getState().openTab({ id: encodeDocTabId('d', 'urn:dkg:file:keccak256:ab', 'text/markdown'), label: 'Doc', closable: true }); });
      await settle();
      expect(activeGraph()).toBe('d');
    });

    it('refreshing an agent address sets its graph', async () => {
      const ref = { current: '' };
      mountAtPath('/agent/a/alice', ref);
      await settle();
      expect(activeGraph()).toBe('a');
    });

    it('the dashboard clears it and other places leave it as it was', async () => {
      const ref = { current: '' };
      const nav = { current: null as NavigateFunction | null };
      mountAtPath('/graph/a', ref, nav);
      await settle();
      await act(async () => { useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true }); });
      await settle();
      expect(activeGraph()).toBe('a');
      await act(async () => { useTabsStore.getState().setActiveTab('dashboard'); });
      await settle();
      expect([ref.current, activeGraph()]).toEqual(['/', null]);
    });
  });
});
