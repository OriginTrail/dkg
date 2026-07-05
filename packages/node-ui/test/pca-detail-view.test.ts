// @vitest-environment happy-dom
//
// D1 — ConvictionDetailView (S3): §8A owner-gating (owner actions enabled only
// when owner == wallets[0]) and consequence-naming deregister confirm.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  fetchContextGraphs: vi.fn(),
  listPcaAgents: vi.fn(),
  pcaTopUp: vi.fn(),
  pcaSettle: vi.fn(),
  pcaRemoveAgent: vi.fn(),
  registerContextGraph: vi.fn(),
  listPcaContracts: vi.fn(),
  publicClientFor: vi.fn(),
  // The renew path renders the real CreatePcaModal → the §3b picker + B1 probe.
  pcaAgentAccount: vi.fn(),
  listDesignatableNodes: vi.fn(),
  walletOwnerActionSubmitter: vi.fn(),
  walletTopUp: vi.fn(),
  walletDeregisterAgent: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, ...mocks };
});

vi.mock('../src/ui/web3/clients.js', () => ({
  publicClientFor: mocks.publicClientFor,
}));

vi.mock('../src/ui/web3/walletOwnerActionSubmitter.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/web3/walletOwnerActionSubmitter.js')>();
  return {
    ...actual,
    walletOwnerActionSubmitter: mocks.walletOwnerActionSubmitter,
  };
});

const { ConvictionDetailView } = await import('../src/ui/pages/conviction/ConvictionDetailView.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');
const { HttpError } = await import('../src/ui/api.js');
const { WalletTxStepError } = await import('../src/ui/web3/walletTxError.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';
const CONNECTED_OWNER = '0x' + 'd'.repeat(40);
const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};
const PCA_SCOPE = 'base:84532:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222';

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
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const findBtn = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text)!;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  usePcaStore.setState({ scopeKey: null, trackedIds: [], createPending: null, topUpPending: {}, createPendingPersisted: false });
  usePcaStore.getState().setScope(PCA_SCOPE);
  useWalletStore.setState({
    provider: null,
    providerInfo: null,
    address: null,
    chainId: null,
    expectedChainId: null,
    bootstrap: null,
  });
  mocks.listPcaContracts.mockResolvedValue(CONTRACTS);
  mocks.publicClientFor.mockReturnValue({
    getTransactionReceipt: vi.fn(async () => {
      throw new Error('receipt pending');
    }),
  });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap(), probedKey: { key, registered: key.toLowerCase() === W0.toLowerCase() } } : snap(),
  );
  // B3 — default to the happy full-list path (W0 = this node's wallet, approved).
  mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [W0] });
  // Renew → real CreatePcaModal: stub the picker list + B1 probe (no real fetch).
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
  mocks.listDesignatableNodes.mockResolvedValue({ nodes: [], total: 0, nextStart: null });
  mocks.walletOwnerActionSubmitter.mockReturnValue({
    create: vi.fn(),
    registerAgent: vi.fn(),
    deregisterAgent: mocks.walletDeregisterAgent,
    topUp: mocks.walletTopUp,
    settle: vi.fn(),
  });
});
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  usePcaStore.getState().setScope(null);
  usePcaStore.setState({ scopeKey: null, trackedIds: [], createPending: null, topUpPending: {}, createPendingPersisted: false });
});

describe('ConvictionDetailView §8A owner-gating', () => {
  it('enables owner actions when owner == wallets[0]', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    expect(container.textContent).not.toContain('Owner-only');
    await unmount();
  });

  it('disables owner actions for a non-owner', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: ['0xSomeoneElse0000000000000000000000000000'], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Owner-only');
    expect(btn(container, '[data-testid="pca-topup-btn"]').disabled).toBe(true);
    await unmount();
  });

  it('non-owner: gates top-up, approve, AND renew, while the wallet probe stays enabled (§8A matrix)', async () => {
    // Guards the section split (#1348): the single ownerWritesEnabled gate must
    // reach EVERY owner-write control across FundingSection / PublishingWalletsSection /
    // LifecycleSection — not silently drop on approve or renew — and must NOT gate the probe.
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: ['0xSomeoneElse0000000000000000000000000000'], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Owner-only');
    const byText = (t: string) => Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(t));
    expect(btn(container, '[data-testid="pca-topup-btn"]').disabled).toBe(true);
    expect(btn(container, '[data-testid="pca-renew-btn"]').disabled).toBe(true);
    expect(byText('Approve publishing wallet')?.disabled).toBe(true);
    // The wallet probe is deliberately ungated — available to everyone.
    expect(byText('Probe')?.disabled).toBe(false);
    await unmount();
  });

  it('does not render deferred settlement or context-graph controls', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    expect(container.textContent).not.toContain('Settlement');
    expect(container.textContent).not.toContain('Context-graph binding');
    expect(container.querySelector('[data-testid="pca-settle-btn"]')).toBeNull();
    await unmount();
  });

  // M8 — a probe that returns 200-without-probedKey is "couldn't determine", never
  // a false "NOT approved" (manual probe tool + the per-wallet row).
  it('the manual Probe and the wallet row both say "couldn’t determine" on a probe with no probedKey (M8)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    // The per-wallet probe ROW only exists in the B3-degrade fallback — force it.
    mocks.listPcaAgents.mockRejectedValue(new HttpError(503, 'unavailable', { error: 'unavailable' }));
    mocks.fetchPca.mockImplementation(async () => snap()); // snap() never carries probedKey → registered null
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Check a wallet');
    // Per-wallet row settles to couldn't-determine, not "not approved".
    await waitForText(container, 'couldn’t determine');
    expect(container.textContent).not.toContain('not approved');
    // Manual probe tool agrees.
    setInputValue(container.querySelector('.v10-pca-address-crux input.v10-form-input') as HTMLInputElement, '0x' + '1'.repeat(40));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { findBtn(container, 'Probe').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Couldn’t determine whether');
    await unmount();
  });

  // L3 — a wallets-balances outage must read "can't confirm ownership", not flip
  // to a definitive "this node isn't the owner".
  it('shows "can’t confirm ownership" + Retry (not a false non-owner) when the wallets fetch errors (L3)', async () => {
    mocks.fetchWalletsBalances.mockRejectedValue(new Error('balances down'));
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, "can't confirm ownership");
    expect(container.textContent).not.toContain('isn’t the owner');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(true);
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

  // C6 — owner-mode S3 write interactions: assert each helper fires with the
  // right args + the success feedback renders (the dropped-payload regression
  // class the gating/error-only tests couldn't catch).
  const OWNER_WB = { wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null };

  it('owner Top-up fires pcaTopUp(id, amount) and renders the success result (C6)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaTopUp.mockResolvedValue({ accountId: '7', addedTokens: '100', txHash: '0xabc' });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    setInputValue(container.querySelector('input[aria-label="Top-up amount in TRAC"]') as HTMLInputElement, '100');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { btn(container, '[data-testid="pca-topup-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.pcaTopUp).toHaveBeenCalledWith('7', '100');
    await waitForText(container, 'Added');
    expect(container.querySelector('[data-testid="pca-action-result"]')).toBeTruthy();
    await unmount();
  });

  it('owner deregister confirm fires pcaRemoveAgent(id, wallet) (C6)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '7', agent: W0, deregistered: true });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'approved');
    await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'will pay the direct cost');
    await act(async () => { container.querySelector('[data-testid="pca-deregister-btn"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('7', W0);
    await unmount();
  });

  // W2 — a top-up 504 carrying a broadcast txHash means the tx MAY be on-chain; warn
  // (don't say "try again") so a retry can't lock a SECOND top-up.
  it('W2 — top-up 504 with a txHash warns "may be on-chain", not "try again"', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaTopUp.mockRejectedValue(new HttpError(504, 'TIMEOUT', { code: 'TIMEOUT', txHash: '0xabc' }));
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    setInputValue(container.querySelector('input[aria-label="Top-up amount in TRAC"]') as HTMLInputElement, '100');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { btn(container, '[data-testid="pca-topup-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'may already be on-chain');
    const warn = container.querySelector('[data-testid="pca-action-warning"]')!;
    expect(warn.getAttribute('role')).toBe('alert');
    expect(warn.textContent).toContain('0xabc');
    expect(warn.textContent).toContain('a second top-up would lock additional TRAC');
    expect(container.textContent).not.toContain('temporarily unavailable');
    await unmount();
  });

  it('M9 — pending top-up polls the stored exact hash and does not expose manual clear/retry', async () => {
    const getTransactionReceipt = vi.fn(async ({ hash }: { hash: string }) => {
      expect(hash).toBe('0xpendingtopup');
      return { status: 'success' };
    });
    mocks.publicClientFor.mockReturnValue({ getTransactionReceipt });
    usePcaStore.setState({
      topUpPending: {
        '7': {
          accountId: '7',
          ownerEoa: W0,
          submittedAt: Date.now(),
          txHash: '0xpendingtopup',
          tokens: '100',
          previousTopUpBufferTrac: '12500.0',
        },
      },
    });
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Top-up confirmed on-chain.');
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: '0xpendingtopup' });
    expect(container.textContent).not.toContain('Clear after verifying');
    expect(usePcaStore.getState().topUpPending['7']).toBeUndefined();
    await unmount();
  });

  it('wallet top-up action rejection after approval uses step-aware allowance copy', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockResolvedValue(snap({ owner: CONNECTED_OWNER }));
    mocks.walletTopUp.mockRejectedValue(
      new WalletTxStepError('action', Object.assign(new Error('user rejected'), { code: 4001 })),
    );

    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Connected owner wallet will sign');
    setInputValue(container.querySelector('input[aria-label="Top-up amount in TRAC"]') as HTMLInputElement, '100');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { btn(container, '[data-testid="pca-topup-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'The TRAC allowance is set');
    await unmount();
  });

  it('wallet-owned detail copy asks to switch network before signing when wrong-network disables writes', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 1,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockResolvedValue(snap({ owner: CONNECTED_OWNER }));

    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Owner wallet matches; switch network before signing owner actions.');
    expect(container.textContent).not.toContain('Connected owner wallet will sign');
    expect(btn(container, '[data-testid="pca-topup-btn"]').disabled).toBe(true);
    await unmount();
  });

  it('W2 — top-up 504 with NO txHash stays retryable ("try again"), no warning', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaTopUp.mockRejectedValue(new HttpError(504, 'TIMEOUT', { code: 'TIMEOUT' })); // no txHash
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    setInputValue(container.querySelector('input[aria-label="Top-up amount in TRAC"]') as HTMLInputElement, '100');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { btn(container, '[data-testid="pca-topup-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'temporarily unavailable');
    expect(container.querySelector('[data-testid="pca-action-warning"]')).toBeNull();
    await unmount();
  });

  it('W2 — top-up 400 InvalidAmount keeps the validation copy (no warning)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaTopUp.mockRejectedValue(new HttpError(400, 'InvalidAmount', { error: 'InvalidAmount' }));
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Funding');
    setInputValue(container.querySelector('input[aria-label="Top-up amount in TRAC"]') as HTMLInputElement, '100');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { btn(container, '[data-testid="pca-topup-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'greater than 0');
    expect(container.querySelector('[data-testid="pca-action-warning"]')).toBeNull();
    await unmount();
  });
});

// B3 — the S3 "Publishing wallets" section renders the FULL approved set from
// listPcaAgents (GET /api/pca/:id/agents), retiring P0's count-only caveat, and
// degrades to the probe-only this-node-wallets view when the route is unavailable.
describe('ConvictionDetailView B3 — live approved-wallet table', () => {
  const EXTERNAL = '0xExternal0000000000000000000000000000A1b2';
  const OWNER_WB = { wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null };

  it('renders the FULL approved list (incl. wallets NOT on this node) and retires the count-only caveat', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [W0, EXTERNAL] });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Approved publishing wallets:');
    const rows = container.querySelectorAll('[data-testid="pca-agent-row"]');
    expect(rows.length).toBe(2); // includes the EXTERNAL wallet the node can't probe
    // The node's own wallet is badged; the caveat is gone once the full list renders.
    expect(container.textContent).toContain('approved · this node');
    expect(container.textContent).not.toContain('not the full list');
    await unmount();
  });

  it('shows a real 0-approved empty state (200 + agents: []), still no caveat', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [] });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'No approved publishing wallets yet.');
    expect(container.textContent).not.toContain('not the full list');
    await unmount();
  });

  it('degrades to the probe-only this-node view + count caveat when listPcaAgents fails (503/404)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.listPcaAgents.mockRejectedValue(new HttpError(503, 'unavailable', { error: 'unavailable' }));
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'This node’s wallets:');
    // The P0 caveat is restored as the honest degrade signal.
    expect(container.textContent).toContain('not the full list');
    // The node's own wallet still resolves via the per-row probe (W0 → approved).
    await waitForText(container, 'approved');
    await unmount();
  });

  it('owner Remove on a listed wallet fires pcaRemoveAgent(id, addr) (full-list path)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [W0] });
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '7', agent: W0, deregistered: true });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Approved publishing wallets:');
    await act(async () => { findBtn(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // D (#1357) — W0 is this node's own wallet, so the confirm names that consequence.
    await waitForText(container, 'one of this node’s own signing wallets');
    await act(async () => { container.querySelector('[data-testid="pca-deregister-btn"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('7', W0);
    // D2 (#1357) — the deregister success now renders (was a dead state).
    await waitForText(container, 'Removed');
    expect(container.querySelector('[data-testid="pca-remove-result"]')).toBeTruthy();
    await unmount();
  });

  // A (#1357) — a failed listPcaAgents for the CURRENT account must NOT render a
  // previous account's list. The guard keys the full-list render on agentsData.accountId
  // === accountId; a mismatch (stale) falls through to the probe-only degrade.
  it('A — stale agentsData (different accountId) does NOT render under the new header (degrades)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    // The list resolves for a DIFFERENT account than the one being viewed (#7).
    mocks.listPcaAgents.mockResolvedValue({ accountId: '999', agents: [EXTERNAL] });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    // Falls to the degrade (probe-only this-node view + caveat), NOT the stale list.
    await waitForText(container, 'This node’s wallets:');
    expect(container.textContent).toContain('not the full list'); // degrade caveat
    expect(container.textContent).not.toContain(EXTERNAL.slice(0, 10)); // the stale wallet is NOT shown
    await unmount();
  });

  it('A — stale account snapshot (different accountId) does NOT render owner actions under the route id', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockResolvedValue(snap({ accountId: '999', owner: EXTERNAL }));
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Couldn’t load PCA #7');
    expect(container.textContent).not.toContain(EXTERNAL.slice(0, 10));
    expect(container.querySelector('[data-testid="pca-topup-submit"]')).toBeNull();
    await unmount();
  });
});

// GAP-4/5 — the S3 detail view opts into the EXTENDED snapshot and renders a remaining-
// allowance budget item + a primaryNode readout; both degrade-to-nothing when the
// best-effort extended fields are absent (never a false value). Coverage spine unchanged.
describe('ConvictionDetailView GAP-4/5 — budget widget + primaryNode', () => {
  it('requests the EXTENDED snapshot (so the budget widget has remainingAllowance)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    const { unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    // The primary snapshot fetch (no key) opts in to extended; the per-wallet probes don't.
    expect(mocks.fetchPca).toHaveBeenCalledWith('7', undefined, { extended: true });
    await unmount();
  });

  it('renders remaining-allowance + primaryNode when the extended fields are present', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key
        ? { ...snap(), probedKey: { key, registered: true } }
        : snap({ remainingAllowance: '500000000000000000000', remainingAllowanceTrac: '500.0', currentEpoch: 1290, primaryNode: '42', lastPrimaryNodeChangeEpoch: 1288 }),
    );
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Remaining this epoch');
    expect(container.textContent).toContain('500');
    expect(container.textContent).toContain('Node #42');
    await unmount();
  });

  it('omits the budget widget items when the extended fields are absent (read-failed degrade)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    // default snap() carries no extended fields.
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Top-up buffer');
    expect(container.textContent).not.toContain('Remaining this epoch');
    expect(container.textContent).not.toContain('Primary node');
    await unmount();
  });

  it('primaryNode "0" reads "None set" (vs a real node id)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...snap(), probedKey: { key, registered: true } } : snap({ primaryNode: '0' }),
    );
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'None set');
    expect(container.textContent).not.toContain('Node #');
    await unmount();
  });
});
