// @vitest-environment happy-dom
//
// C2 — ApproveWalletsModal: the per-row outcome mapping (the §5.4 step-5
// invariant that a cross-account 409 is a CONFLICT, never a benign "skipped"),
// and the 403 owner-gate abort. Mocks pcaAddAgent + the follow-up fetchPca probe.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  pcaAddAgent: vi.fn(),
  pcaRemoveAgent: vi.fn(),
  pcaAgentAccount: vi.fn(),
  walletOwnerActionSubmitter: vi.fn(),
  walletRegisterAgent: vi.fn(),
  walletDeregisterAgent: vi.fn(),
  walletTopUp: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    pcaAddAgent: mocks.pcaAddAgent,
    pcaRemoveAgent: mocks.pcaRemoveAgent,
    pcaAgentAccount: mocks.pcaAgentAccount,
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
const { WalletOwnerActionAbortError } = await import('../src/ui/web3/walletOwnerActionSubmitter.js');
const { WalletReceiptWaitError } = await import('../src/ui/web3/walletTxError.js');
const { ApproveWalletsModal } = await import('../src/ui/pages/conviction/ApproveWalletsModal.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');

const DEFAULT_NODE_WALLET = '0xnode1';
const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_C = '0x' + 'c'.repeat(40);
const CONNECTED_OWNER = '0x' + 'd'.repeat(40);
const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};

function snap(over: Record<string, unknown> = {}) {
  return {
    accountId: '7', owner: '0xowner', committedTRAC: '0', committedTRACTrac: '0',
    baseEpochAllowance: '0', topUpBuffer: '0', topUpBufferTrac: '0',
    createdAtEpoch: 1, expiresAtEpoch: 2, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 4, lastSettledWindow: 0, fullySwept: false, ...over,
  };
}
function ownedSnap(owner: string, over: Record<string, unknown> = {}) {
  return snap({ owner, ...over });
}
function daemonSnap(over: Record<string, unknown> = {}) {
  return ownedSnap(DEFAULT_NODE_WALLET, over);
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
  while (Date.now() - started < 2000) {
    last = c.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}
function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  useWalletStore.setState({
    provider: null,
    providerInfo: null,
    address: null,
    chainId: null,
    expectedChainId: null,
    bootstrap: null,
  });
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [DEFAULT_NODE_WALLET], balances: [], chainId: '84532', rpcUrl: null });
  // B1 default: wallets bound to nothing (no self-coverage probe surprises in non-B1 tests).
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
  mocks.walletOwnerActionSubmitter.mockReturnValue({
    create: vi.fn(),
    registerAgent: mocks.walletRegisterAgent,
    deregisterAgent: mocks.walletDeregisterAgent,
    topUp: mocks.walletTopUp,
    settle: vi.fn(),
  });
  mocks.walletRegisterAgent.mockResolvedValue({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true, txHash: '0xwalletreg' });
  mocks.walletDeregisterAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, deregistered: true, txHash: '0xwalletdel' });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ApproveWalletsModal - self defaults', () => {
  it('self mode pre-deselects wallets already approved on this PCA', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [ADDR_A, ADDR_B],
      balances: [],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = daemonSnap({ accountId: id, owner: ADDR_A });
      if (!key) return base;
      return {
        ...base,
        probedKey: { key, registered: key.toLowerCase() === ADDR_A.toLowerCase() },
      };
    });
    mocks.pcaAddAgent.mockResolvedValue({ accountId: '7', agent: ADDR_B, registered: true, adapterSupported: true });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'self', onClose: vi.fn() }),
    );
    await waitForText(container, 'already approved here');
    const checks = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checks).toHaveLength(2);
    expect(checks[0].checked).toBe(false);
    expect(checks[0].disabled).toBe(true);
    expect(checks[1].checked).toBe(true);
    expect((container.querySelector('[data-testid="pca-approve-submit"]') as HTMLButtonElement).textContent).toContain('Approve 1 wallet');

    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'confirmed');
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(1);
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', ADDR_B);
    await unmount();
  });
});

describe('ApproveWalletsModal — per-row mapping', () => {
  it('maps approved / already-here-skip / cross-account-conflict distinctly (conflict ≠ skip)', async () => {
    // Snapshot (no key) → agentCount; probes (with key) → registered iff ADDR_B.
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      if (!key) return daemonSnap();
      return { ...daemonSnap(), probedKey: { key, registered: key.toLowerCase() === ADDR_B.toLowerCase() } };
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) return { accountId: id, agent: addr, registered: true, adapterSupported: true };
      // B + C both already registered somewhere → 409; the probe disambiguates.
      throw new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' });
    });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    const ta = container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement;
    setTextarea(ta, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'conflict');

    const results = container.querySelector('.v10-pca-approve-results')!;
    const rowFor = (addr: string) =>
      Array.from(results.querySelectorAll('.v10-pca-wallet-row')).find(
        (r) => r.getAttribute('aria-label')?.startsWith(addr),
      )!;
    // ADDR_A approved.
    expect(rowFor(ADDR_A).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    // ADDR_B registered HERE → benign skip.
    expect(rowFor(ADDR_B).querySelector('.v10-pca-wallet-status')?.textContent?.toLowerCase()).toContain('skipped');
    // ADDR_C bound ELSEWHERE → conflict, NOT a benign skip (the load-bearing invariant).
    const cStatus = rowFor(ADDR_C).querySelector('.v10-pca-wallet-status')!;
    expect(cStatus.getAttribute('data-tone')).toBe('danger');
    expect(cStatus.textContent?.toLowerCase()).not.toContain('skipped');
    expect(cStatus.textContent?.toLowerCase()).toContain('another pca');
    // Summary tallies the conflict separately.
    expect(results.textContent).toContain('1 conflict');
    await unmount();
  });

  // S2b — the renew chain seeds the bulk paste with the OLD account's agents so
  // re-approving them on the new account is one step.
  it('S2b — seedBulk pre-fills the bulk paste for one-step re-approval', async () => {
    mocks.fetchPca.mockResolvedValue(daemonSnap({ accountId: '8' }));
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', initialMode: 'sponsor', seedBulk: [ADDR_A, ADDR_B].join('\n'), onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    const ta = container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement;
    expect(ta.value).toBe([ADDR_A, ADDR_B].join('\n'));
    await unmount();
  });

  // S2b renew [HIGH] — account EXPIRY does not clear agentToAccountId, so a seeded
  // old-PCA wallet is still bound there. The renew chain must DEREGISTER it from the old
  // account before registering on the new one, else registerAgent reverts AgentAlreadyRegistered.
  it('S2b renew (deregister-first): frees each seeded wallet from the OLD account, then approves on the new', async () => {
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = daemonSnap({ accountId: id });
      return key ? { ...base, probedKey: { key, registered: true } } : base;
    });
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, removed: true });
    mocks.pcaAddAgent.mockResolvedValue({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: ADDR_A, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    // [MEDIUM] — the renew note REPLACES the sponsor-can't-verify warning (these are the
    // node's own carried-over wallets, not a third party).
    expect(container.querySelector('[data-testid="pca-renew-reapprove-note"]')).toBeTruthy();
    expect(container.textContent).not.toContain('can’t verify it’s the node’s real');

    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'approved on-chain');
    // deregister(old) ran BEFORE register(new) for the seeded wallet.
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('4', ADDR_A);
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_A);
    expect(mocks.pcaRemoveAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.pcaAddAgent.mock.invocationCallOrder[0]);
    await unmount();
  });

  it('S2b renew: a failed deregister falls through to the register, whose B10 surfaces the still-bound wallet as a conflict', async () => {
    // deregister(old) fails (e.g. not owner of old / transient); the wallet stays bound,
    // so register(new) reverts AgentAlreadyRegistered → the existing B10 probe → conflict.
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = daemonSnap({ accountId: id });
      return key ? { ...base, probedKey: { key, registered: false } } : base;
    });
    mocks.pcaRemoveAgent.mockRejectedValue(new HttpError(403, 'x', { error: 'NotAccountOwner' }));
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' }));

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: ADDR_A, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'another PCA');
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_A); // register still attempted (recovery path)
    await unmount();
  });

  it('S2b renew: successful old deregister + failed new register shows stranded retry recovery', async () => {
    mocks.fetchPca.mockResolvedValue(daemonSnap({ accountId: '8' }));
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, removed: true });
    mocks.pcaAddAgent.mockRejectedValue(new Error('RPC dropped after deregister'));

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: ADDR_A, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'temporarily UNCOVERED');
    expect(container.querySelector('[data-testid="pca-approve-retry-stranded"]')).toBeTruthy();
    await unmount();
  });

  it('S2b renew: when the old agents could not be loaded, the copy stops promising a pre-fill', async () => {
    mocks.fetchPca.mockResolvedValue(daemonSnap({ accountId: '8' }));
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: '', seedAgentsResolved: false, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'add them manually');
    expect(container.querySelector('[data-testid="pca-renew-reapprove-note"]')?.textContent)
      .toContain('Couldn’t load PCA #4’s wallets');
    await unmount();
  });

  // B1 self-coverage (§9.5) — the post-create self-coverage of THIS node's own wallets:
  // an own-bound wallet is deregistered-first then registered; a sponsor-bound wallet is
  // SKIPPED (already discounted free), never burning a register. The old account VARIES
  // per wallet (unlike renew's single deregisterFrom).
  it('B1 self-coverage: deregisters an own-bound wallet first, skips a sponsor-bound one', async () => {
    const SPONSOR = '0xC0FFEE0000000000000000000000000000000001';
    // Self mode approves the node's own wallets: ADDR_A (owner/daemon EOA) + ADDR_B.
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A, ADDR_B], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockImplementation(async (w: string) =>
      w === ADDR_A ? { agent: w, accountId: '4' } : { agent: w, accountId: '9' },
    );
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (id === '4') return ownedSnap(ADDR_A, { accountId: '4' });   // own-bound → deregister-first
      // sponsor-bound + LIVE (budget + unexpired) → "already discounted free" skip (R1).
      if (id === '9') return ownedSnap(SPONSOR, { accountId: '9', baseEpochAllowance: '1000000000000000000000' });
      const current = ownedSnap(ADDR_A, { accountId: '8' }); // the new account (#8)
      return key ? { ...current, probedKey: { key, registered: false } } : current;
    });
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, removed: true });
    mocks.pcaAddAgent.mockResolvedValue({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'already discounted'); // the sponsor-bound skip copy

    // Own-bound ADDR_A: deregistered from #4 FIRST, then registered on #8.
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('4', ADDR_A);
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_A);
    expect(mocks.pcaRemoveAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.pcaAddAgent.mock.invocationCallOrder[0]);
    // Sponsor-bound ADDR_B: SKIPPED — never registered, never deregistered.
    expect(mocks.pcaAddAgent).not.toHaveBeenCalledWith('8', ADDR_B);
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalledWith('9', ADDR_B);
    await unmount();
  });

  it('B1 self-coverage: connected-wallet-owned previous PCA is moved, not treated as a sponsor', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: ADDR_A, accountId: '4' });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (id === '4') return ownedSnap(CONNECTED_OWNER, { accountId: '4' });
      const current = ownedSnap(CONNECTED_OWNER, { accountId: '8' });
      return key ? { ...current, probedKey: { key, registered: false } } : current;
    });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'approved on-chain');

    expect(mocks.walletDeregisterAgent).toHaveBeenCalledWith('4', ADDR_A);
    expect(mocks.walletRegisterAgent).toHaveBeenCalledWith('8', ADDR_A);
    expect(mocks.walletDeregisterAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.walletRegisterAgent.mock.invocationCallOrder[0]);
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(mocks.pcaAddAgent).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('already discounted');
    await unmount();
  });

  it('wallet-managed approval disables close/Esc dismissal while a device prompt is active', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchPca.mockResolvedValue(ownedSnap(CONNECTED_OWNER, { accountId: '8' }));
    let resolveRegister!: (value: unknown) => void;
    mocks.walletRegisterAgent.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRegister = resolve; }),
    );

    const onClose = vi.fn();
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', initialMode: 'sponsor', seedBulk: ADDR_A, onClose,
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'Confirm on your device');

    expect(container.querySelector('button[aria-label="Close disabled while signing"]')).toBeTruthy();
    expect((container.querySelector('.v10-modal-footer .v10-modal-btn') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await act(async () => { container.querySelector('.v10-modal-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();

    resolveRegister({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true, txHash: '0xwalletreg' });
    await waitForText(container, 'approved on-chain');
    await unmount();
  });

  it('wallet-managed renew progress counts only wallet-signed writes, not daemon deregisters', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchPca.mockImplementation(async (id: string) =>
      id === '4'
        ? daemonSnap({ accountId: '4' })
        : ownedSnap(CONNECTED_OWNER, { accountId: '8' }),
    );
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, removed: true });
    let resolveRegister!: (value: unknown) => void;
    mocks.walletRegisterAgent.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRegister = resolve; }),
    );

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: ADDR_A, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'Confirm on your device (1 of 1)');

    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('4', ADDR_A);
    expect(container.textContent).not.toContain('Confirm on your device (1 of 2)');
    resolveRegister({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true, txHash: '0xwalletreg' });
    await waitForText(container, 'approved on-chain');
    await unmount();
  });

  it('wallet-managed deregister rejection aborts the batch before register prompts', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchPca.mockResolvedValue(ownedSnap(CONNECTED_OWNER, { accountId: '8' }));
    mocks.walletDeregisterAgent.mockRejectedValueOnce(
      new WalletOwnerActionAbortError('Wallet account changed before the signature prompt.'),
    );

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, {
        accountId: '8', deregisterFrom: '4', initialMode: 'sponsor', seedBulk: ADDR_A, onClose: vi.fn(),
      }),
    );
    await waitForText(container, 'Wallet address(es)');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'Wallet account changed before the signature prompt.');
    expect(mocks.walletRegisterAgent).not.toHaveBeenCalled();
    await unmount();
  });

  // R1 (#9) — a wallet on an EXPIRED/swept sponsor PCA must NOT be skipped as "already discounted
  // free": it's uncovered + unfreeable (not the owner) → a distinct conflict, never registered.
  it('R1 — self-coverage: an EXPIRED sponsor binding → conflict (not "already free"), not registered', async () => {
    const SPONSOR = '0xC0FFEE0000000000000000000000000000000001';
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: ADDR_A, accountId: '9' });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) =>
      id === '9'
        ? ownedSnap(SPONSOR, { accountId: '9', expiresAtTimestamp: 1, baseEpochAllowance: '1000000000000000000000' }) // EXPIRED sponsor
        : (key ? { ...ownedSnap(ADDR_A, { accountId: '8' }), probedKey: { key, registered: false } } : ownedSnap(ADDR_A, { accountId: '8' })),
    );
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'expired/swept'); // the R1 dead-sponsor conflict copy
    expect(container.querySelector('.v10-pca-approve-results')?.textContent).not.toContain('already discounted');
    expect(mocks.pcaAddAgent).not.toHaveBeenCalled(); // not registered (can't free a sponsor's PCA)
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled(); // not deregistered (not the owner)
    await unmount();
  });

  // H2 (#9 safety) — selfCoverage logic must NOT run in sponsor mode: a third-party wallet on a
  // PCA this node happens to own must NOT be silently deregistered, and no false "already free" skip.
  it('H2 — selfCoverage does NOT run in sponsor mode (no silent third-party deregister)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [DEFAULT_NODE_WALLET], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: ADDR_A, accountId: '4' }); // ADDR_A bound to a PCA the node owns
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (id === '4') return ownedSnap(DEFAULT_NODE_WALLET, { accountId: '4' }); // node owns #4
      const current = daemonSnap({ accountId: '8' });
      return key ? { ...current, probedKey: { key, registered: false } } : current;
    });
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' }));
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'sponsor', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, ADDR_A);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'another PCA'); // normal sponsor-mode conflict path
    // The gate held: NO silent deregister of the third-party wallet, NO false self-coverage skip.
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(container.querySelector('.v10-pca-approve-results')?.textContent).not.toContain('already discounted');
    await unmount();
  });

  // M5 — hot→cold migration: deregister succeeds then register fails → the wallet is STRANDED
  // (off old, not on new); surfaced loudly with a one-click "Retry to finish" that completes it.
  it('M5 — deregister-then-register-fail strands the wallet; Retry to finish recovers it', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount
      .mockResolvedValueOnce({ agent: ADDR_A, accountId: '4' }) // run 1: own-bound
      .mockResolvedValue({ agent: ADDR_A, accountId: null });   // run 2 (retry): now unbound
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) =>
      id === '4'
        ? ownedSnap(ADDR_A, { accountId: '4' })
        : (key ? { ...ownedSnap(ADDR_A, { accountId: '8' }), probedKey: { key, registered: false } } : ownedSnap(ADDR_A, { accountId: '8' })),
    );
    mocks.pcaRemoveAgent.mockResolvedValue({ accountId: '4', agent: ADDR_A, removed: true });
    mocks.pcaAddAgent
      .mockRejectedValueOnce(new HttpError(500, 'x', { error: 'boom' }))                            // run 1: register FAILS → stranded
      .mockResolvedValue({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true }); // run 2: succeeds
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'temporarily UNCOVERED'); // the stranded banner
    expect(container.querySelector('[data-testid="pca-approve-stranded"]')).toBeTruthy();
    // One-click retry finishes the migration.
    await click(container.querySelector('[data-testid="pca-approve-retry-stranded"]')!);
    await waitForText(container, 'approved on-chain');
    expect(container.querySelector('[data-testid="pca-approve-stranded"]')).toBeNull();
    await unmount();
  });

  // M10 — self-coverage: an UNREADABLE binding (the owner read fails → inconclusive) must NOT be
  // skipped or deregistered; it falls through to registerAgent and the AgentAlreadyRegistered
  // backstop resolves it (#9 — never assert "already free" off an unread probe).
  it('M10 — self-coverage: an inconclusive binding falls through to register (conflict backstop), not skipped', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: ADDR_A, accountId: '9' }); // bound…
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      if (id === '9') throw new Error('rpc'); // …but the owner read FAILS → inconclusive
      const current = ownedSnap(ADDR_A, { accountId: '8' }); // new account #8
      return key ? { ...current, probedKey: { key, registered: false } } : current;
    });
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' }));
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'another PCA'); // register attempted → conflict backstop
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_A); // registered (not skipped)
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled(); // inconclusive → no deregister
    await unmount();
  });

  // M4 — a transient 500/network on a MIDDLE wallet must NOT abort and must NOT
  // tally as a benign skip: that row is a danger-tone failure, the loop continues,
  // and the remaining wallet still gets approved.
  it('continues past a mid-batch 500 (danger failure, never skip) and approves the rest', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...daemonSnap(), probedKey: { key, registered: false } } : daemonSnap(),
    );
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_B) throw new HttpError(500, 'x', { error: 'addPublishingAgent failed: boom' });
      return { accountId: id, agent: addr, registered: true, adapterSupported: true };
    });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);

    await waitForText(container, 'failed');
    // All three attempted — the 500 did NOT abort the batch (contrast: 403).
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(3);

    const results = container.querySelector('.v10-pca-approve-results')!;
    const rowFor = (addr: string) =>
      Array.from(results.querySelectorAll('.v10-pca-wallet-row')).find(
        (r) => r.getAttribute('aria-label')?.startsWith(addr),
      )!;
    expect(rowFor(ADDR_A).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    expect(rowFor(ADDR_C).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    const bStatus = rowFor(ADDR_B).querySelector('.v10-pca-wallet-status')!;
    expect(bStatus.getAttribute('data-tone')).toBe('danger');
    expect(bStatus.textContent?.toLowerCase()).not.toContain('skipped');
    // Tallied as a failure, separate from skip/conflict.
    expect(results.textContent).toContain('1 failed');
    await unmount();
  });

  it('aborts the whole operation on a 403 owner-gate failure', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...daemonSnap(), probedKey: { key, registered: false } } : daemonSnap(),
    );
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(403, 'x', { error: 'NotAccountOwner — daemon EOA is not the PCA owner' }));

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);

    await waitForText(container, "isn’t the owner of PCA #7");
    // Aborted after the FIRST failure — the second wallet was never attempted.
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(1);
    await unmount();
  });

  // N5/#9 — AgentAlreadyRegistered disambiguation must only assert a cross-account
  // CONFLICT (danger) on a POSITIVE not-registered-here probe. A failed probe or an
  // adapter capability gap is "couldn't verify" — neutral, not a false DANGER
  // pointing at the wrong fix (deregister elsewhere).
  async function runAlreadyRegistered(probeImpl: (key?: string) => Promise<unknown>) {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => (key ? probeImpl(key) : daemonSnap()));
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(409, 'x', { error: 'AgentAlreadyRegistered' }));
    const handle = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(handle.container, 'Wallet address(es)');
    setTextarea(handle.container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, ADDR_A);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(handle.container.querySelector('[data-testid="pca-approve-submit"]')!);
    return handle;
  }
  const statusOf = (c: HTMLElement, addr: string) =>
    Array.from(c.querySelectorAll('.v10-pca-wallet-row'))
      .find((r) => r.getAttribute('aria-label')?.startsWith(addr))!
      .querySelector('.v10-pca-wallet-status')!;

  it('AgentAlreadyRegistered + probe FAILS → neutral "unverified", NOT a false conflict', async () => {
    const { container, unmount } = await runAlreadyRegistered(async () => {
      throw new Error('probe down');
    });
    await waitForText(container, 'couldn’t verify');
    const status = statusOf(container, ADDR_A);
    expect(status.getAttribute('data-tone')).toBe('neutral');
    expect(status.textContent?.toLowerCase()).not.toContain('another pca');
    await unmount();
  });

  it('AgentAlreadyRegistered + adapter capability gap → neutral "unverified", NOT a false conflict', async () => {
    const { container, unmount } = await runAlreadyRegistered(async (key) => ({
      ...daemonSnap(),
      probedKey: { key, registered: undefined, adapterSupported: false },
    }));
    await waitForText(container, 'couldn’t verify');
    expect(statusOf(container, ADDR_A).getAttribute('data-tone')).toBe('neutral');
    await unmount();
  });

  // U1 — the raw count > cap must NOT hard-block submit: already-approved-here
  // addresses consume no slot and the FE can't know that pre-probe.
  it('U1 — a near-cap paste with an already-approved address is NOT blocked', async () => {
    // cap = 100 - 99 = 1; paste [already-approved, new] (count 2) must stay submittable.
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      const base = { ...daemonSnap(), agentCount: 99 };
      return key ? { ...base, probedKey: { key, registered: key.toLowerCase() === ADDR_A.toLowerCase() } } : base;
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) throw new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' });
      return { accountId: id, agent: addr, registered: true, adapterSupported: true };
    });
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const submit = container.querySelector('[data-testid="pca-approve-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false); // NOT hard-blocked despite count(2) > cap(1)
    await click(submit);
    await waitForText(container, 'approved');
    expect(statusOf(container, ADDR_A).textContent?.toLowerCase()).toContain('skipped'); // no slot used
    expect(statusOf(container, ADDR_B).textContent).toContain('approved');
    await unmount();
  });

  // U1 — on AgentCapReached the loop breaks; the remaining rows must be marked 'cap',
  // never left stuck on 'pending' ("approving…").
  it('U1 — over-cap all-new: first approved, the rest "cap reached" (no stuck pending)', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      const base = { ...daemonSnap(), agentCount: 99 };
      return key ? { ...base, probedKey: { key, registered: false } } : base;
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) return { accountId: id, agent: addr, registered: true, adapterSupported: true };
      throw new HttpError(400, 'AgentCapReached', { error: 'AgentCapReached' });
    });
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'cap reached');
    expect(statusOf(container, ADDR_A).textContent).toContain('approved');
    expect(statusOf(container, ADDR_B).textContent).toContain('cap reached');
    // ADDR_C was never attempted (loop broke) but must NOT be stuck on "approving…".
    expect(statusOf(container, ADDR_C).textContent).toContain('cap reached');
    expect(container.textContent).not.toContain('approving…');
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(2); // A + B, then break
    await unmount();
  });

  it('marks a broadcast wallet tx with failed receipt polling as submitted, not failed', async () => {
    const txHash = `0x${'12'.repeat(32)}`;
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...ownedSnap(CONNECTED_OWNER), probedKey: { key, registered: false } } : ownedSnap(CONNECTED_OWNER),
    );
    mocks.walletRegisterAgent.mockRejectedValueOnce(
      new WalletReceiptWaitError(txHash, new Error('eth_getBlockByNumber rejected'), 'action'),
    );
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'receipt verification failed');

    expect(statusOf(container, ADDR_A).textContent).toContain('Broadcast; verify on-chain before retrying.');
    expect(statusOf(container, ADDR_A).getAttribute('data-tone')).toBe('neutral');
    expect(statusOf(container, ADDR_B).textContent).toContain('not run - verify the previous transaction first');
    expect(statusOf(container, ADDR_C).textContent).toContain('not run - verify the previous transaction first');
    expect(container.textContent).toContain('1 submitted (verify)');
    expect(container.textContent).not.toContain('failed (of 3)');
    expect(mocks.walletRegisterAgent).toHaveBeenCalledTimes(1);
    await unmount();
  });

  // W1 — a 403 owner-gate break must mark the later rows too (U1 fixed only the cap break).
  it('W1 — 403 on the first row aborts + marks the rest, no stuck "approving…"', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...daemonSnap(), probedKey: { key, registered: false } } : daemonSnap(),
    );
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(403, 'x', { error: 'NotAccountOwner — daemon EOA is not the PCA owner' }));
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, "isn’t the owner of PCA #7");
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(1); // aborted after the first row
    // Later rows are swept (aborted), never left stuck on "approving…".
    expect(container.textContent).not.toContain('approving…');
    expect(statusOf(container, ADDR_B).textContent?.toLowerCase()).toContain('aborted');
    expect(statusOf(container, ADDR_C).textContent?.toLowerCase()).toContain('aborted');
    await unmount();
  });

  // MIXED-OWNER self-coverage (item 3 / #1375 P4) — deregisterSelf frees a wallet from its
  // OWN-bound prevAccount, which can be owned DIFFERENTLY than the target. It must resolve the
  // submitter PER-ACCOUNT (the resolving path), NOT reuse the target's resolve-once access-path
  // submitter. Here the target #8 is DAEMON-owned but ADDR_B's prevAccount #9 is CONNECTED-WALLET
  // -owned: the deregister must route through the WALLET submitter (owner of #9), never the daemon
  // (which would revert NotAccountOwner). Guards the P4 regression the resolve-once refactor risked.
  it('mixed-owner self-coverage: frees a wallet from its wallet-owned prevAccount via the WALLET submitter, while the daemon-owned target registers via the daemon', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    // Target #8 owner == wallets[0] (ADDR_A) → daemon-owned target (access.submitterKind='daemon').
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [ADDR_A, ADDR_B], balances: [], chainId: '84532', rpcUrl: null });
    // ADDR_A unbound (registers directly); ADDR_B bound to #9.
    mocks.pcaAgentAccount.mockImplementation(async (w: string) =>
      w === ADDR_B ? { agent: w, accountId: '9' } : { agent: w, accountId: null },
    );
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      // prevAccount #9 is CONNECTED-WALLET-owned + LIVE → own-bound via the connected wallet.
      if (id === '9') return ownedSnap(CONNECTED_OWNER, { accountId: '9', baseEpochAllowance: '1000000000000000000000' });
      // Target #8 is daemon-owned (owner == wallets[0] == ADDR_A).
      const current = ownedSnap(ADDR_A, { accountId: '8' });
      return key ? { ...current, probedKey: { key, registered: false } } : current;
    });
    mocks.pcaAddAgent.mockResolvedValue({ accountId: '8', agent: ADDR_A, registered: true, adapterSupported: true });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '8', initialMode: 'self', selfCoverage: true, onClose: vi.fn() }),
    );
    await waitForText(container, 'slots used');
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'approved on-chain');

    // THE PIN: ADDR_B is freed from the wallet-owned #9 via the WALLET submitter (resolved for #9),
    // not the daemon-owned target's access-path submitter.
    expect(mocks.walletDeregisterAgent).toHaveBeenCalledWith('9', ADDR_B);
    // The daemon NEVER attempts to deregister from the wallet-owned account (would revert on-chain).
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    // Both wallets register on the daemon-owned target via the daemon submitter.
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_A);
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', ADDR_B);
    // Deregister-from-old precedes register-on-new for the moved wallet.
    const addBIdx = mocks.pcaAddAgent.mock.calls.findIndex((c) => c[1] === ADDR_B);
    expect(mocks.walletDeregisterAgent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.pcaAddAgent.mock.invocationCallOrder[addBIdx]);
    await unmount();
  });
});
