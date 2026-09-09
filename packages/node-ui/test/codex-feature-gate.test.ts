// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Codex positive feature gate', () => {
  afterEach(() => {
    delete (window as Window & { __DKG_CODEX__?: boolean }).__DKG_CODEX__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    document.body.replaceChildren();
  });

  it('wires the injected flag through the route, initial tab, sidebar, and view', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (window as Window & { __DKG_CODEX__?: boolean }).__DKG_CODEX__ = true;
    vi.resetModules();
    vi.stubGlobal('EventSource', class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((message: { data: string }) => void) | null = null;
      addEventListener() {}
      removeEventListener() {}
      close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      let data: any = {};
      if (url.includes('/api/codex/status')) data = { connected: true, defaultCwd: '/workspace', selectedThreadId: null };
      else if (url.includes('/api/codex/threads')) data = { data: [], nextCursor: null };
      else if (url.includes('context-graph')) data = { contextGraphs: [] };
      else if (url.includes('local-agent')) data = { integrations: [] };
      return { ok: true, status: 200, json: async () => data } as Response;
    }));

    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { MemoryRouter, Route, Routes } = await import('react-router-dom');
    const features = await import('../src/ui/codex/tabFeature.js');
    const routing = await import('../src/ui/hooks/useShellRouting.js');
    const { useTabsStore } = await import('../src/ui/stores/tabs.js');
    const { PanelLeft } = await import('../src/ui/components/Shell/PanelLeft.js');
    const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
    await import('../src/ui/codex/CodexView.js');

    function ShellHarness() {
      routing.useShellRouting();
      return React.createElement(React.Fragment, null,
        React.createElement(PanelLeft), React.createElement(PanelCenter));
    }

    expect(features.enabledShellTabFeatures().map(feature => feature.id)).toContain('codex');
    expect(routing.URL_PATH_TO_TAB['/ui/codex']).toEqual({ id: 'codex', label: 'Codex' });
    expect(routing.TAB_TO_URL_PATH.codex).toBe('/ui/codex');
    expect(useTabsStore.getState()).toMatchObject({
      activeTabId: 'codex',
      tabs: expect.arrayContaining([expect.objectContaining({ id: 'codex', label: 'Codex' })]),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(
        MemoryRouter,
        { initialEntries: ['/ui/codex'] },
        React.createElement(Routes, null, React.createElement(Route, {
          path: '*', element: React.createElement(ShellHarness),
        })),
      ));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('What shall we work on?');
    const codexButtons = [...container.querySelectorAll('button')]
      .filter(button => button.textContent?.trim() === 'Codex');
    expect(codexButtons.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.v10-center-tab.active')?.textContent).toContain('Codex');
    await React.act(async () => root.unmount());
  });
});
