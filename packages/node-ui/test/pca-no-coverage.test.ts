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
    // Every check is held until the test releases it, so the order is the test's, not the timer's.
    type Answer = { accountId: string | null };
    const pending: Array<(v: Answer) => void> = [];
    apiMocks.pcaAgentAccount.mockImplementation(() => new Promise<Answer>((r) => { pending.push(r); }));
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await wait(5);
      expect(cond()).toBe(true);
    };

    const h = await render(20);
    await wait(90); // ~4 ticks while check A is still pending
    expect(pending).toHaveLength(1); // no overlapping check started
    expect(h.value()).toBe('false');

    // A (older, uncovered) lands as the only check that ran.
    await act(async () => { pending[0]!({ accountId: null }); });
    await until(() => h.value() === 'true');

    // The next tick starts B; nothing else starts while it's pending.
    await until(() => pending.length === 2);
    await wait(60);
    expect(pending).toHaveLength(2);
    expect(h.value()).toBe('true');

    // B (newer: the sponsor approved) replaces A's answer.
    await act(async () => { pending[1]!({ accountId: '12' }); });
    await until(() => h.value() === 'false');
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
