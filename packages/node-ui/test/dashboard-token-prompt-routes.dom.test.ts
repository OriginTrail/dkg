// @vitest-environment happy-dom

// The token prompt must be reachable from every page the dashboard serves:
// render the real Root -> router -> App tree (heavy panels mocked, as in
// app-primer-route.test.ts) with the node rejecting the page's credentials,
// and check that the prompt is on screen for the dashboard and /network.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { forgetEnteredApiToken } from '../src/ui/lib/apiToken.js';

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: { fetchStatus: vi.fn(async () => ({ synced: true, peers: 0 })) },
  isUsingMocks: () => false,
  subscribeMockMode: () => () => {},
}));
vi.mock('../src/ui/api.js', () => ({ authHeaders: () => ({}), fileUrl: () => '' }));
vi.mock('../src/ui/components/Shell/Header.js', () => ({
  Header: () => React.createElement('header', { 'data-testid': 'header' }),
}));
vi.mock('../src/ui/components/Shell/PanelLeft.js', () => ({
  PanelLeft: () => React.createElement('aside', { 'data-testid': 'left-panel' }),
}));
vi.mock('../src/ui/components/Shell/PanelCenter.js', () => ({
  PanelCenter: () => React.createElement('main', { 'data-testid': 'center-panel' }),
}));
vi.mock('../src/ui/components/Shell/PanelBottom.js', () => ({
  PanelBottom: () => React.createElement('footer', { 'data-testid': 'bottom-panel' }),
}));
vi.mock('../src/ui/components/Shell/PanelRight.js', () => ({
  PanelRight: () => React.createElement('aside', { 'data-testid': 'right-panel' }),
}));
vi.mock('../src/ui/pages/Network.js', () => ({
  NetworkPage: () => React.createElement('section', { 'data-testid': 'network-page' }),
}));

const { Root } = await import('../src/ui/Root.js');

let root: ReactRoot | null = null;

async function renderAt(url: string, probeStatus: number): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', url);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: probeStatus })));
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(React.createElement(Root)); });
  return container;
}

/**
 * Flush React until `ready()` holds or the deadline passes. The /network page
 * is lazy-loaded, and its import settles later under coverage instrumentation,
 * so a fixed number of ticks is not enough.
 */
async function settle(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
  forgetEnteredApiToken();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetEnteredApiToken();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('token prompt in the dashboard route tree', () => {
  it.each([
    ['/ui/', 'center-panel'],
    ['/ui/network', 'network-page'],
  ])('asks for the API token at %s when the node rejects the page', async (url, pageTestId) => {
    const container = await renderAt(url, 401);
    const page = () => container.querySelector(`[data-testid="${pageTestId}"]`);
    const prompt = () => container.querySelector('form[aria-label="Node API token"]');
    await settle(() => page() !== null && prompt() !== null);
    expect(page()).not.toBeNull();
    expect(prompt()).not.toBeNull();
  });

  it.each([
    ['/ui/', 'center-panel'],
    ['/ui/network', 'network-page'],
  ])('shows no prompt at %s when the page was served with a token', async (url, pageTestId) => {
    window.__DKG_TOKEN__ = 'served-token';
    const container = await renderAt(url, 401);
    await settle(() => container.querySelector(`[data-testid="${pageTestId}"]`) !== null);
    expect(container.querySelector(`[data-testid="${pageTestId}"]`)).not.toBeNull();
    expect(container.querySelector('form[aria-label="Node API token"]')).toBeNull();
  });
});
