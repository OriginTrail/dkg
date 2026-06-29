// @vitest-environment happy-dom
//
// P3 — PanelCenter tab routing: opening a `conviction:<id>` tab renders the
// ConvictionDetailView (the deep-link the bell/cards use via openTab). Mocks the
// PCA fetchers so the detail mounts to its loaded state.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  fetchContextGraphs: vi.fn(),
  listPcaAgents: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchPca: mocks.fetchPca,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchContextGraphs: mocks.fetchContextGraphs,
    listPcaAgents: mocks.listPcaAgents,
  };
});

const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');
const { useTabsStore } = await import('../src/ui/stores/tabs.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';

function snap() {
  return {
    accountId: '7', owner: W0, committedTRAC: '0', committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000', topUpBuffer: '0', topUpBufferTrac: '12500.0',
    createdAtEpoch: 1, expiresAtEpoch: 1560, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 4, lastSettledWindow: 1283, fullySwept: false,
  };
}

async function waitFor(c: HTMLElement, sel: string) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (c.querySelector(sel)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${sel}" in "${c.textContent}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap(), probedKey: { key, registered: key.toLowerCase() === W0.toLowerCase() } } : snap(),
  );
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  // B3 — the detail view fetches the approved-wallet list; mock it so the routing test
  // doesn't hit a real fetch (graceful-degrade would still render, but cleaner without).
  mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [W0] });
});
afterEach(() => {
  document.body.innerHTML = '';
  useTabsStore.setState({ activeTabId: 'dashboard' });
});

describe('PanelCenter — conviction tab routing', () => {
  it('opening conviction:7 renders ConvictionDetailView', async () => {
    await act(async () => {
      useTabsStore.getState().openTab({ id: 'conviction:7', label: 'PCA #7', closable: true });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => { root.render(React.createElement(PanelCenter)); });
    // The detail view (lazy) resolves + the snapshot loads → pca-detail mounts.
    await waitFor(container, '[data-testid="pca-detail"]');
    expect(container.textContent).toContain('PCA #7');
    await act(async () => root.unmount());
    container.remove();
  });
});
