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
const { HttpError } = await import('../src/ui/api.js');

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
    await waitForText(container, 'publishing wallets');
    // The per-wallet gas line uses the native symbol.
    expect(container.querySelector('.v10-wallet-gas')?.textContent).toContain('xDAI');
    // Non-testnet → no faucet link, hand-funding copy in the native symbol.
    expect(container.querySelector('a[href*="faucet"]')).toBeNull();
    expect(container.textContent).toContain('Transfer xDAI to the addresses above.');
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
    await waitForText(container, 'publishing wallets');
    const faucet = container.querySelector('a[href*="faucet"]') as HTMLAnchorElement | null;
    expect(faucet).toBeTruthy();
    expect(container.querySelector('.v10-wallet-gas')?.textContent).toContain('ETH');
    await unmount();
  });

  it('checks a PCA ID passed in from the Overview as soon as the wallets load', async () => {
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
      probedKey: key ? { key, registered: key.toLowerCase() === W0.toLowerCase() } : undefined,
    }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    // No typing or clicking: the ID is pre-filled and checked once.
    await waitForText(container, 'Approved on PCA #7: 1 of 2 wallets');
    expect((container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement).value).toBe('7');
    // One read of the PCA itself, then one probe per wallet.
    expect(mocks.fetchPca.mock.calls.filter(([id]) => id === '7')).toHaveLength(3);
    await unmount();
  });

  it('tracks approval against the PCA id from the owner (N of M)', async () => {
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
    await waitForText(container, "Have a PCA ID?");
    setInputValue(container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Approved on PCA #7: 1 of 2 wallets');
    // W0 approved + funded + covering → ready.
    await waitForText(container, 'Ready');
    // N2 — a confirmed check persists the PCA id for the overview/chip.
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
    await waitForText(container, "Have a PCA ID?");
    setInputValue(container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Approved on PCA #7');
    // Scope to the approval-results section (the wallets-share list also renders a
    // statusless WalletRow for W1).
    const results = container.querySelector('.v10-pca-approve-results')!;
    const w1Row = Array.from(results.querySelectorAll('.v10-wallet-row')).find((r) =>
      r.getAttribute('aria-label')?.toLowerCase().startsWith(W1.toLowerCase()),
    )!;
    const status = w1Row.querySelector('.v10-wallet-status')!;
    expect(status.getAttribute('data-tone')).toBe('warn');
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
    await waitForText(handle.container, "Have a PCA ID?");
    setInputValue(handle.container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(handle.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    return handle;
  }

  it('N1 — registered on an EXPIRED sponsor PCA → warns, not Ready', async () => {
    const { container, unmount } = await runCheckOnSponsor({ expiresAtTimestamp: Math.floor(Date.now() / 1000) - 86_400 });
    await waitForText(container, 'has expired, so publishes pay the full fee');
    expect(container.textContent).not.toContain('can publish with PCA');
    await unmount();
  });

  it('N1 — registered on a FULLY-SWEPT sponsor PCA → warns, not Ready', async () => {
    const { container, unmount } = await runCheckOnSponsor({ fullySwept: true });
    await waitForText(container, 'has expired, so publishes pay the full fee');
    expect(container.textContent).not.toContain('can publish with PCA');
    await unmount();
  });

  // L4 — the PCA itself reads fine but every per-wallet probe throws (all null):
  // surface the error with Retry, never a false "0 of N approved".
  it('surfaces an error (not a false "0 approved") when every approval probe fails (L4), and Retry recovers', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    let probesFail = true;
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      if (key && probesFail) throw new Error('rpc down'); // every per-wallet probe -> null
      return { ...makePcaSnapshot({ accountId: '7' }), probedKey: key ? { key, registered: key.toLowerCase() === W0.toLowerCase(), adapterSupported: true } : undefined };
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, "Have a PCA ID?");
    setInputValue(container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Couldn’t check approval on PCA #7 right now.');
    // The PCA was read once, then both wallet probes ran (and failed).
    const keyed = mocks.fetchPca.mock.calls.filter(([id, key]) => id === '7' && key);
    expect(keyed.map(([, key]) => key)).toEqual([W0, W1]);
    expect(mocks.fetchPca).toHaveBeenCalledWith('7');
    expect(container.textContent).not.toContain('Approved on PCA #7: 0 of');
    // N2 — a wholesale-failed check must NOT auto-track the id. The PCA itself was read,
    // so Add is offered (read-only, coverage unknown), but nothing is tracked by itself.
    expect(usePcaStore.getState().trackedIds).not.toContain('7');
    expect(container.querySelector('[data-testid="pca-sponsor-track"]')).toBeTruthy();
    // Retry, with the probes answering this time: the real result replaces the error.
    probesFail = false;
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    await act(async () => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Approved on PCA #7: 1 of 2 wallets');
    expect(container.textContent).not.toContain('right now.');
    expect(usePcaStore.getState().trackedIds).toContain('7');
    await unmount();
  });

  // #1356 — when EVERY probe is inconclusive because the chain adapter can't answer
  // PCA queries here (capability gap, adapterSupported:false), the message says "not
  // supported here" — distinct from the transient "chain lookup failed. Retry." (L4).
  it('splits the capability-gap message from the transient failure (#1356)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    // Every wallet: the adapter can't answer → registered null via adapterSupported:false.
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      ...makePcaSnapshot({ accountId: '7' }),
      probedKey: key ? { key, registered: false, adapterSupported: false } : undefined,
    }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, "Have a PCA ID?");
    setInputValue(container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'This node can’t check PCA approval');
    // Capability gap → NOT the transient copy, and NO false "0 of N approved".
    expect(container.textContent).not.toContain('right now.');
    expect(container.textContent).not.toContain('Approved on PCA #7: 0 of');
    // Not tracked by itself (no wallet approved on the wholesale-inconclusive path)...
    expect(usePcaStore.getState().trackedIds).not.toContain('7');
    // ...but the PCA itself was read, so it can be added read-only, with coverage still unknown.
    const add = container.querySelector('[data-testid="pca-sponsor-track"]') as HTMLButtonElement;
    expect(add.textContent).toBe('Add PCA #7 to your list');
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(usePcaStore.getState().trackedIds).toContain('7');
    await waitForText(container, 'This node can’t check whether it covers your wallets.');
    await unmount();
  });

  // #1356 — MIXED all-inconclusive: one capability-gap probe (adapterSupported:false)
  // + one TRANSIENT failure (reject → null, no adapter flag). Since not EVERY probe is
  // an adapter gap, the message must be the transient "chain lookup failed. Retry.",
  // NOT "not supported here" — guards every() vs some() in the split.
  it('a mix of capability-gap + transient inconclusive uses the transient message (#1356)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      if (key && key.toLowerCase() === W1.toLowerCase()) throw new Error('rpc down'); // transient
      return {
        ...makePcaSnapshot({ accountId: '7' }),
        probedKey: key ? { key, registered: false, adapterSupported: false } : undefined, // W0 capability gap
      };
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, "Have a PCA ID?");
    setInputValue(container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement, '7');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForText(container, 'Couldn’t check approval on PCA #7 right now.');
    expect(container.textContent).not.toContain('This node can’t check PCA approval');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(true);
    // The PCA itself was read, so it can still be added; coverage stays unknown and Ready stays hidden.
    expect(container.querySelector('[data-testid="pca-sponsor-track"]')?.textContent).toBe('Add PCA #7 to your list');
    expect(container.textContent).not.toContain('Ready.');
    await unmount();
  });

  it('shows a LOADING state (never a false-empty) while wallets are in flight, then the wallets', async () => {
    let resolve!: (v: unknown) => void;
    mocks.fetchWalletsBalances.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    // In flight: loading copy, NOT the false empty state (the bug).
    expect(container.textContent).toContain('Loading your wallets');
    expect(container.querySelector('[data-testid="pca-sponsor-no-wallets"]')).toBeNull();
    await act(async () => {
      resolve({ wallets: [W0], balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitForText(container, '0x71D4');
    expect(container.querySelector('[data-testid="pca-sponsor-no-wallets"]')).toBeNull();
    // The wallet renders in both the list and the handshake half — at least one.
    expect(container.querySelectorAll('.v10-wallet-row').length).toBeGreaterThanOrEqual(1);
    await unmount();
  });

  it('shows an error + Retry (not a false-empty) when the wallets fetch fails', async () => {
    mocks.fetchWalletsBalances.mockRejectedValue(new Error('rpc down'));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Couldn’t load your wallets');
    expect(container.querySelector('[data-testid="pca-sponsor-no-wallets"]')).toBeNull();
    await unmount();
  });

  it('shows the empty state only when the wallets loaded and there are none', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'This node didn\'t report any publishing wallets.');
    expect(container.querySelector('[data-testid="pca-sponsor-no-wallets"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Couldn’t load your wallets');
    await unmount();
  });

  it('shows an error + Retry when wallet balances resolve with an error body', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [],
      balances: [],
      error: 'RPC timeout',
      chainId: '84532',
      rpcUrl: null,
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(container, 'Couldn’t load your wallets');
    expect(container.querySelector('[data-testid="pca-sponsor-no-wallets"]')).toBeNull();
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
    expect((container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement).value).toBe('7');
    await unmount();
  });
});

describe('GetSponsoredPanel — checking with no publishing wallets', () => {
  it('reads the PCA itself, says there are no wallets to check, and offers Add for a PCA that exists', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (id: string) => makePcaSnapshot({ accountId: id }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '999' }));
    await waitForText(container, 'PCA #999 exists, but this node reported no publishing wallets to check.');
    // One read of the PCA itself, and no per-wallet probes.
    expect(mocks.fetchPca.mock.calls).toEqual([['999']]);
    expect(container.textContent).not.toContain('Approved on PCA #999');
    expect(usePcaStore.getState().trackedIds).not.toContain('999');
    const add = container.querySelector('[data-testid="pca-sponsor-track"]') as HTMLButtonElement;
    expect(add.textContent).toBe('Add PCA #999 to your list');
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(usePcaStore.getState().trackedIds).toContain('999');
    await unmount();
  });

  it('never offers Add for a PCA that doesn’t exist', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockRejectedValue(new HttpError(404, 'Not found', { error: 'PCA_NOT_FOUND' }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '999' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(mocks.fetchPca).toHaveBeenCalledWith('999');
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-sponsor-track"]')).toBeNull();
    expect(container.textContent).not.toContain('Approved on PCA #999');
    expect(usePcaStore.getState().trackedIds).not.toContain('999');
    await unmount();
  });
});

describe('GetSponsoredPanel — a balance error with known wallet addresses', () => {
  it('still probes the known wallets, tracks an approved PCA, and keeps Ready off without gas data', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null, error: 'RPC timeout' });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => ({
      ...makePcaSnapshot({ accountId: id }),
      probedKey: key ? { key, registered: true, adapterSupported: true } : undefined,
    }));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Approved on PCA #7: 1 of 1 wallets');
    expect(mocks.fetchPca.mock.calls.filter(([id, key]) => id === '7' && key).map(([, key]) => key)).toEqual([W0]);
    expect(usePcaStore.getState().trackedIds).toContain('7');
    // Gas is unknown (no balances), so the node isn't declared ready to publish.
    expect(container.textContent).not.toContain('Ready.');
    await unmount();
  });
});

describe('GetSponsoredPanel — adding a partially checked PCA', () => {
  it('keeps coverage uncertain when one wallet is unregistered and the other wallet’s check failed', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0.08', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (key && key.toLowerCase() === W1.toLowerCase()) throw new Error('rpc down'); // W1: failed check
      return { ...makePcaSnapshot({ accountId: id }), probedKey: key ? { key, registered: false, adapterSupported: true } : undefined };
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Approved on PCA #7: 0 of 2 wallets');
    await act(async () => {
      (container.querySelector('[data-testid="pca-sponsor-track"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(container, 'PCA #7 is in your list. This node couldn’t check every wallet, so it may already cover some.');
    expect(container.textContent).not.toContain('until the owner approves these wallets');
    await unmount();
  });

  it('says owner approval is needed only when every wallet is confirmed unregistered', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0, W1], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => (
      { ...makePcaSnapshot({ accountId: id }), probedKey: key ? { key, registered: false, adapterSupported: true } : undefined }
    ));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Approved on PCA #7: 0 of 2 wallets');
    await act(async () => {
      (container.querySelector('[data-testid="pca-sponsor-track"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(container, 'PCA #7 is in your list. It gives no discount until the owner approves these wallets.');
    await unmount();
  });
});

describe('GetSponsoredPanel — a failed chain lookup of the PCA', () => {
  it('treats 503 PCA_LOOKUP_READ_FAILED as temporary with Retry, not as PCAs being unavailable', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    let lookupFails = true;
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (!key && lookupFails) throw new HttpError(503, 'Service Unavailable', { code: 'PCA_LOOKUP_READ_FAILED' });
      return { ...makePcaSnapshot({ accountId: id }), probedKey: key ? { key, registered: true, adapterSupported: true } : undefined };
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Couldn’t check PCA #7 right now.');
    expect(container.textContent).not.toContain('aren\'t available on this network');
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    expect(retry).toBeTruthy();
    lookupFails = false;
    await act(async () => { retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Approved on PCA #7: 1 of 1 wallets');
    await unmount();
  });
});

describe('GetSponsoredPanel — rechecking', () => {
  it('reruns the submitted check with the recovered wallets after a wallet Retry', async () => {
    mocks.fetchWalletsBalances
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue({ wallets: [W0], balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => (
      { ...makePcaSnapshot({ accountId: id }), probedKey: key ? { key, registered: true, adapterSupported: true } : undefined }
    ));
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Retry loading the wallets above.');
    // The wallet section's Retry is the first one; the check offers none for unreadable wallets.
    const walletRetry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    await act(async () => { walletRetry.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Approved on PCA #7: 1 of 1 wallets');
    expect(container.textContent).not.toContain('Retry loading the wallets above.');
    expect(mocks.fetchPca.mock.calls.filter(([id, key]) => id === '7' && key).map(([, key]) => key)).toEqual([W0]);
    await unmount();
  });

  it('clears the previous PCA’s result and Ready while a new check runs, then shows only the new one', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0], balances: [{ address: W0, eth: '0.08', trac: '0', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null,
    });
    let release8!: () => void;
    const pca8Read = new Promise<void>((r) => { release8 = r; });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (id === '8' && !key) await pca8Read; // PCA #8's account read is held back
      return { ...makePcaSnapshot({ accountId: id }), probedKey: key ? { key, registered: id === '7', adapterSupported: true } : undefined };
    });
    const { container, unmount } = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn(), initialAccountId: '7' }));
    await waitForText(container, 'Approved on PCA #7: 1 of 1 wallets');
    expect(container.textContent).toContain('Ready.');

    const input = container.querySelector('input[aria-label="PCA ID from owner"]') as HTMLInputElement;
    await act(async () => { setInputValue(input, '8'); });
    const checkBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!;
    await act(async () => { checkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // While #8 is read, nothing from #7 stays on screen.
    expect(container.textContent).toContain('Checking…');
    expect(container.textContent).not.toContain('PCA #7');
    expect(container.textContent).not.toContain('Ready.');
    expect(container.querySelector('.v10-pca-approve-results')).toBeNull();

    await act(async () => { release8(); });
    await waitForText(container, 'Approved on PCA #8: 0 of 1 wallets');
    expect(container.textContent).not.toContain('Approved on PCA #7');
    expect(container.textContent).not.toContain('Ready.');
    await unmount();
  });
});
