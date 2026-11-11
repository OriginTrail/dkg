// @vitest-environment happy-dom
//
// TfO — ConvictionOverview wiring: the create-success hand-off must open ApproveWalletsModal in
// SELF-COVERAGE mode ({ accountId, initialMode:'self', selfCoverage:true }) so the post-mint loop
// runs the per-wallet deregister-first/skip plan. Mocks the two child modals to capture props, so
// dropping the `selfCoverage` flag (or the mode) fails this test.

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

let approveProps: any = null;
vi.mock('../src/ui/pages/conviction/CreatePcaModal.js', () => ({
  CreatePcaModal: (props: any) =>
    React.createElement(
      'button',
      { 'data-testid': 'mock-create-approve-own', onClick: () => props.onApproveOwnWallets('8') },
      'approve own',
    ),
}));
vi.mock('../src/ui/pages/conviction/ApproveWalletsModal.js', () => ({
  ApproveWalletsModal: (props: any) => {
    approveProps = props;
    return React.createElement(
      'div',
      { 'data-testid': 'mock-approve' },
      `id=${props.accountId} mode=${props.initialMode} self=${String(props.selfCoverage)}`,
    );
  },
}));

const { ConvictionOverview } = await import('../src/ui/pages/conviction/ConvictionOverview.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');

const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};
const CONNECTED_OWNER = `0x${'33'.repeat(20)}`;

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if ((c.textContent ?? '').includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${c.textContent}"`);
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  approveProps = null;
  usePcaStore.setState({ trackedIds: [], createPending: null });
  useWalletStore.setState({
    provider: null,
    providerInfo: null,
    address: null,
    chainId: null,
    expectedChainId: null,
    bootstrap: null,
  });
  useAgentsStore.getState().setNodeStatus({ nodeRole: 'core', blockExplorerUrl: null });
  mocks.fetchPca.mockResolvedValue({ accountId: '0', owner: '0xowner' });
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [], balances: [], chainId: '84532', rpcUrl: null });
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
  mocks.fetchMyPcas.mockResolvedValue({ accounts: [] });
  mocks.listPcaContracts.mockResolvedValue(CONTRACTS);
  mocks.publicClientFor.mockReturnValue({
    readContract: vi.fn(async () => 0n),
  });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ConvictionOverview — create→self-coverage wiring', () => {
  it('the create-success hand-off opens ApproveWalletsModal with selfCoverage=true (self mode)', async () => {
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'Publisher Conviction');
    // Open Create (core), then fire the mint's "approve own wallets" hand-off.
    await click(container.querySelector('[data-testid="pca-create-btn"]')!);
    await click(container.querySelector('[data-testid="mock-create-approve-own"]')!);
    await waitForText(container, 'id=8');
    expect(approveProps).toMatchObject({ accountId: '8', initialMode: 'self', selfCoverage: true });
    await unmount();
  });

  it('renders connected-wallet ERC721 discoveries as wallet-managed owned cards, not strip rows', async () => {
    useWalletStore.setState({
      provider: { request: vi.fn() } as any,
      providerInfo: { uuid: 'mock', name: 'Mock Wallet', icon: 'data:,', rdns: 'mock.wallet' },
      address: CONNECTED_OWNER as `0x${string}`,
      chainId: 84532,
      expectedChainId: 84532,
      bootstrap: CONTRACTS,
    });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [`0x${'44'.repeat(20)}`], balances: [], chainId: '84532', rpcUrl: null });
    mocks.publicClientFor.mockReturnValue({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return 1n;
        if (functionName === 'tokenOfOwnerByIndex') return 7n;
        return 0n;
      }),
    });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => ({
      accountId: id,
      owner: CONNECTED_OWNER,
      committedTRAC: '0',
      committedTRACTrac: '50000.0',
      baseEpochAllowance: '1',
      topUpBuffer: '0',
      topUpBufferTrac: '0',
      createdAtEpoch: 1,
      expiresAtEpoch: 2,
      createdAtTimestamp: 1,
      expiresAtTimestamp: 9_999_999_999,
      discountBps: 500,
      agentCount: 0,
      lastSettledWindow: 0,
      fullySwept: false,
      ...(key ? { probedKey: { key, registered: false, adapterSupported: true } } : {}),
    }));

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'wallet-managed');

    const card = container.querySelector('[data-testid="pca-account-card"][data-owner-mode="wallet"]');
    expect(card?.textContent).toContain('PCA #7');
    expect(container.querySelector('[data-testid="pca-discovered-strip"]')).toBeNull();
    await unmount();
  });
});
