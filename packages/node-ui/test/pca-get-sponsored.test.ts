// @vitest-environment happy-dom
//
// D2 — GetSponsoredPanel (S6). Pins the DRIFT-4 OUTCOME: the gas symbol is the
// native per-chain symbol (xDAI on Gnosis / ETH on Base), derived from chainId —
// NOT the TRAC `balances[].symbol`. Plus testnet-only faucet + the approval tracker.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  pcaAgentAccount: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    pcaAgentAccount: mocks.pcaAgentAccount,
  };
});

const { GetSponsoredPanel } = await import('../src/ui/pages/conviction/GetSponsoredPanel.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot } = await import('../src/ui/mocks/pca.js');

const W0 = '0x71D4000000000000000000000000000000009Ac2';
const W1 = '0x3F8a0000000000000000000000000000000000C1b7';

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
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  // N2 — the store is a module singleton seeded from localStorage; reset both.
  localStorage.clear();
  usePcaStore.setState({ trackedIds: [], createPending: null });
  // GAP-3 discovery default: nothing discovered (keeps the existing manual-check tests
  // deterministic — no real fetch). The discovery test overrides this.
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('GetSponsoredPanel', () => {
  it('shows the native gas symbol per chain (xDAI on Gnosis), NOT the TRAC balances symbol', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0],
      // balances[].symbol is the TRAC ERC-20 symbol — must NOT be used for gas.
      balances: [{ address: W0, eth: '0.5', trac: '10', symbol: 'TRAC' }],
      chainId: '100', // Gnosis → xDAI
      rpcUrl: null,
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'operational wallets');
    // The per-wallet gas line uses the native symbol.
    expect(container.querySelector('.v10-pca-wallet-gas')?.textContent).toContain('xDAI');
    // Non-testnet → no faucet link, hand-funding copy in the native symbol.
    expect(container.querySelector('a[href*="faucet"]')).toBeNull();
    expect(container.textContent).toContain('Fund with native xDAI');
    await unmount();
  });

  it('renders a testnet faucet link on a testnet chain', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0],
      balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'v9TRAC' }],
      chainId: '84532', // Base Sepolia
      rpcUrl: null,
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'operational wallets');
    const faucet = container.querySelector('a[href*="faucet"]') as HTMLAnchorElement | null;
    expect(faucet).toBeTruthy();
    expect(container.querySelector('.v10-pca-wallet-gas')?.textContent).toContain('ETH');
    await unmount();
  });

  it('tracks approval against the sponsor account id (N of M)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      // N1 — a healthy + funded snapshot so the approved W0 actually COVERS.
      ...makePcaSnapshot({ accountId: '7' }),
      probedKey: key ? { key, registered: key.toLowerCase() === W0.toLowerCase() } : undefined,
    }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Track your approval');
    setInputValue(container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Approved on PCA #7: 1 of 2 wallets');
    // W0 approved + funded + covering → ready.
    await waitForText(container, 'Ready');
    // N2 — a confirmed check persists the sponsor id for the overview/chip.
    expect(usePcaStore.getState().trackedIds).toContain('7');
    await unmount();
  });

  // S2/#9 — adapterSupported:false (the adapter can't answer) → a neutral "unknown"
  // row, NOT a false "not approved" danger.
  it('S2 — an adapterSupported:false wallet shows a neutral row, not "not approved"', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      ...makePcaSnapshot({ accountId: '7' }),
      probedKey: key
        ? key.toLowerCase() === W0.toLowerCase()
          ? { key, registered: true }
          : { key, registered: false, adapterSupported: false } // can't answer → null/unknown
        : undefined,
    }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Track your approval');
    setInputValue(container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Approved on PCA #7');
    // Scope to the approval-results section (the wallets-share list also renders a
    // statusless WalletRow for W1).
    const results = container.querySelector('.v10-pca-approve-results')!;
    const w1Row = Array.from(results.querySelectorAll('.v10-pca-wallet-row')).find((r) =>
      r.getAttribute('aria-label')?.toLowerCase().startsWith(W1.toLowerCase()),
    )!;
    const status = w1Row.querySelector('.v10-pca-wallet-status')!;
    expect(status.getAttribute('data-tone')).toBe('neutral');
    expect(status.textContent?.toLowerCase()).not.toContain('not approved');
    await unmount();
  });

  // N1 — a wallet registered on an EXPIRED/SWEPT sponsor PCA does NOT cover the
  // publish; the panel must warn, never render "Ready" (#9 false coverage).
  async function runCheckOnSponsor(snapOver: Record<string, unknown>) {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0],
      balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }], // gas-funded
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      ...makePcaSnapshot({ accountId: '7', ...snapOver }),
      probedKey: key ? { key, registered: true } : undefined, // approved, but…
    }));
    const handle = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(handle.container, 'Track your approval');
    setInputValue(handle.container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(handle.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    return handle;
  }

  it('N1 — registered on an EXPIRED sponsor PCA → warns, not Ready', async () => {
    const { container, unmount } = await runCheckOnSponsor({ expiresAtTimestamp: Math.floor(Date.now() / 1000) - 86_400 });
    await waitForText(container, 'publishes won’t get the discount');
    expect(container.textContent).not.toContain('can publish under PCA');
    await unmount();
  });

  it('N1 — registered on a FULLY-SWEPT sponsor PCA → warns, not Ready', async () => {
    const { container, unmount } = await runCheckOnSponsor({ fullySwept: true });
    await waitForText(container, 'publishes won’t get the discount');
    expect(container.textContent).not.toContain('can publish under PCA');
    await unmount();
  });

  // L4 — when the approval check fails wholesale (every probe throws → all null),
  // surface the error, never a false "0 of N approved".
  it('surfaces an error (not a false "0 approved") when the approval check fails wholesale (L4)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockRejectedValue(new Error('rpc down')); // every per-wallet probe → null
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Track your approval');
    setInputValue(container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'the chain lookup failed');
    expect(container.textContent).not.toContain('Approved on PCA #7: 0 of');
    // N2 — a wholesale-failed lookup must NOT auto-track the id.
    expect(usePcaStore.getState().trackedIds).not.toContain('7');
    await unmount();
  });

  it('shows a LOADING state (never a false-empty) while wallets are in flight, then the wallets', async () => {
    let resolve!: (v: unknown) => void;
    mocks.fetchWalletsBalances.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    // In flight: loading copy, NOT the false "No operational wallets" (the bug).
    expect(container.textContent).toContain('Loading your wallets');
    expect(container.textContent).not.toContain('No operational wallets detected');
    await act(async () => {
      resolve({ wallets: [W0], balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitForText(container, '0x71D4');
    expect(container.textContent).not.toContain('No operational wallets detected');
    // The wallet renders in both the list and the handshake half — at least one.
    expect(container.querySelectorAll('.v10-pca-wallet-row').length).toBeGreaterThanOrEqual(1);
    await unmount();
  });

  it('shows an error + Retry (not a false-empty) when the wallets fetch fails', async () => {
    mocks.fetchWalletsBalances.mockRejectedValue(new Error('rpc down'));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Couldn’t load your wallets');
    expect(container.textContent).not.toContain('No operational wallets detected');
    await unmount();
  });

  // GAP-3 discovery (#1344) — S6 surfaces the sponsoring PCA found on-chain (untracked
  // by definition) and pre-fills the manual check WITHOUT auto-tracking (guardrail b).
  it('GAP-3 — discovers + surfaces the sponsoring PCA, pre-fills the check, never auto-tracks', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0],
      balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: '7' });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'already approved on PCA #7');
    // Discovery must NOT auto-track (guardrail b) — only the explicit Check approval does.
    expect(usePcaStore.getState().trackedIds).not.toContain('7');
    // The "Check PCA #7" affordance pre-fills the manual sponsor-id input.
    const checkDiscovered = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check PCA #7')!;
    await act(async () => { checkDiscovered.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect((container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement).value).toBe('7');
    await unmount();
  });
});
