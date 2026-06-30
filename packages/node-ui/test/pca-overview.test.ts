// @vitest-environment happy-dom
//
// B1/B2 — the conviction tab root (503 deployment gate) + S1 overview discovery.
// Mocks only the two PCA fetchers on api.js (keeping HttpError +
// isPcaFeatureUnavailable real) and drives the tracked-id store directly.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  pcaAgentAccount: vi.fn(),
  fetchMyPcas: vi.fn(),
  listPcaContracts: vi.fn(),
  publicClientFor: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchPca: mocks.fetchPca,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    pcaAgentAccount: mocks.pcaAgentAccount,
    fetchMyPcas: mocks.fetchMyPcas,
    listPcaContracts: mocks.listPcaContracts,
  };
});

vi.mock('../src/ui/web3/clients.js', () => ({
  publicClientFor: mocks.publicClientFor,
}));

const { HttpError } = await import('../src/ui/api.js');
const { PublishingConvictionPage } = await import('../src/ui/pages/PublishingConviction.js');
const { ConvictionOverview } = await import('../src/ui/pages/conviction/ConvictionOverview.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');
const { useWalletStore, _resetWalletModuleStateForTesting } = await import('../src/ui/stores/wallet.js');
const { _resetDiscoveryForTesting } = await import('../src/ui/web3/eip6963.js');

const WALLET0 = '0x9A3f000000000000000000000000000000000E41D';
const HW = '0xCdA7000000000000000000000000000000001F9B';
const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};
const PCA_SCOPE = 'base:84532:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222';

function snapFixture(id: string) {
  return {
    accountId: id,
    owner: WALLET0,
    committedTRAC: '100000000000000000000000',
    committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000',
    topUpBuffer: '12500000000000000000000',
    topUpBufferTrac: '12500.0',
    createdAtEpoch: 1200,
    expiresAtEpoch: 1560,
    createdAtTimestamp: 1000,
    expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000,
    agentCount: 4,
    lastSettledWindow: 0,
    fullySwept: false,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 1500) {
    last = container.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  _resetWalletModuleStateForTesting();
  _resetDiscoveryForTesting();
  usePcaStore.setState({ scopeKey: null, trackedIds: [], createPending: null, topUpPending: {}, createPendingPersisted: false });
  usePcaStore.getState().setScope(PCA_SCOPE);
  useAgentsStore.getState().setNodeStatus({ nodeRole: 'core', blockExplorerUrl: null });
  useWalletStore.setState({
    discovered: [],
    unsupported: [],
    provider: null,
    providerInfo: null,
    address: null,
    chainId: null,
    expectedChainId: null,
    bootstrap: null,
  });
  // GAP-1 discovery defaults: nothing discovered (deterministic; no real fetch). Tests
  // that exercise the discovered strip / auto-track override these.
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [],
    balances: [],
    chainId: '84532',
    rpcUrl: null,
  });
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
  mocks.fetchMyPcas.mockResolvedValue({ accounts: [] });
  mocks.listPcaContracts.mockResolvedValue(CONTRACTS);
  mocks.publicClientFor.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (
      functionName === 'balanceOf' ? 0n : 0n
    )),
  });
});
afterEach(() => {
  document.body.innerHTML = '';
  _resetWalletModuleStateForTesting();
  _resetDiscoveryForTesting();
});

describe('PublishingConvictionPage — deployment (503) gate', () => {
  it('shows the full-tab Deployment-Unavailable state on a 503', async () => {
    mocks.fetchPca.mockRejectedValue(new HttpError(503));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, "Publisher conviction isn't available");
    // e2e anchors: the full-tab unavailable state + its Recheck control.
    expect(container.querySelector('[data-testid="pca-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-recheck-btn"]')).toBeTruthy();
    // The overview title must NOT render under the gate.
    expect(container.textContent).not.toContain('Role: ◆');
    await unmount();
  });

  it('renders the overview when the capability probe succeeds (non-503)', async () => {
    mocks.fetchPca.mockResolvedValue(snapFixture('0'));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, 'Publisher Conviction');
    expect(container.querySelector('[data-testid="pca-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    await unmount();
  });

  // Q4 — Recheck re-probes (the availability nonce increments) and clears the 503
  // gate once the capability probe recovers.
  it('Recheck re-probes and clears the 503 gate on recovery', async () => {
    mocks.fetchPca.mockRejectedValueOnce(new HttpError(503)).mockResolvedValue(snapFixture('0'));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, "Publisher conviction isn't available");
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeTruthy();

    await act(async () => {
      container.querySelector('[data-testid="pca-recheck-btn"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(container, 'Publisher Conviction');
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeNull();
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    await unmount();
  });

  // V1 — only a CAPABILITY 503 gates the tab. A 404 (no such account) and a transient
  // transport 503 (RPC_* code) are NOT capability gaps → the landing renders.
  it('a 404 capability probe renders the landing, not the unavailable gate', async () => {
    mocks.fetchPca.mockRejectedValue(new HttpError(404));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, 'Publisher Conviction');
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeNull();
    await unmount();
  });

  it('a transient transport 503 (RPC_*) renders the landing, not the unavailable gate', async () => {
    mocks.fetchPca.mockRejectedValue(new HttpError(503, 'x', { code: 'RPC_ENDPOINTS_EXHAUSTED' }));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, 'Publisher Conviction');
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeNull();
    await unmount();
  });

  it('a CAPABILITY 503 (FEATURE_UNAVAILABLE) DOES gate the tab', async () => {
    mocks.fetchPca.mockRejectedValue(new HttpError(503, 'x', { error: 'FEATURE_UNAVAILABLE' }));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, "Publisher conviction isn't available");
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeTruthy();
    await unmount();
  });
});

describe('ConvictionOverview — S1 discovery', () => {
  it('renders the sequential coverage, approved, and owned sections', async () => {
    // No tracked ids -> usePcaOverview resolves to [] without any fetch.
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, "This node's publishing wallet coverage");
    expect(container.querySelector('[data-testid="pca-owned-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-tracked-external-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-tracked-external-section"]')?.textContent).toContain('Track PCA by ID');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    await unmount();
  });

  it('manual track-by-id shows progress while the chain read is pending', async () => {
    let resolveFetch!: (value: ReturnType<typeof snapFixture>) => void;
    mocks.fetchPca.mockImplementation(async (id: string) => new Promise((resolve) => {
      resolveFetch = (value) => resolve(value);
    }));
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'Track PCA by ID');
    const tracked = container.querySelector('[data-testid="pca-tracked-external-section"]')!;
    expect(tracked.textContent).toContain('Track PCA by ID');
    expect(container.querySelector('[data-testid="pca-approved-section"]')?.textContent ?? '').not.toContain('Track PCA by ID');

    await act(async () => {
      (container.querySelector('[data-testid="pca-track-toggle"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = container.querySelector('[data-testid="pca-track-input"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '88');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="pca-track-submit"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForText(container, 'Checking PCA #88');
    await act(async () => {
      resolveFetch(snapFixture('88'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await unmount();
  });

  it('discovers untracked PCAs owned by the connected wallet via ERC721Enumerable', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 1n;
      if (functionName === 'tokenOfOwnerByIndex') return 12n;
      throw new Error(`unexpected ${functionName}`);
    });
    mocks.publicClientFor.mockReturnValue({ readContract });
    mocks.fetchPca.mockImplementation(async (id: string) => ({
      ...snapFixture(id),
      owner: HW,
    }));
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: null,
      address: HW as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'wallet-managed');
    const card = container.querySelector('[data-testid="pca-account-card"][data-owner-mode="wallet"]');
    expect(card?.textContent).toContain('PCA #12');
    expect(container.querySelector('[data-testid="pca-discovered-strip"]')).toBeNull();
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: CONTRACTS.nft,
      functionName: 'balanceOf',
      args: [HW],
    }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: CONTRACTS.nft,
      functionName: 'tokenOfOwnerByIndex',
      args: [HW, 0n],
    }));
    await unmount();
  });

  it('edge empty state shows the warning-tone no-discount banner', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'No PCA discount is active for this node yet');
    await unmount();
  });

  // Sub-PR 1 (§5.6/§5.1) — edge can now create: Get-added stays primary, Create is
  // an available SECONDARY CTA alongside it (no longer edge-gated).
  it('edge S1 offers Create alongside the (primary) Get-sponsored CTA', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'Get added to a PCA');
    const createBtn = container.querySelector('[data-testid="pca-create-btn"]') as HTMLButtonElement;
    expect(createBtn).toBeTruthy();
    expect(createBtn.textContent).toContain('Create PCA');
    // Get-added stays the PRIMARY-styled action; Create is the secondary.
    expect(createBtn.className).not.toContain('primary');
    await unmount();
  });

  it('classifies a tracked account the node owns under "Owned by me"', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [WALLET0],
      balances: [],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = snapFixture(id);
      if (key) return { ...base, probedKey: { key, registered: key.toLowerCase() === WALLET0.toLowerCase() } };
      return base;
    });

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'PCA #7');
    const card = container.querySelector('[data-state="owned"]');
    expect(card).toBeTruthy();
    // owner == wallets[0] AND that wallet probes registered → covered → no #11 warning.
    expect(container.textContent).not.toContain('discounts nothing yet');
    await unmount();
  });

  // O2 — the role-default filter must auto-react to async status (a useState
  // initializer runs once, so an edge node whose status resolved after mount
  // stayed stuck on "Owned" and hid its sponsorships); explicit picks stick.
  it('renders approved coverage and owned sections together after async role resolves', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    useAgentsStore.setState({ nodeStatus: null }); // status not loaded yet -> role undefined
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    const PCA_OWNER = '0xSOMEONEELSE0000000000000000000000000000';
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = { ...snapFixture(id), owner: PCA_OWNER }; // not owned by this node -> approved coverage
      if (key) return { ...base, probedKey: { key, registered: key.toLowerCase() === WALLET0.toLowerCase() } };
      return base;
    });

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await act(async () => {
      useAgentsStore.setState({ nodeStatus: { nodeRole: 'edge', blockExplorerUrl: null } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitForText(container, 'PCA #7');
    expect(container.querySelector('[data-testid="pca-approved-section"]')?.textContent).toContain('PCA #7');
    expect(container.querySelector('[data-testid="pca-owned-section"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    await unmount();
  });

  // GAP-1 — an OWNED PCA the node hasn't locally tracked surfaces in the "discovered,
  // not tracked" strip with a [Track] action (owned does NOT auto-track).
  it('GAP-1 — surfaces an owned, untracked PCA in the discovered strip with a Track action', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchMyPcas.mockResolvedValue({
      accounts: [{ accountId: '42', relation: 'owned', discountBps: 2000, committedTRACTrac: '50000.0', expiresAtTimestamp: 9_999_999_999, agentCount: 0 }],
    });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'PCA #42');
    const strip = container.querySelector('[data-testid="pca-discovered-strip"]') as HTMLElement;
    expect(strip.textContent).toContain('PCA #42');
    expect(strip.textContent).toContain('you own this account');
    // 🟢/#9 — an OWNED-only account (no wallet approved) doesn't realize the discount, so
    // the strip must NOT show "20%" there (it would read as a false "you'd get this %").
    expect(strip.textContent).not.toContain('20%');
    await act(async () => {
      (strip.querySelector('[data-testid="pca-discovered-track"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(usePcaStore.getState().trackedIds).toContain('42');
    await unmount();
  });

  // GAP-1 ★ AUTO-TRACK — a CONFIRMED agent-on discovery auto-adds to the tracked set
  // (the pure-edge self-heal), so it does NOT linger in the strip.
  it('GAP-1 — auto-tracks a confirmed agent-on PCA (edge self-heal), not left in the strip', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: WALLET0, accountId: '9' });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = { ...snapFixture(id), owner: '0xother0000000000000000000000000000000000' };
      return key ? { ...base, probedKey: { key, registered: true } } : base;
    });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    const started = Date.now();
    while (Date.now() - started < 1000 && !usePcaStore.getState().trackedIds.includes('9')) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    expect(usePcaStore.getState().trackedIds).toContain('9'); // auto-tracked
    expect(container.querySelector('[data-testid="pca-discovered-strip"]')).toBeNull(); // → not in the strip
    await unmount();
  });

  // GAP-1/#9 — a RETRYABLE /mine failure (503 PCA_LOOKUP_READ_FAILED) must NOT collapse
  // to "you own none": the strip offers a retry, and a re-probe recovers.
  it('GAP-1 — a retryable /mine read-fail shows a retry affordance, not a false "no PCAs"', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchMyPcas
      .mockRejectedValueOnce(new HttpError(503, 'read failed', { code: 'PCA_LOOKUP_READ_FAILED' }))
      .mockResolvedValue({ accounts: [{ accountId: '42', relation: 'owned', discountBps: 2000 }] });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    const err = (await (async () => {
      const started = Date.now();
      while (Date.now() - started < 1500) {
        const e = container.querySelector('[data-testid="pca-discovered-error"]');
        if (e) return e as HTMLElement;
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      }
      return null;
    })());
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain("Couldn't verify this node's Publisher Conviction Accounts");
    // It did NOT assert the owned-empty state off the read failure.
    expect(container.querySelector('[data-testid="pca-discovered-strip"]')).toBeNull();
    // Retry → the second (successful) probe surfaces the owned PCA in the strip.
    await act(async () => {
      (err!.querySelector('button') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(container, 'PCA #42');
    expect(container.querySelector('[data-testid="pca-discovered-error"]')).toBeNull();
    await unmount();
  });

  it('GAP-1 — an agent-on lookup failure shows retry, not a definitive edge no-discount banner', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.pcaAgentAccount.mockRejectedValue(new Error('agent lookup down'));
    mocks.fetchPca.mockResolvedValue(snapFixture('7'));
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, "Couldn't verify this node's Publisher Conviction Accounts");
    expect(container.textContent).not.toContain('No PCA discount is active for this node yet');
    expect(container.querySelector('[data-testid="pca-discovered-error"]')).toBeTruthy();
    await unmount();
  });

  it('GAP-1 — a wallet-list failure shows retry, not a definitive edge no-discount banner', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    mocks.fetchWalletsBalances.mockRejectedValue(new Error('wallet list down'));
    mocks.fetchPca.mockResolvedValue(snapFixture('7'));
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, "Couldn't verify this node's Publisher Conviction Accounts");
    expect(container.textContent).not.toContain('No PCA discount is active for this node yet');
    expect(container.querySelector('[data-testid="pca-discovered-error"]')).toBeTruthy();
    await unmount();
  });

  it('GAP-1 — a wallet-list error body shows retry, not a definitive edge no-discount banner', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [],
      balances: [],
      chainId: '84532',
      rpcUrl: null,
      error: 'wallet list unavailable',
    });
    mocks.fetchPca.mockResolvedValue(snapFixture('7'));
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, "Couldn't verify this node's Publisher Conviction Accounts");
    expect(container.textContent).not.toContain('No PCA discount is active for this node yet');
    expect(container.querySelector('[data-testid="pca-discovered-error"]')).toBeTruthy();
    await unmount();
  });

  it('GAP-1 — a CAPABILITY 503 on /mine stays silent (no retry banner, no strip)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    mocks.fetchMyPcas.mockRejectedValue(new HttpError(503, 'x', { error: 'FEATURE_UNAVAILABLE' }));
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'Publisher Conviction'); // overview rendered
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.querySelector('[data-testid="pca-discovered-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="pca-discovered-strip"]')).toBeNull();
    await unmount();
  });
});
