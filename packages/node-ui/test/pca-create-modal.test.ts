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
  pcaAgentAccount: vi.fn(),
  listDesignatableNodes: vi.fn(),
  walletOwnerActionSubmitter: vi.fn(),
  walletCreate: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    createPca: mocks.createPca,
    fetchPca: mocks.fetchPca,
    pcaAgentAccount: mocks.pcaAgentAccount,
    listDesignatableNodes: mocks.listDesignatableNodes,
  };
});

vi.mock('../src/ui/web3/walletOwnerActionSubmitter.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/web3/walletOwnerActionSubmitter.js')>();
  return {
    ...actual,
    walletOwnerActionSubmitter: mocks.walletOwnerActionSubmitter,
  };
});

const { HttpError } = await import('../src/ui/api.js');
const { WalletReceiptWaitError } = await import('../src/ui/web3/walletTxError.js');
const { CreatePcaModal } = await import('../src/ui/pages/conviction/CreatePcaModal.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');

const OWNER = '0x9A3f000000000000000000000000000000000E41D';
const HARDWARE_OWNER = '0x' + 'd'.repeat(40);
const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};
const PCA_SCOPE = 'base:84532:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222';

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

// Test-isolation guard: every network path in this suite goes through the mocked
// api.js fetchers, so the real global `fetch` must NEVER fire. happy-dom's fetch
// will attempt a real connection to the page origin (:3000) if a path slips
// through — and under a loaded parallel runner that surfaced as cross-worker
// ECONNREFUSED flakes. We pin `fetch` to a throwing stub per test (restored
// after) so no worker ordering can leak a real request, and assert it stayed
// untouched. (`vi.clearAllMocks` keeps the impl; only call history is reset.)
const fetchGuard = vi.fn(async () => {
  throw new Error('pca-create-modal: unexpected real fetch() — a network path is not mocked');
});

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchGuard);
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
  useAgentsStore.getState().setNodeStatus({ nodeRole: 'core', hasIdentity: true, identityId: '42', blockExplorerUrl: null });
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [OWNER],
    balances: [{ address: OWNER, eth: '1', trac: '200000', symbol: 'TRAC' }],
    chainId: '84532', rpcUrl: null,
  });
  // B1 default: the wallet is bound to nothing → no zero-coverage warning (and no real fetch).
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
  // §3b picker list: this node's identity (#42) is staked → core pre-selects it (M3).
  mocks.listDesignatableNodes.mockResolvedValue({
    nodes: [{ nodeId: 'peerA', identityId: '42', stake: '1000000000000000000000', ask: '0' }],
    total: 1, nextStart: null,
  });
  mocks.walletOwnerActionSubmitter.mockReturnValue({
    create: mocks.walletCreate,
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    topUp: vi.fn(),
    settle: vi.fn(),
  });
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

type CreateModalProps = React.ComponentProps<typeof CreatePcaModal>;
function createModalProps(overrides: Partial<CreateModalProps> = {}): CreateModalProps {
  return {
    onClose: vi.fn(),
    onApproveOwnWallets: vi.fn(),
    onManage: vi.fn(),
    onGetSponsored: vi.fn(),
    initialOwnerKey: 'hot',
    ...overrides,
  };
}
function hardwareModalProps(overrides: Partial<CreateModalProps> = {}): CreateModalProps {
  return createModalProps({ initialOwnerKey: 'hardware', ...overrides });
}

describe('CreatePcaModal', () => {
  // Sub-PR 1 (§5.2 Step 1) — the edge/no-identity HARD GATE is REMOVED: the wizard opens
  // for all; a no-own-identity node gets a NON-BLOCKING explainer, not a cross-flow CTA.
  it('edge / no-identity: the wizard OPENS (no hard gate) with a non-blocking notice', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', hasIdentity: false });
    const onGetSponsored = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored }),
    );
    await waitForText(container, 'Commit amount (TRAC)'); // the form opens — no gate
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeTruthy();
    // Non-blocking explainer, without an inline get-added CTA inside the create flow.
    expect(container.querySelector('[data-testid="pca-create-no-identity-note"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-create-get-sponsored-link"]')).toBeNull();
    expect(onGetSponsored).not.toHaveBeenCalled();
    await unmount();
  });

  it('defaults the owner key to hardware wallet', async () => {
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn() }),
    );
    await waitForText(container, 'Owner key');
    expect((container.querySelector('input[value="hardware"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('input[value="hot"]') as HTMLInputElement).checked).toBe(false);
    await unmount();
  });

  it('creates, reads back the real discount, tracks the id, and leads with the #11 self-coverage card', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '7', txHash: '0xabc', committedTokens: '100000.0' });
    mocks.fetchPca.mockResolvedValue(snap({ discountBps: 3000 }));
    const onApproveOwn = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: onApproveOwn, onManage: vi.fn(), initialOwnerKey: 'hot' }),
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

  it('blocks create before submit when the create-pending marker cannot be persisted', async () => {
    const storageSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    mocks.createPca.mockResolvedValue({ accountId: '7', txHash: '0xabc', committedTokens: '100000.0' });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'cannot save the create-pending safety marker');
    expect(mocks.createPca).not.toHaveBeenCalled();
    expect(usePcaStore.getState().createPending).toBeNull();
    storageSpy.mockRestore();
    await unmount();
  });

  it('hardware create shows step-true device progress and suppresses dismissal while signing', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: HARDWARE_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.walletOwnerActionSubmitter.mockImplementationOnce((deps: any) => ({
      create: vi.fn(() => {
        deps.onProgress?.({ step: 'approve', state: 'active' });
        return new Promise(() => {});
      }),
      registerAgent: vi.fn(),
      deregisterAgent: vi.fn(),
      topUp: vi.fn(),
      settle: vi.fn(),
    }));

    const onClose = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, hardwareModalProps({ onClose })),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    await click(container.querySelector('input[value="hardware"]')!);
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'Confirm on your device (1 of 2): approve TRAC');
    const rows = Array.from(container.querySelectorAll('.v10-pca-device-progress-row'));
    expect(rows[0]?.getAttribute('data-state')).toBe('active');
    expect(rows[1]?.getAttribute('data-state')).toBe('pending');
    expect(container.querySelector('button[aria-label="Close disabled while signing"]')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await act(async () => { container.querySelector('.v10-modal-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const footerCancel = container.querySelector('.v10-modal-footer .v10-modal-btn') as HTMLButtonElement;
    expect(footerCancel.disabled).toBe(true);
    await click(footerCancel);
    expect(onClose).not.toHaveBeenCalled();
    await unmount();
  });

  // B1 (§9.5) — every op wallet already on a sponsor's PCA → a loud informed-consent warning
  // before the TRAC commit; NOT a hard block (a node may create purely to sponsor others).
  it('B1 — all wallets sponsor-bound shows the zero-self-coverage warning but NEVER blocks Create (H3)', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: OWNER, accountId: '5' });
    // id '5' = the sponsor's PCA (binding owner read) — LIVE (budget + unexpired) so it reads as
    // "already discounted free" (R1); any other id = the create read-back snapshot.
    mocks.fetchPca.mockImplementation(async (id: string) =>
      id === '5'
        ? snap({ accountId: '5', owner: '0xSPONSOR000000000000000000000000000beEf12', baseEpochAllowance: '1000000000000000000000' })
        : snap({ discountBps: 3000 }),
    );
    mocks.createPca.mockResolvedValue({ accountId: '8', txHash: '0xabc', committedTokens: '100000.0' });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'approve publishing wallets for other nodes'); // the zero-coverage warning copy
    expect(container.querySelector('[data-testid="pca-b1-zero-coverage"]')).toBeTruthy();
    // Enter a valid amount (node #42 is pre-selected) — informed consent, NOT a gate.
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const submit = container.querySelector('[data-testid="pca-create-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false); // create proceeds despite zero-self-coverage
    await click(submit);
    await waitForText(container, 'PCA #8 created');
    expect(mocks.createPca).toHaveBeenCalled();
    await unmount();
  });

  // Escape closes the OPEN picker popup first, not the whole Create modal: the picker stops
  // the event while its listbox is open (so committed state isn't discarded), and a second
  // Escape — popup now closed — dismisses the modal. The shared dismiss hook stays generic.
  it('Escape with the picker open closes the popup, does NOT dismiss the modal', async () => {
    const onClose = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps({ onClose })),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '50000');
    const search = container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    // React (root delegation) maps onFocus to the native bubbling `focusin`.
    await act(async () => { search.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(container.querySelector('[role="listbox"]')).toBeTruthy(); // popup open
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // Popup closed; modal NOT dismissed; the committed amount survives.
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect((container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement).value).toBe('50000');
    // A second Escape (popup now closed) DOES dismiss the modal.
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
    await unmount();
  });

  // M3 — own-bound migration is disclosed even when no wallet is sponsor-bound.
  it('M3 — own-bound-only wallets get a MOVE disclosure (no sponsor-bound preview needed)', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: OWNER, accountId: '3' });
    // id '3' = a PCA THIS node owns (owner == OWNER) → own-bound; else = read-back snapshot.
    mocks.fetchPca.mockImplementation(async (id: string) =>
      id === '3' ? snap({ accountId: '3', owner: OWNER }) : snap({ discountBps: 3000 }),
    );
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'already approved on a PCA you own');
    expect(container.querySelector('[data-testid="pca-b1-own-bound"]')).toBeTruthy();
    // Not the zero-coverage alarm (the wallet IS self-coverable via migration).
    expect(container.querySelector('[data-testid="pca-b1-zero-coverage"]')).toBeNull();
    await unmount();
  });

  // §3b/M3 — core pre-selects its OWN staked node only when its identity is in the list.
  it('§3b/M3 — core pre-selects its own staked node when its identity is in the list', async () => {
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'node #42');
    expect(container.querySelector('[data-testid="pca-primary-node-selected"]')?.textContent).toContain('✓ this node');
    await unmount();
  });

  it('§3b/M3 — own identity NOT in the staked list → no default; primary node required (submit blocked)', async () => {
    mocks.listDesignatableNodes.mockResolvedValue({
      nodes: [{ nodeId: 'pX', identityId: '99', stake: '5000000000000000000', ask: '0' }], total: 1, nextStart: null,
    });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // #42 isn't staked → no pre-selection → the required primary node blocks submit.
    expect(container.querySelector('[data-testid="pca-primary-node-selected"]')).toBeNull();
    expect((container.querySelector('[data-testid="pca-create-submit"]') as HTMLButtonElement).disabled).toBe(true);
    await unmount();
  });

  it('Q1 — list-down: core best-effort defaults to its own id; the picker shows a retry', async () => {
    mocks.listDesignatableNodes.mockRejectedValue(new HttpError(503, 'x', { code: 'SHARDING_TABLE_READ_FAILED' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Couldn’t load the staked-node list');
    expect(container.querySelector('[data-testid="pca-primary-node-error"]')).toBeTruthy();
    // The create-time PrimaryNodeNotInShardingTable revert is the backstop; core still defaults
    // to its own id (#42) so the Review reflects it (Q1).
    expect(container.textContent).toContain('#42');
    await unmount();
  });

  // M4/M9 — a PrimaryNodeNotInShardingTable revert is RECOVERABLE: return to the form AND refetch
  // the staked list with the cache-bust (fresh=1), so the just-unstaked node isn't re-served stale.
  it('M4/M9 — PrimaryNodeNotInShardingTable revert returns to the form + refetches the list FRESH', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(400, 'PrimaryNodeNotInShardingTable', { error: 'PrimaryNodeNotInShardingTable' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    // Poll until the recovery refetch fires (the create-error handler calls refreshNodes → fresh).
    const started = Date.now();
    while (Date.now() - started < 1500 && !mocks.listDesignatableNodes.mock.calls.some((c) => c[0]?.fresh)) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    expect(mocks.listDesignatableNodes).toHaveBeenCalledWith(expect.objectContaining({ fresh: true }));
    // Recoverable, not terminal — still on the form (the amount field is present).
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeTruthy();
    await unmount();
  });

  // R2 — the rejection handler clears the rejected node IMMEDIATELY (it does NOT wait for the fresh
  // refetch): with the refetch held pending, submit is already disabled, the chip is gone, and a 2nd
  // click can't re-submit the rejected id. Then the fresh list (without #42) resolves → still cleared.
  it('R2 — rejection clears the rejected node before the fresh refetch resolves; a 2nd click cannot re-submit', async () => {
    let resolveFresh!: (v: { nodes: any[]; total: number }) => void;
    const freshPending = new Promise<{ nodes: any[]; total: number }>((res) => { resolveFresh = res; });
    mocks.listDesignatableNodes
      .mockResolvedValueOnce({ nodes: [{ nodeId: 'p42', identityId: '42', stake: '1000000000000000000000', ask: '0' }], total: 1 })
      .mockReturnValueOnce(freshPending); // the fresh:true refetch stays PENDING
    mocks.createPca.mockRejectedValue(new HttpError(400, 'PrimaryNodeNotInShardingTable', { error: 'PrimaryNodeNotInShardingTable' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'node #42'); // #42 pre-selected from the initial list
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const submit = () => container.querySelector('[data-testid="pca-create-submit"]') as HTMLButtonElement;
    await click(submit()!);
    // Wait until the create rejects and the catch dispatches the fresh refetch (which stays pending).
    const started = Date.now();
    while (Date.now() - started < 1500 && !mocks.listDesignatableNodes.mock.calls.some((c) => c[0]?.fresh)) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // BEFORE the fresh list resolves: back on the form, #42 already cleared (not re-defaulted off the
    // stale list), submit disabled.
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeTruthy(); // recoverable — on the form
    expect(container.querySelector('[data-testid="pca-primary-node-selected"]')).toBeNull();
    expect(submit().disabled).toBe(true);

    // A 2nd click while the fresh list is still loading cannot re-submit the rejected id.
    const callsAfterReject = mocks.createPca.mock.calls.length;
    await click(submit());
    expect(mocks.createPca.mock.calls.length).toBe(callsAfterReject);

    // The fresh list resolves WITHOUT #42 → still cleared, submit still disabled.
    await act(async () => {
      resolveFresh({ nodes: [{ nodeId: 'p99', identityId: '99', stake: '1000000000000000000000', ask: '0' }], total: 1 });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(submit().disabled).toBe(true);
    expect(container.querySelector('[data-testid="pca-primary-node-selected"]')).toBeNull();
    await unmount();
  });

  // A successful but EMPTY staked list is authoritative: a 503 → list-down own-default (#42) that a
  // retry can't find in the (empty) table must be CLEARED, not kept (else Create enables on a node
  // that isn't designatable).
  it('a retry returning an EMPTY staked list clears the list-down own-default (submit disabled)', async () => {
    mocks.listDesignatableNodes
      .mockRejectedValueOnce(new Error('SHARDING_TABLE_READ_FAILED')) // initial load fails → list-down
      .mockResolvedValue({ nodes: [], total: 0 }); // retry succeeds but the table is empty
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    // List down → core best-effort defaults to its own id (#42) → submit ENABLED, retry shown.
    await waitForText(container, 'Using node #42');
    const submit = () => container.querySelector('[data-testid="pca-create-submit"]') as HTMLButtonElement;
    expect(submit().disabled).toBe(false);

    // Retry → the table comes back EMPTY → #42 isn't designatable → the default is cleared.
    await click(container.querySelector('[data-testid="pca-primary-node-retry"]')!);
    const started = Date.now();
    while (Date.now() - started < 1500 && !mocks.listDesignatableNodes.mock.calls.some((c) => c[0]?.fresh)) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(submit().disabled).toBe(true);
    await unmount();
  });

  // Phase gating — the reconcile / status-unknown / success screens must NOT start the form's reads
  // (sharding-table + wallet-binding probe); only the live form does.
  it('does NOT start designatable-node or wallet-binding reads in the reconcile phase', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: { ownerEoa: OWNER, submittedAt: Date.now() } });
    const { unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(mocks.listDesignatableNodes).not.toHaveBeenCalled();
    expect(mocks.pcaAgentAccount).not.toHaveBeenCalled();
    await unmount();
  });

  it('does NOT start designatable-node or wallet-binding reads while node status is unknown', async () => {
    useAgentsStore.setState({ nodeStatus: null } as any);
    const { unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(mocks.listDesignatableNodes).not.toHaveBeenCalled();
    expect(mocks.pcaAgentAccount).not.toHaveBeenCalled();
    await unmount();
  });

  it('DOES start those reads on the live form (gating control)', async () => {
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mocks.listDesignatableNodes).toHaveBeenCalled();
    expect(mocks.pcaAgentAccount).toHaveBeenCalled();
    await unmount();
  });

  // R9 — edge-create integration: an edge node picks a staked node and creates with that primaryNode.
  it('R9 — edge node picks a staked node via the picker and creates with primaryNode', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', hasIdentity: false, blockExplorerUrl: null });
    mocks.listDesignatableNodes.mockResolvedValue({
      nodes: [{ nodeId: 'p99', identityId: '99', stake: '5000000000000000000000', ask: '0' }], total: 1,
    });
    mocks.createPca.mockResolvedValue({ accountId: '8', txHash: '0xabc', committedTokens: '100000.0' });
    mocks.fetchPca.mockResolvedValue(snap({ accountId: '8', discountBps: 3000 }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)'); // edge opens the wizard (no gate)
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    // Edge has no own-node default → pick #99 via the picker (open + select the option).
    const search = container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    await act(async () => { search.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    const opt = container.querySelector('[data-testid="pca-primary-node-option"]') as HTMLElement;
    await act(async () => { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    await waitForText(container, 'PCA #8 created');
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '100000', primaryNode: '99' });
    await unmount();
  });

  // M8 — a FAILED create must never fire the self-coverage hand-off (onApproveOwnWallets); the
  // self-coverage modal (with its deregister-first loop) only follows a CONFIRMED mint.
  it('M8 — a failed create never opens self-coverage (onApproveOwnWallets not called)', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(400, 'InvalidAmount', { error: 'InvalidAmount' }));
    const onApproveOwn = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps({ onApproveOwnWallets: onApproveOwn })),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    const started = Date.now();
    while (Date.now() - started < 1000 && mocks.createPca.mock.calls.length === 0) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); // let the rejection settle
    expect(mocks.createPca).toHaveBeenCalled();
    expect(onApproveOwn).not.toHaveBeenCalled();
    await unmount();
  });

  // S2b renew [MEDIUM] — on the renew path the success action re-approves the OLD account's
  // wallets (not a fresh "this node's wallets"), so the button is relabelled.
  it('S2b renew: relabels the success action to re-approve the OLD account’s wallets', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '8', txHash: '0xabc', committedTokens: '100000.0' });
    mocks.fetchPca.mockResolvedValue(snap({ accountId: '8', discountBps: 3000 }));
    const onApproveOwn = vi.fn();
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, {
        ...createModalProps({ onApproveOwnWallets: onApproveOwn }),
        seed: { tokens: '100000.0', primaryNode: '99' }, replacingAccountId: '4',
      }),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    await waitForText(container, 'PCA #8 created');
    const btn = container.querySelector('[data-testid="pca-approve-own-wallets"]')!;
    expect(btn.textContent).toContain('Re-approve PCA #4’s wallets');
    await click(btn);
    expect(onApproveOwn).toHaveBeenCalledWith('8');
    await unmount();
  });

  // S2b renew [LOW] — when the old account's primary node couldn't be read, the field
  // falls back to THIS node; surface that rather than silently defaulting.
  it('S2b renew: flags a fall-back to this node when the old primary node couldn’t be read', async () => {
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, {
        ...createModalProps(),
        seed: { tokens: '100000.0', primaryNodeUnknown: true }, replacingAccountId: '4',
      }),
    );
    await waitForText(container, 'Couldn’t read PCA #4’s primary node');
    expect(container.querySelector('[data-testid="pca-renew-primary-unknown"]')).toBeTruthy();
    await unmount();
  });

  // S2b — renew re-mints a REPLACEMENT: the modal is seeded from the expiring account
  // and the copy is HONEST (#9) — a new separate account, the old TRAC stays locked.
  it('S2b renew — seeds the amount/primary node + shows honest "new separate account" copy', async () => {
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, {
        ...createModalProps(),
        seed: { tokens: '100000.0', primaryNode: '42' },
        replacingAccountId: '7',
      }),
    );
    await waitForText(container, 'Renew');
    // Title names the renew (not the generic create).
    expect(container.querySelector('#pca-modal-title')?.textContent).toContain('Renew');
    // Honest #9 framing: new SEPARATE account, names the replaced id, 0/100 approvals.
    const note = container.querySelector('[data-testid="pca-renew-note"]')!;
    expect(note.textContent).toContain('new, separate');
    expect(note.textContent).toContain('#7');
    expect(note.textContent).toContain('0/100');
    // Commit amount is seeded from the expiring account.
    expect((container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement).value).toBe('100000.0');
    // Primary node is seeded into the picker (shown as the selected node).
    await waitForText(container, 'node #42');
    expect(container.querySelector('[data-testid="pca-primary-node-selected"]')?.textContent).toContain('node #42');
    await unmount();
  });

  it('enters reconcile-before-retry on a 504 TIMEOUT and persists the create-pending marker', async () => {
    mocks.createPca.mockRejectedValue(new HttpError(504, 'TIMEOUT', { code: 'TIMEOUT', txHash: '0xdead' }));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
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

  it('hardware create keeps the double-mint guard when post-broadcast mint parsing fails', async () => {
    const txHash = `0x${'e'.repeat(64)}`;
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: HARDWARE_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.walletCreate.mockRejectedValue(
      new WalletReceiptWaitError(txHash, new Error('No PCA mint Transfer found in the create receipt'), 'action'),
    );
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, hardwareModalProps()),
    );
    await waitForText(container, 'Commit amount (TRAC)');
    await click(container.querySelector('input[value="hardware"]')!);
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);

    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain(txHash);
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeNull();
    const marker = usePcaStore.getState().createPending;
    expect(marker?.ownerEoa).toBe(HARDWARE_OWNER);
    expect(marker?.txHash).toBe(txHash);
    await unmount();
  });

  it('fails toward reconcile on a non-HttpError NETWORK drop after submit (may have broadcast)', async () => {
    mocks.createPca.mockRejectedValue(new Error('Failed to fetch'));
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
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
      React.createElement(CreatePcaModal, createModalProps()),
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
      React.createElement(CreatePcaModal, createModalProps()),
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
      React.createElement(CreatePcaModal, createModalProps()),
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
      React.createElement(CreatePcaModal, createModalProps()),
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
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('0xbeef');
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeNull();
    await unmount();
  });

  // T3 — the reconcile screen must not falsely claim the marker "survives a refresh"
  // when storage was blocked (persistNow returned false).
  it('T3 — reconcile shows "survives a refresh" when the marker was persisted', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: { ownerEoa: OWNER, submittedAt: 1 }, createPendingPersisted: true });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('survives a refresh');
    expect(container.textContent).not.toContain('blocked saving the safety marker');
    await unmount();
  });

  it('T3 — reconcile warns LOUDLY when the marker was NOT persisted (storage blocked)', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: { ownerEoa: OWNER, submittedAt: 1 }, createPendingPersisted: false });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('blocked saving the safety marker');
    expect(container.textContent).not.toContain('so this guard survives a refresh');
    await unmount();
  });

  // S1 — the create gate must fail CLOSED while node status is unknown (loading/failed):
  // no live form/submit, no create, no marker — a financial mutation can't run on
  // unknown eligibility.
  it('S1 — null status fails CLOSED: checking state, no submit, no create, no marker', async () => {
    useAgentsStore.setState({ nodeStatus: null });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Checking node eligibility');
    expect(container.querySelector('[data-testid="pca-create-submit"]')).toBeNull();
    expect(container.querySelector('[data-testid="pca-create-tokens"]')).toBeNull();
    expect(mocks.createPca).not.toHaveBeenCalled();
    expect(usePcaStore.getState().createPending).toBeNull();
    await unmount();
  });

  // S1/R1 — a durable create-pending marker must still surface on a null-status reload
  // (reconcile wins over the checking state).
  it('S1 — a create-pending marker surfaces reconcile even while status is unknown', async () => {
    useAgentsStore.setState({ nodeStatus: null });
    usePcaStore.setState({ trackedIds: [], createPending: { ownerEoa: OWNER, submittedAt: 1, txHash: '0xbeef' } });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Confirm before retrying');
    expect(container.textContent).toContain('0xbeef');
    await unmount();
  });

  it('S1 — delayed status: checking (no live form) while unknown, then edge resolves → wizard opens', async () => {
    useAgentsStore.setState({ nodeStatus: null });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, { onClose: vi.fn(), onApproveOwnWallets: vi.fn(), onManage: vi.fn(), onGetSponsored: vi.fn() }),
    );
    await waitForText(container, 'Checking node eligibility');
    // Fail-closed while unknown — no live submit.
    expect(container.querySelector('[data-testid="pca-create-submit"]')).toBeNull();
    await act(async () => {
      useAgentsStore.setState({ nodeStatus: { nodeRole: 'edge', hasIdentity: false } });
      await new Promise((r) => setTimeout(r, 0));
    });
    // Edge now OPENS the wizard (no gate) — form + the non-blocking explainer.
    await waitForText(container, 'Commit amount (TRAC)');
    expect(container.querySelector('[data-testid="pca-create-no-identity-note"]')).toBeTruthy();
    await unmount();
  });

  // Over-correction regression guard: a resolved CORE node must enable the form + create.
  it('S1 — delayed status → core enables the form and allows create', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '7', txHash: '0xabc', committedTokens: '100000.0' });
    mocks.fetchPca.mockResolvedValue(snap({ discountBps: 3000 }));
    useAgentsStore.setState({ nodeStatus: null });
    const { container, unmount } = await render(
      React.createElement(CreatePcaModal, createModalProps()),
    );
    await waitForText(container, 'Checking node eligibility');
    await act(async () => {
      useAgentsStore.setState({ nodeStatus: { nodeRole: 'core', hasIdentity: true, identityId: '42', blockExplorerUrl: null } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitForText(container, 'Commit amount (TRAC)');
    setInputValue(container.querySelector('[data-testid="pca-create-tokens"]') as HTMLInputElement, '100000');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-create-submit"]')!);
    await waitForText(container, 'PCA #7 created');
    expect(mocks.createPca).toHaveBeenCalled();
    await unmount();
  });
});
