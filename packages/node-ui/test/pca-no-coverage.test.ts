// @vitest-environment happy-dom
//
// useNoPcaCoverage backs the "This publish pays the full TRAC fee" line. It must keep
// rechecking while mounted: a sponsor can approve this node's wallet on an untracked PCA
// after the first check, and the full-fee claim must then go away without a remount.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({ fetchWalletsBalances: vi.fn(), pcaAgentAccount: vi.fn() }));
vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  fetchWalletsBalances: apiMocks.fetchWalletsBalances,
  pcaAgentAccount: apiMocks.pcaAgentAccount,
}));

const { useNoPcaCoverage } = await import('../src/ui/pages/conviction/useNoPcaCoverage.js');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ intervalMs }: { intervalMs: number }) {
  const confirmed = useNoPcaCoverage(intervalMs);
  return React.createElement('span', { 'data-confirmed': String(confirmed) });
}

async function render(intervalMs: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe, { intervalMs })); });
  return {
    value: () => container.querySelector('span')!.getAttribute('data-confirmed'),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  apiMocks.fetchWalletsBalances.mockResolvedValue({ wallets: ['0xaaa'], balances: [], chainId: '84532', rpcUrl: null });
  apiMocks.pcaAgentAccount.mockResolvedValue({ accountId: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('useNoPcaCoverage', () => {
  it('a sponsor approval after the first check clears the confirmation without a remount', async () => {
    const h = await render(20);
    await wait(5);
    expect(h.value()).toBe('true');
    apiMocks.pcaAgentAccount.mockResolvedValue({ accountId: '12' });
    await wait(60);
    expect(h.value()).toBe('false');
    await unmountAndCheckStopped(h);
  });

  it('a recheck that fails clears it too (unconfirmed, not stale)', async () => {
    const h = await render(20);
    await wait(5);
    expect(h.value()).toBe('true');
    apiMocks.pcaAgentAccount.mockRejectedValue(new Error('rpc down'));
    await wait(60);
    expect(h.value()).toBe('false');
    await h.unmount();
  });

  // Out-of-order guard: a slow check must never be overtaken by a newer one, so an old
  // "no coverage" answer can't land after a newer "sponsor covers it" one. While check A is
  // pending, interval ticks start no check B at all; A's answer is applied, then the next
  // tick's newer answer replaces it.
  it('a slow check is never overtaken: no overlapping checks, and the newest answer wins', async () => {
    let releaseA!: (v: { accountId: string | null }) => void;
    apiMocks.pcaAgentAccount.mockImplementationOnce(() => new Promise((r) => { releaseA = r; }));
    const h = await render(20);
    await wait(90); // ~4 ticks while A is still pending
    expect(apiMocks.pcaAgentAccount).toHaveBeenCalledTimes(1);
    expect(h.value()).toBe('false');

    apiMocks.pcaAgentAccount.mockResolvedValue({ accountId: '12' }); // the sponsor approves
    await act(async () => { releaseA({ accountId: null }); });
    // A (older, uncovered) lands first, as the only check that ran…
    expect(h.value()).toBe('true');
    // …and the next tick's newer, covered answer replaces it.
    await wait(60);
    expect(apiMocks.pcaAgentAccount.mock.calls.length).toBeGreaterThan(1);
    expect(h.value()).toBe('false');
    await h.unmount();
  });

  it('stops rechecking while the tab is hidden', async () => {
    const h = await render(20);
    await wait(5);
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      const calls = apiMocks.fetchWalletsBalances.mock.calls.length;
      await wait(90);
      expect(apiMocks.fetchWalletsBalances.mock.calls.length).toBe(calls);
    } finally {
      if (hidden) Object.defineProperty(document, 'hidden', hidden);
      else delete (document as any).hidden;
    }
    await h.unmount();
  });

  it('a wallet coming off every PCA later makes it true on the next check', async () => {
    apiMocks.pcaAgentAccount.mockResolvedValue({ accountId: '12' });
    const h = await render(20);
    await wait(5);
    expect(h.value()).toBe('false');
    apiMocks.pcaAgentAccount.mockResolvedValue({ accountId: null });
    await wait(60);
    expect(h.value()).toBe('true');
    await h.unmount();
  });
});

async function unmountAndCheckStopped(h: { unmount: () => Promise<void> }) {
  await h.unmount();
  const calls = apiMocks.fetchWalletsBalances.mock.calls.length;
  await wait(60);
  expect(apiMocks.fetchWalletsBalances.mock.calls.length).toBe(calls);
}
