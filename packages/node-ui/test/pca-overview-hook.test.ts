// @vitest-environment happy-dom
//
// M3 — usePcaOverview resolution engine, tested directly (the component test
// drives it with always-resolving mocks). Pins: 404→notFound vs transient→error,
// null-probe → probesInconclusive without inflating approvedCount, and the
// "a dead PCA must not advertise a discount" invariant (bestCoveringDiscountBps
// EXCLUDES expired / swept / 0-approved and picks the MAX covering bps). Also
// exercises the M2 shared poller (one entry per tracked-id set).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchWalletsBalances: mocks.fetchWalletsBalances, fetchPca: mocks.fetchPca };
});

import type { PcaOverview } from '../src/ui/hooks/usePcaOverview.js';

const { HttpError } = await import('../src/ui/api.js');
const { usePcaOverview } = await import('../src/ui/hooks/usePcaOverview.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');

const W1 = '0x71D4000000000000000000000000000000009Ac2';
const W2 = '0x3F8a0000000000000000000000000000000C1b7';

function snap(over: Record<string, unknown> = {}) {
  const FUTURE = Math.floor(Date.now() / 1000) + 60 * 86_400;
  return {
    accountId: '7', owner: '0xOWNER000000000000000000000000000000000000',
    committedTRAC: '0', committedTRACTrac: '0', baseEpochAllowance: '0',
    topUpBuffer: '1', topUpBufferTrac: '0', createdAtEpoch: 1, expiresAtEpoch: 2,
    createdAtTimestamp: 1, expiresAtTimestamp: FUTURE, discountBps: 1000,
    agentCount: 4, lastSettledWindow: 0, fullySwept: false, ...over,
  };
}

let latest: PcaOverview | null = null;
function Harness() {
  latest = usePcaOverview(0); // intervalMs 0 → load once, no interval
  return null;
}

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });
  // Let the shared-store load + notify settle.
  for (let i = 0; i < 50 && (latest == null || latest.loading); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return { unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  latest = null;
  usePcaStore.setState({ trackedIds: [], createPending: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('usePcaOverview', () => {
  it('classifies a 404 as notFound and a transient throw as error', async () => {
    usePcaStore.setState({ trackedIds: ['9', '8'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation((id: string) =>
      id === '9'
        ? Promise.reject(new HttpError(404, 'not found', { error: 'UnknownAccount' }))
        : Promise.reject(new Error('network')),
    );
    const { unmount } = await render();
    const a9 = latest!.accounts.find((a) => a.accountId === '9')!;
    const a8 = latest!.accounts.find((a) => a.accountId === '8')!;
    expect(a9.notFound).toBe(true);
    expect(a8.notFound).toBe(false);
    expect(a8.error).toBeTruthy();
    await unmount();
  });

  it('marks probesInconclusive on a null probe without inflating approvedCount', async () => {
    usePcaStore.setState({ trackedIds: ['7'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W1, W2], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation((id: string, wallet?: string) => {
      if (wallet === undefined) return Promise.resolve(snap({ accountId: '7', owner: W1 }));
      if (wallet === W1) return Promise.resolve(snap({ probedKey: { wallet: W1, registered: true } }));
      return Promise.reject(new Error('probe blew up')); // W2 → null
    });
    const { unmount } = await render();
    const a = latest!.accounts.find((x) => x.accountId === '7')!;
    expect(a.approvedCount).toBe(1);
    expect(a.probesInconclusive).toBe(true);
    await unmount();
  });

  // S2/#9 — adapterSupported:false (the adapter can't answer) → null (couldn't
  // determine), NOT not-registered → probesInconclusive, excluded from approvedCount.
  it('treats adapterSupported:false as inconclusive, not 0-approved (S2)', async () => {
    usePcaStore.setState({ trackedIds: ['7'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W1], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation((id: string, wallet?: string) => {
      if (wallet === undefined) return Promise.resolve(snap({ accountId: '7', owner: W1 }));
      return Promise.resolve(snap({ probedKey: { wallet: W1, registered: false, adapterSupported: false } }));
    });
    const { unmount } = await render();
    const a = latest!.accounts.find((x) => x.accountId === '7')!;
    expect(a.approvedCount).toBe(0);
    expect(a.probesInconclusive).toBe(true); // NOT a confirmed 0-approved
    await unmount();
  });

  // T2/#9 — distinguish an UNREADABLE wallets read (error + empty) from a genuine
  // 0-wallet node, so the discovery cards don't assert "none/not-covered" off bad data.
  it('walletsInconclusive on a failed balances read, false on a genuine 0-wallet node (T2)', async () => {
    usePcaStore.setState({ trackedIds: ['7'] });
    mocks.fetchPca.mockResolvedValue(snap({ accountId: '7' }));

    mocks.fetchWalletsBalances.mockRejectedValue(new Error('balances down')); // reject
    const r1 = await render();
    expect(latest!.walletsInconclusive).toBe(true);
    await r1.unmount();

    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], error: 'RPC timeout', chainId: '84532', rpcUrl: null }); // HTTP-200 error
    const r2 = await render();
    expect(latest!.walletsInconclusive).toBe(true);
    await r2.unmount();

    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null }); // genuine 0-wallet
    const r3 = await render();
    expect(latest!.walletsInconclusive).toBe(false);
    await r3.unmount();
  });

  it('bestCoveringDiscountBps excludes expired/swept/0-approved and picks the MAX covering', async () => {
    usePcaStore.setState({ trackedIds: ['7', '20', '10', '9', '8'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W1], balances: [], chainId: '84532', rpcUrl: null });
    const PAST = Math.floor(Date.now() / 1000) - 86_400;
    const snaps: Record<string, ReturnType<typeof snap>> = {
      '7': snap({ accountId: '7', discountBps: 1000 }),
      '20': snap({ accountId: '20', discountBps: 4000 }),
      '10': snap({ accountId: '10', discountBps: 5000, fullySwept: true }),
      '9': snap({ accountId: '9', discountBps: 6000, expiresAtTimestamp: PAST }),
      '8': snap({ accountId: '8', discountBps: 9000 }),
    };
    mocks.fetchPca.mockImplementation((id: string, wallet?: string) => {
      if (wallet === undefined) return Promise.resolve(snaps[id]);
      // '8' has no approved wallet (0-approved); all others approve W1.
      return Promise.resolve(snap({ probedKey: { wallet: W1, registered: id !== '8' } }));
    });
    const { unmount } = await render();
    expect(latest!.bestCoveringDiscountBps).toBe(4000);
    expect(latest!.covered).toBe(true);
    await unmount();
  });

  // U2 — a zero-budget approved PCA must NOT advertise a discount (align overview ↔ S5).
  it('excludes a zero-budget approved PCA from covered/bestCoveringDiscountBps (U2)', async () => {
    usePcaStore.setState({ trackedIds: ['7'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W1], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation((id: string, wallet?: string) => {
      // healthy (future expiry, not swept), approved, but ZERO budget (override the snap() default topUpBuffer:'1').
      if (wallet === undefined) return Promise.resolve(snap({ accountId: '7', topUpBuffer: '0', baseEpochAllowance: '0' }));
      return Promise.resolve(snap({ probedKey: { wallet: W1, registered: true } }));
    });
    const { unmount } = await render();
    expect(latest!.covered).toBe(false);
    expect(latest!.bestCoveringDiscountBps).toBeNull();
    await unmount();
  });

  it('M2: two consumers of the same tracked-id set share ONE wallets fetch', async () => {
    usePcaStore.setState({ trackedIds: ['7'] });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockResolvedValue(snap({ accountId: '7' }));
    // Mount two harnesses (e.g. the bell + a page) against the same key.
    const c1 = document.createElement('div');
    const c2 = document.createElement('div');
    document.body.append(c1, c2);
    const r1 = createRoot(c1);
    const r2 = createRoot(c2);
    await act(async () => { r1.render(React.createElement(Harness)); r2.render(React.createElement(Harness)); });
    for (let i = 0; i < 50 && (latest == null || latest.loading); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    // One shared poller → ONE wallets fetch, not one per consumer.
    expect(mocks.fetchWalletsBalances).toHaveBeenCalledTimes(1);
    await act(async () => { r1.unmount(); r2.unmount(); });
    c1.remove(); c2.remove();
  });
});
