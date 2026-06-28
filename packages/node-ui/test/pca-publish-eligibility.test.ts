// @vitest-environment happy-dom
//
// E1 — the S5 publish-eligibility chip: the 4-state fail-toward-loud verdict at
// the moment of spend (green / amber / danger #6 / neutral), and "no chip when
// nothing is tracked". Mocks the PCA fetchers; uses the shared E3 fixtures.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  fetchContextGraphs: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchWalletsBalances: mocks.fetchWalletsBalances, fetchPca: mocks.fetchPca, fetchContextGraphs: mocks.fetchContextGraphs };
});

const { PublishEligibilityChip } = await import('../src/ui/pages/conviction/PublishEligibilityChip.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot } = await import('../src/ui/mocks/pca.js');

const W0 = '0x71D4000000000000000000000000000000009Ac2';

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

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  usePcaStore.setState({ trackedIds: ['7'], createPending: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
});
afterEach(() => { document.body.innerHTML = ''; });

function walletsBalances(trac: string) {
  return { wallets: [W0], balances: [{ address: W0, eth: '0.1', trac, symbol: 'TRAC' }], chainId: '84532', rpcUrl: null };
}

describe('PublishEligibilityChip (S5)', () => {
  it('renders nothing when the node tracks no PCA', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: null });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(container.querySelector('[data-testid="pca-publish-eligibility"]')).toBeNull();
    await unmount();
  });

  it('GREEN when every signing wallet is covered by a healthy PCA', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7');
    expect(container.textContent).toContain('30%');
    await unmount();
  });

  it('DANGER (#6) when a fall-through wallet has NO TRAC → role=alert "Publish will fail"', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert');
    await unmount();
  });

  it('AMBER when a fall-through wallet HAS TRAC (pays the direct cost)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert'); // amber is also loud/assertive
    await unmount();
  });

  it('"why?" opens the preflight popover with the per-condition breakdown', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'All signing wallets approved');
    expect(container.querySelector('.v10-pca-publish-popover')).toBeTruthy();
    await unmount();
  });
});
