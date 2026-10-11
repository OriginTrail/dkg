// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stand-ins identify every operational surface. Detection, subscription, route
// rendering and the authentication prompt use their production implementations.
vi.mock('../src/ui/components/Shell/Header.js', () => ({ Header: () => React.createElement('header', { 'data-operational': true }, 'Synced · 12 peers') }));
vi.mock('../src/ui/components/Shell/PanelLeft.js', () => ({ PanelLeft: () => React.createElement('aside', { 'data-operational': true }, 'Example graphs') }));
vi.mock('../src/ui/components/Shell/PanelCenter.js', () => ({ PanelCenter: () => React.createElement('main', { 'data-operational': true }, 'Example balances and spending') }));
vi.mock('../src/ui/components/Shell/PanelBottom.js', () => ({ PanelBottom: () => React.createElement('footer', { 'data-operational': true }, 'Example activity') }));
vi.mock('../src/ui/components/Shell/PanelRight.js', () => ({ PanelRight: () => React.createElement('aside', { 'data-operational': true }, 'Integrations ready') }));
vi.mock('../src/ui/pages/Network.js', () => ({ NetworkPage: () => React.createElement('section', { 'data-operational': true }, 'Example topology') }));

let root: Root | null = null;
beforeEach(() => {
  vi.resetModules();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.sessionStorage.clear();
  delete (window as any).__DKG_TOKEN__;
  delete (window as any).__DKG_USING_MOCKS__;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
  }
}

async function renderWithDeferredStatus(route = '/') {
  let release!: (status: number) => void;
  const response = new Promise<number>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ synced: true, peers: 12 }), { status: await response })));
  const { api, isUsingMocks } = await import('../src/ui/api-wrapper.js');
  const { App } = await import('../src/ui/App.js');
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(App)));
  });
  await eventually(() => { expect(document.querySelector('[data-operational]')).not.toBeNull(); });
  expect(isUsingMocks()).toBe(false);
  return { api, isUsingMocks, release };
}

describe('unavailable node presentation', () => {
  it.each(['/', '/network'])('hides all operational surfaces after the actual failed probe at %s', async (route) => {
    // Mount and subscribe while the real route-driven probe is outstanding.
    // No test call to the wrapper may start detection or pre-latch its state.
    const { api, isUsingMocks, release } = await renderWithDeferredStatus(route);
    release(503);
    await eventually(() => {
      expect(isUsingMocks()).toBe(true);
      expect(document.querySelector('[data-operational]')).toBeNull();
    });
    expect(document.body.textContent).toContain('Node unavailable');
    expect(document.body.textContent).toContain('Live node data could not be loaded');
    expect(document.body.textContent).not.toMatch(/Synced|12 peers|Example|Integrations ready/);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click(); });
    expect(reload).toHaveBeenCalledOnce();
    // Existing detection remains latched until reload, including when the
    // daemon comes back; the screen must not expose cached fallback fixtures.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await act(async () => { await api.fetchStatus(); });
    expect(document.querySelector('[data-operational]')).toBeNull();
  });

  it('keeps the live operational shell when status detection succeeds', async () => {
    const { isUsingMocks, release } = await renderWithDeferredStatus();
    release(200);
    await eventually(() => { expect((window as any).__DKG_USING_MOCKS__).toBe(false); });
    expect(isUsingMocks()).toBe(false);
    expect(document.querySelectorAll('[data-operational]').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('Node unavailable');
  });

  it('preserves token entry for a reachable node rejecting credentials', async () => {
    const { isUsingMocks, release } = await renderWithDeferredStatus();
    release(401);
    await eventually(() => { expect(document.querySelector('form[aria-label="Node API token"]')).not.toBeNull(); });
    expect(isUsingMocks()).toBe(false);
    expect(document.querySelector('form[aria-label="Node API token"]')).not.toBeNull();
    expect(document.querySelector('[data-operational]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Node unavailable');
  });
});
