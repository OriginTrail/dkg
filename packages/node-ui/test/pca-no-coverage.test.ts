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
