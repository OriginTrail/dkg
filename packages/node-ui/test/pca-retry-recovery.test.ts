// @vitest-environment happy-dom
//
// Retry on the Dashboard row and the Settings card, end to end through the real
// usePcaOverview: the first wallet read fails ("Couldn't check"), Retry starts a new
// read, and the recovered read shows the covering discount.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  listPcaContracts: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchPca: mocks.fetchPca, fetchWalletsBalances: mocks.fetchWalletsBalances, listPcaContracts: mocks.listPcaContracts };
});

const { PcaDashboardRow } = await import('../src/ui/pages/conviction/PcaDashboardRow.js');
const { PcaSettingsCard } = await import('../src/ui/pages/conviction/PcaSettingsCard.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const click = async (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.listPcaContracts.mockResolvedValue({ chainId: 'base:84532', nft: '0x1111111111111111111111111111111111111111', token: '0x2222222222222222222222222222222222222222' });
  // First read fails (wallets unreadable); every read after that succeeds.
  mocks.fetchWalletsBalances
    .mockRejectedValueOnce(new Error('balances down'))
    .mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
  mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
    const base = makePcaSnapshot({ accountId: id, discountBps: 3000, expiresAtTimestamp: 9_999_999_999 });
    return key ? { ...base, probedKey: { key, registered: true, adapterSupported: true } } : base;
  });
});

describe('Retry recovers after an unreadable wallet read', () => {
  it('Dashboard row: Retry reads again and shows the discount', async () => {
    usePcaStore.setState({ scopeKey: 'retry-dash', trackedIds: ['17'] });
    const { container, unmount } = await render(React.createElement(PcaDashboardRow));
    const value = () => container.querySelector('.v10-ws-pca-value')?.textContent ?? '';
    await waitFor(() => value().includes('Couldn’t check your wallets'), 'the unreadable state');
    const retry = container.querySelector('.v10-ws-pca-cta')!;
    expect(retry.textContent).toBe('Retry');
    await click(retry);
    await waitFor(() => value() === '30%', 'the recovered discount');
    expect(mocks.fetchWalletsBalances).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.v10-ws-pca-cta')!.textContent).toMatch(/Manage PCA/);
    await unmount();
  });

  it('Settings card: Retry reads again and shows the discount', async () => {
    usePcaStore.setState({ scopeKey: 'retry-settings', trackedIds: ['18'] });
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    const text = () => container.textContent ?? '';
    await waitFor(() => text().includes('Couldn’t check this node’s wallets'), 'the unreadable state');
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    expect(retry).toBeTruthy();
    await click(retry);
    await waitFor(() => text().includes('30%'), 'the recovered discount');
    expect(text()).toContain('approved publishing wallets get a 30% discount');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(false);
    await unmount();
  });
});
