// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import {
  TAB_TO_URL_PATH,
  URL_PATH_TO_TAB,
  useShellRouting,
} from '../src/ui/hooks/useShellRouting.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

/**
 * A tiny harness that calls `useShellRouting` and exposes the current
 * pathname + active tab id back to the test through a ref-like
 * out-parameter. We render it inside a `MemoryRouter` so React Router
 * is fully functional in the test environment.
 */
function ShellRoutingHarness({ pathnameRef }: { pathnameRef: { current: string } }) {
  const loc = useLocation();
  pathnameRef.current = loc.pathname;
  useShellRouting();
  return null;
}

function mountAtPath(initialPath: string, pathnameRef: { current: string }): void {
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
            element: React.createElement(ShellRoutingHarness, { pathnameRef }),
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

  describe('mapping table integrity', () => {
    it('every URL path maps to a tab id that has a corresponding URL back-mapping', () => {
      // Round-trip /settings -> settings -> /settings is the
      // contract Step 2 of the hook depends on. If a path ever maps
      // to a tab id that has no back-mapping the URL would never
      // sync after a tab click.
      for (const path of Object.keys(URL_PATH_TO_TAB)) {
        const tabId = URL_PATH_TO_TAB[path].id;
        expect(TAB_TO_URL_PATH).toHaveProperty(tabId);
      }
    });

    it('TAB_TO_URL_PATH covers the canonical tabs (operations, settings, dashboard)', () => {
      expect(TAB_TO_URL_PATH.operations).toBeDefined();
      expect(TAB_TO_URL_PATH.settings).toBeDefined();
      expect(TAB_TO_URL_PATH.dashboard).toBeDefined();
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

    it('Codex follow-up: deep-link to /settings → open project tab (unmapped) → URL resets to / so refresh lands on dashboard', async () => {
      // The previous implementation only updated the URL for tabs in
      // TAB_TO_URL_PATH. Deep-linking to /settings then opening a
      // project:foo tab left pathname stuck at /settings, so refresh
      // dropped the user back into Settings instead of the project
      // they were viewing.
      const ref = { current: '' };
      mountAtPath('/settings', ref);
      expect(ref.current).toBe('/settings');

      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:foo', label: 'Foo', closable: true });
      });
      expect(ref.current).toBe('/');
    });

    it('returns to / when an unmapped tab is opened from the dashboard (active tab is dashboard, no clobber of other deep-link paths)', async () => {
      const ref = { current: '' };
      mountAtPath('/', ref);
      expect(ref.current).toBe('/');

      // Open an unmapped tab; URL stays at / (dashboard's mapped path).
      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:bar', label: 'Bar', closable: true });
      });
      // Active tab is now unmapped, and pathname is '/' which is NOT
      // in URL_PATH_TO_TAB. The hook leaves the URL alone — Step 2's
      // reset only fires when pathname IS a known deep-link path.
      expect(ref.current).toBe('/');
    });

    it('the unmapped-tab reset is scoped to known deep-link paths: switching from /observability to a project tab triggers the reset (BUG-018 follow-up scope)', async () => {
      const ref = { current: '' };
      mountAtPath('/observability', ref);
      expect(ref.current).toBe('/observability');

      await act(async () => {
        useTabsStore.getState().openTab({ id: 'project:baz', label: 'Baz', closable: true });
      });
      expect(ref.current).toBe('/');
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
});
