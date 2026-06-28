// @vitest-environment happy-dom
//
// D1 — ConvictionDetailView (S3): §8A owner-gating (owner actions enabled only
// when owner == wallets[0]), Settlement stays permissionless, and the
// consequence-naming deregister confirm.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  fetchContextGraphs: vi.fn(),
  pcaTopUp: vi.fn(),
  pcaSettle: vi.fn(),
  pcaRemoveAgent: vi.fn(),
  registerContextGraph: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, ...mocks };
});

const { ConvictionDetailView } = await import('../src/ui/pages/conviction/ConvictionDetailView.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';

function snap(over: Record<string, unknown> = {}) {
  return {
    accountId: '7', owner: W0, committedTRAC: '0', committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000', topUpBuffer: '0', topUpBufferTrac: '12500.0',
    createdAtEpoch: 1, expiresAtEpoch: 1560, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 4, lastSettledWindow: 1283, fullySwept: false, ...over,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now(); let last = '';
  while (Date.now() - started < 1500) {
    last = c.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}
const btn = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLButtonElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap(), probedKey: { key, registered: key.toLowerCase() === W0.toLowerCase() } } : snap(),
  );
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ConvictionDetailView §8A owner-gating', () => {
  it('enables owner actions + settle when owner == wallets[0]', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    expect(container.textContent).not.toContain('Owner-only');
    expect(btn(container, '[data-testid="pca-settle-btn"]').disabled).toBe(false);
    await unmount();
  });

  it('disables owner actions but KEEPS settle enabled for a non-owner (permissionless)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: ['0xSomeoneElse0000000000000000000000000000'], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Owner-only');
    expect(btn(container, '[data-testid="pca-topup-btn"]').disabled).toBe(true);
    // Settlement is permissionless — enabled even for non-owners.
    expect(btn(container, '[data-testid="pca-settle-btn"]').disabled).toBe(false);
    await unmount();
  });

  it('disables the settle button when fullySwept', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...snap({ fullySwept: true }), probedKey: { key, registered: false } } : snap({ fullySwept: true }),
    );
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Settlement');
    expect(btn(container, '[data-testid="pca-settle-btn"]').disabled).toBe(true);
    await unmount();
  });

  it('deregister uses a consequence-naming two-step confirm', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    // W0 probes registered → a Remove button appears in its agent row.
    await waitForText(container, 'approved');
    const remove = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!;
    expect(remove).toBeTruthy();
    await act(async () => { remove.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Confirm step names the consequence + exposes the deregister anchor.
    await waitForText(container, 'will pay the direct cost');
    expect(container.querySelector('[data-testid="pca-deregister-btn"]')).toBeTruthy();
    await unmount();
  });
});
