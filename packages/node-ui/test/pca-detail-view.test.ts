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
  listPcaAgents: vi.fn(),
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
const { HttpError } = await import('../src/ui/api.js');

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
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
const findBtn = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text)!;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap(), probedKey: { key, registered: key.toLowerCase() === W0.toLowerCase() } } : snap(),
  );
  // B3 — default to the happy full-list path (W0 = this node's wallet, approved).
  mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [W0] });
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

  // M7 — CG-bind goes through the register classifier (not the PCA routes), so it
  // gets its own mapping: 501 → soft "can't verify ownership", 403 → "owner wallet".
  it('maps CG-bind 501 to a soft ownership caveat and 403 to "owner wallet" (M7)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
    mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [{ id: 'cg-1', name: 'CG One', accessPolicy: 'private' }] });
    mocks.registerContextGraph
      .mockRejectedValueOnce(new HttpError(501, 'x', { error: 'not supported' }))
      .mockRejectedValueOnce(new HttpError(403, 'x', { error: 'signer is not the owner' }));

    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Context-graph binding');
    setSelect(container.querySelector('select.v10-form-select') as HTMLSelectElement, 'cg-1');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await act(async () => { findBtn(container, 'Bind context graph').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Couldn’t verify PCA ownership');

    await act(async () => { findBtn(container, 'Bind context graph').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'Bind from the PCA owner wallet');
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
    await waitForText(container, 'can’t confirm ownership');
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

  it('owner Settle fires pcaSettle(id) and renders the success message (C6)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.pcaSettle.mockResolvedValue({ accountId: '7', settled: true, txHash: '0xdef' });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Settlement');
    await act(async () => { btn(container, '[data-testid="pca-settle-btn"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    await waitForText(container, 'Settlement sweep submitted.');
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

  it('owner CG-bind fires registerContextGraph(cg, {pcaAccountId}) and shows the bound message (C6)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [{ id: 'cg-1', name: 'CG One', accessPolicy: 'private' }] });
    mocks.registerContextGraph.mockResolvedValue({ registered: 'cg-1', onChainId: '1', txHash: '0x1' });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Context-graph binding');
    setSelect(container.querySelector('select.v10-form-select') as HTMLSelectElement, 'cg-1');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { findBtn(container, 'Bind context graph').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // The dropped-{pcaAccountId} regression guard + O3 forces curated publishPolicy.
    expect(mocks.registerContextGraph).toHaveBeenCalledWith('cg-1', { pcaAccountId: '7', publishPolicy: 0 });
    await waitForText(container, 'Bound cg-1 to PCA #7.');
    await unmount();
  });

  // O3 (corrects N3) — bindable = UNREGISTERED, any access policy (binding forces
  // curated PUBLISH at registration). A public-read CG is bindable; a registered
  // CG (onChainId set) is excluded.
  it('O3 — bind dropdown lists unregistered CGs of ANY access policy, excludes registered', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.fetchContextGraphs.mockResolvedValue({
      contextGraphs: [
        { id: 'reg-curated', name: 'Registered', onChainId: '5', accessPolicy: 'private' },
        { id: 'open-cg', name: 'Open', accessPolicy: 'public' }, // public-read → still bindable
        { id: 'bindable-cg', name: 'Bindable', accessPolicy: 'private' },
      ],
    });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Context-graph binding');
    const select = container.querySelector('select.v10-form-select') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value).filter(Boolean);
    expect(optionValues).toEqual(['open-cg', 'bindable-cg']); // both unregistered; registered excluded
    await unmount();
  });

  // N3 — a 200 with no txHash = already registered on-chain (idempotent path that
  // drops the new pcaAccountId). Must NOT claim "Bound" (#9 false confirmation).
  it('N3 — bind does NOT claim "Bound" on an already-registered idempotent 200 (no txHash)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(OWNER_WB);
    mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [{ id: 'cg-1', name: 'CG One', accessPolicy: 'private' }] });
    mocks.registerContextGraph.mockResolvedValue({ registered: 'cg-1', onChainId: '7', txHash: undefined });
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Context-graph binding');
    setSelect(container.querySelector('select.v10-form-select') as HTMLSelectElement, 'cg-1');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { findBtn(container, 'Bind context graph').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'already registered on-chain');
    expect(container.textContent).not.toContain('Bound cg-1 to PCA #7');
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
    await waitForText(container, 'will pay the direct cost');
    await act(async () => { container.querySelector('[data-testid="pca-deregister-btn"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('7', W0);
    await unmount();
  });
});
