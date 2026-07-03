// @vitest-environment happy-dom
//
// P4 — PcaDashboardRow is actually WIRED into DashboardView (not just tested in
// isolation). Renders the real DashboardView with its fetchers + heavy hooks
// mocked (empty myCgs avoids the per-CG memory subtree) and asserts the
// "Publishing discount" row + CTA render in the dashboard.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  fetchEconomics: vi.fn(),
  fetchWalletsBalances: vi.fn(),
}));
const pca = vi.hoisted(() => ({
  overview: { covered: true, bestCoveringDiscountBps: 1000, accounts: [] as unknown[] },
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchStatus: mocks.fetchStatus,
    fetchEconomics: mocks.fetchEconomics,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
  };
});
// Empty myCgs → no per-CG rows → no useMemoryEntities/useNodeEvents subtree.
vi.mock('../src/ui/hooks/useMyContextGraphs.js', () => ({
  useMyContextGraphs: () => ({ myCgs: [], identity: null, identityLoading: false, cgsLoading: false }),
}));
vi.mock('../src/ui/hooks/usePcaOverview.js', () => ({ usePcaOverview: () => pca.overview }));

const { DashboardView } = await import('../src/ui/views/DashboardView.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';

async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if ((c.textContent ?? '').includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  pca.overview = { covered: true, bestCoveringDiscountBps: 1000, accounts: [] };
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  mocks.fetchStatus.mockResolvedValue({});
  mocks.fetchEconomics.mockResolvedValue({});
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('DashboardView — PcaDashboardRow wiring', () => {
  it('renders the "Publishing discount" row + CTA in the dashboard', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => { root.render(React.createElement(DashboardView)); });
    await waitForText(container, 'Publishing discount');
    // covered → exact discount tier; the CTA button is wired.
    expect(container.querySelector('.v10-ws-pca-value')?.textContent).toContain('10%');
    expect(container.querySelector('.v10-ws-pca-cta')).toBeTruthy();
    await act(async () => root.unmount());
    container.remove();
  });
});
