// @vitest-environment happy-dom
//
// C1 — CreatePcaModal: the self-coverage success (#11), the double-mint reconcile
// guard (504 TIMEOUT), and the edge/no-identity gate. Mocks the PCA fetchers on
// api.js (HttpError/describePcaError stay real) and drives the stores directly.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  createPca: vi.fn(),
  fetchPca: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    createPca: mocks.createPca,
    fetchPca: mocks.fetchPca,
  };
});

const { HttpError } = await import('../src/ui/api.js');
const { CreatePcaModal } = await import('../src/ui/pages/conviction/CreatePcaModal.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const OWNER = '0x9A3f000000000000000000000000000000000E41D';

function snap(over: Record<string, unknown> = {}) {
  return {
    accountId: '7', owner: OWNER, committedTRAC: '0', committedTRACTrac: '100000.0',
    baseEpochAllowance: '0', topUpBuffer: '0', topUpBufferTrac: '0',
    createdAtEpoch: 1, expiresAtEpoch: 2, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 0, lastSettledWindow: 0, fullySwept: false, ...over,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now();
  let last = '';
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
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  usePcaStore.setState({ trackedIds: [], createPending: null });
  useAgentsStore.getState().setNodeStatus({ nodeRole: 'core', hasIdentity: true, identityId: '42', blockExplorerUrl: null });
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [OWNER],
    balances: [{ address: OWNER, eth: '1', trac: '200000', symbol: 'TRAC' }],
    chainId: '84532', rpcUrl: null,
  });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('CreatePcaModal', () => {
  it('gates edge / no-identity nodes: reason-titled, no form, + a Get-sponsored CTA → S6', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', hasIdentity: false });
    const onGetSponsored = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored }),
    );
    await waitForText(container, 'requires a staked core-node identity');
    // #4 — titled with the reason, not the generic "Create a PCA".
    expect(container.querySelector('#pca-modal-title')?.textContent).toContain('staked core-node identity');
    // #1 — zero wizard fields in the gated state.
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeNull();
    // #2 — a primary Get-sponsored CTA routes to S6.
    const cta = container.querySelector('[data-testid="pca-gated-get-sponsored"]')!;
    expect(cta).toBeTruthy();
    await act(async () => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onGetSponsored).toHaveBeenCalled();
    await unmount();
  });

  it('creates, reads back the real discount, tracks the id, and leads with the #11 self-coverage card', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '7', txHash: '0xabc', committedTokens: '100000.0' });
    mocks.fetchPca.mockResolvedValue(snap({ discountBps: 3000 }));
    const onApproveOwn = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: onApproveOwn, onManage: vi.fn() }),
    );
    // Let wallet fetch + primary-node prefill settle.
    await waitForText(container, 'Commit amount (TRAC)');
    const tokens = container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement;
    setInputValue(tokens, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    await waitForText(container, 'PCA #7 created');

    const success = container.querySelector('[data-testid="pca-create-success"]')!;
    expect(success.textContent).toContain('0/100 wallets approved'); // #11 literal (QA anchor)
    expect(success.textContent).toContain('discounts nothing yet');
    expect(success.textContent).toContain('30%'); // verified discountBps readback
    // Id persisted to the tracked set.
    expect(usePcaStore.getState().trackedIds).toContain('7');
    // The primary success action opens self-approval.
    await click(container.querySelector('[data-testid="pca-approve-own-wallets"]')!);
    expect(onApproveOwn).toHaveBeenCalledWith('7');
    await unmount();
  });

  it('enters reconcile-before-retry on a 504 TIMEOUT and persists the create-pending marker', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(504, 'TIMEOUT', { code: 'TIMEOUT', txHash: '0xdead' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('0xdead');
    expect(container.textContent).toContain('create-pending');
    // Durable marker persisted (survives reload → resumes reconcile).
    const marker = usePcaStore.getState().createPending;
    expect(marker?.ownerEoa).toBe(OWNER);
    expect(marker?.txHash).toBe('0xdead');
    // No bare Retry — only the explicit "no PCA minted, clear & retry".
    expect(container.textContent).toContain('No PCA minted');
    await unmount();
  });

  it('fails toward reconcile on a non-HttpError NETWORK drop after submit (may have broadcast)', async () => {
    mocks.createPca.mockRejectedValue(new Error('Failed to fetch'));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'Confirm before retrying');
    // Submit-time marker kept (no txHash on a raw network drop).
    expect(usePcaStore.getState().createPending?.ownerEoa).toBe(OWNER);
    await unmount();
  });

  it('fails toward reconcile on a 500 after submit', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(500, 'x', { error: 'createPublishingConvictionAccount failed: boom' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'Confirm before retrying');
    expect(usePcaStore.getState().createPending?.ownerEoa).toBe(OWNER);
    await unmount();
  });

  it('clears the marker and returns to the form on a 400 (definitely pre-broadcast)', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(400, 'InvalidAmount', { error: 'InvalidAmount' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'greater than 0'); // describePcaError InvalidAmount copy on the form
    // Pre-broadcast → marker cleared, form is retryable.
    expect(usePcaStore.getState().createPending).toBeNull();
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeTruthy();
    await unmount();
  });

  // H1 — the 503 capability-vs-transport WIRING is the highest-stakes branch
  // (clear-vs-reconcile on the double-mint path) and was the one flavor untested.
  it('fails toward reconcile on a TRANSPORT 503 (RPC_*) after submit and KEEPS the marker', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    // A transient RPC 503 is ambiguous (tx may have broadcast) → reconcile, marker kept.
    await waitForText(container, 'Confirm before retrying');
    expect(usePcaStore.getState().createPending?.ownerEoa).toBe(OWNER);
    await unmount();
  });

  it('clears the marker and returns to the form on a CAPABILITY 503 (FEATURE_UNAVAILABLE, pre-broadcast)', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(503, 'x', { error: 'FEATURE_UNAVAILABLE' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    // A capability 503 (no RPC_* code) is definitely pre-broadcast → clear + form.
    await waitForText(container, 'available on this network');
    expect(usePcaStore.getState().createPending).toBeNull();
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeTruthy();
    await unmount();
  });

  it('resumes the reconcile guard when opened with an existing create-pending marker', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: { ownerEoa: OWNER, submittedAt: 1, txHash: '0xbeef' } });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('0xbeef');
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeNull();
    await unmount();
  });
});
