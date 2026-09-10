// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const mocks = vi.hoisted(() => ({
  fetchOperationalWallets: vi.fn(),
  readIdentityWalletSummary: vi.fn(),
  identityWalletActionSubmitter: vi.fn(),
  publicClientFor: vi.fn(() => ({})),
  addOperational: vi.fn(),
  removeOperational: vi.fn(),
  addAdmin: vi.fn(),
  removeAdmin: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (original) => {
  const actual = await original<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchOperationalWallets: mocks.fetchOperationalWallets };
});

vi.mock('../src/ui/web3/clients.js', async (original) => {
  const actual = await original<typeof import('../src/ui/web3/clients.js')>();
  return { ...actual, publicClientFor: mocks.publicClientFor };
});

vi.mock('../src/ui/web3/identityWalletActions.js', async (original) => {
  const actual = await original<typeof import('../src/ui/web3/identityWalletActions.js')>();
  return {
    ...actual,
    readIdentityWalletSummary: mocks.readIdentityWalletSummary,
    identityWalletActionSubmitter: mocks.identityWalletActionSubmitter,
  };
});

vi.mock('../src/ui/components/Pca/index.js', () => ({
  WalletConnectControl: () => React.createElement('button', null, 'Connect wallet'),
  WalletPill: () => React.createElement('span', null, 'Connected wallet'),
  WalletRow: ({ address, status, trailing }: { address: string; status?: React.ReactNode; trailing?: React.ReactNode }) =>
    React.createElement('div', { 'data-wallet': address }, status, trailing),
}));

const { IdentityWalletsSection } = await import('../src/ui/pages/conviction/IdentityWalletsSection.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');
const { WalletReceiptWaitError } = await import('../src/ui/web3/walletTxError.js');

const ADMIN = `0x${'11'.repeat(20)}` as Address;
const PRIMARY = `0x${'22'.repeat(20)}` as Address;
const OLD_OPERATIONAL = `0x${'33'.repeat(20)}` as Address;
const TARGET = `0x${'44'.repeat(20)}` as Address;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const CONTRACTS = {
  nft: `0x${'55'.repeat(20)}`,
  token: `0x${'66'.repeat(20)}`,
  identityWallets: {
    profile: `0x${'77'.repeat(20)}`,
    identity: `0x${'88'.repeat(20)}`,
    storage: `0x${'99'.repeat(20)}`,
  },
  chainId: 'base:84532',
  rpcUrls: ['/api/pca/rpc'],
};

const operationalSnapshot = {
  identityId: '61',
  hasProfile: true,
  adminKeyConfigured: true,
  canManage: true,
  wallets: [
    { address: PRIMARY, isAdmin: false, isPrimary: true, registered: true },
    { address: OLD_OPERATIONAL, isAdmin: false, isPrimary: false, registered: true },
    { address: ADMIN, isAdmin: true, isPrimary: false, registered: false },
  ],
};

function summary(connectedAdmin = true) {
  return {
    adminCount: connectedAdmin ? 2 : 1,
    operationalCount: 2,
    addresses: [
      { address: ADMIN, admin: connectedAdmin, operational: false },
      { address: PRIMARY, admin: false, operational: true },
      { address: OLD_OPERATIONAL, admin: false, operational: true },
    ],
  };
}

async function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(React.createElement(IdentityWalletsSection, { blockExplorerUrl: 'https://explorer.test' })); });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function waitFor(predicate: () => boolean, label: string) {
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function setInputValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.fetchOperationalWallets.mockResolvedValue(operationalSnapshot);
  mocks.readIdentityWalletSummary.mockResolvedValue(summary());
  const success = (action: string) => async (_identityId: string, address: Address) => ({
    action,
    address,
    txHash: TX_HASH,
    blockNumber: 9,
  });
  mocks.addOperational.mockImplementation(success('add-operational'));
  mocks.removeOperational.mockImplementation(success('remove-operational'));
  mocks.addAdmin.mockImplementation(success('add-admin'));
  mocks.removeAdmin.mockImplementation(success('remove-admin'));
  mocks.identityWalletActionSubmitter.mockReturnValue({
    addOperational: mocks.addOperational,
    removeOperational: mocks.removeOperational,
    addAdmin: mocks.addAdmin,
    removeAdmin: mocks.removeAdmin,
  });
  useWalletStore.setState({
    provider: { request: vi.fn() },
    providerInfo: null,
    address: ADMIN,
    chainId: 84532,
    expectedChainId: 84532,
    bootstrap: CONTRACTS,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('IdentityWalletsSection', () => {
  it('does not crash the PCA page when an older daemon omits the optional wallet list', async () => {
    mocks.fetchOperationalWallets.mockResolvedValue({});
    const { container, unmount } = await renderSection();
    await waitFor(() => mocks.fetchOperationalWallets.mock.calls.length === 1, 'legacy capability response');
    expect(container.textContent).toContain('Node identity wallets');
    expect(container.querySelector('[data-testid="operational-wallet-editor"]')).toBeTruthy();
    await unmount();
  });

  it('gates every write when the connected wallet is not an authorized admin', async () => {
    mocks.readIdentityWalletSummary.mockResolvedValue(summary(false));
    const { container, unmount } = await renderSection();
    await waitFor(() => container.textContent?.includes('not an admin for this identity') === true, 'authorization result');
    await act(async () => setInputValue(container.querySelector('#identity-admin-address')!, TARGET));
    expect((container.querySelector('[data-testid="add-admin"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector(`[data-testid="remove-operational-${OLD_OPERATIONAL}"]`) as HTMLButtonElement).disabled).toBe(true);
    await unmount();
  });

  it('requires confirmation and routes a known-wallet removal to removeOperational', async () => {
    const { container, unmount } = await renderSection();
    await waitFor(() => container.textContent?.includes('authorized admin signer') === true, 'authorized state');
    await click(container.querySelector(`[data-testid="remove-operational-${OLD_OPERATIONAL}"]`)!);
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(OLD_OPERATIONAL);
    expect(mocks.removeOperational).not.toHaveBeenCalled();
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Yes, remove')!);
    await waitFor(() => mocks.removeOperational.mock.calls.length === 1, 'operational removal');
    expect(mocks.removeOperational).toHaveBeenCalledWith('61', OLD_OPERATIONAL, PRIMARY);
    await unmount();
  });

  it('routes role-editor additions through the matching identity action', async () => {
    const { container, unmount } = await renderSection();
    await waitFor(() => container.textContent?.includes('authorized admin signer') === true, 'authorized state');
    await act(async () => setInputValue(container.querySelector('#identity-admin-address')!, TARGET));
    await click(container.querySelector('[data-testid="add-admin"]')!);
    await waitFor(() => mocks.addAdmin.mock.calls.length === 1, 'admin add');
    expect(mocks.addAdmin).toHaveBeenCalledWith('61', TARGET);

    await act(async () => setInputValue(container.querySelector('#identity-operational-address')!, TARGET));
    await click(container.querySelector('[data-testid="add-operational"]')!);
    await waitFor(() => mocks.addOperational.mock.calls.length === 1, 'operational add');
    expect(mocks.addOperational).toHaveBeenCalledWith('61', TARGET);
    await unmount();
  });

  it('refreshes both the daemon wallet list and chain roles after success', async () => {
    const { container, unmount } = await renderSection();
    await waitFor(() => mocks.readIdentityWalletSummary.mock.calls.length === 1, 'initial summary');
    await act(async () => setInputValue(container.querySelector('#identity-admin-address')!, TARGET));
    await click(container.querySelector('[data-testid="add-admin"]')!);
    await waitFor(
      () => mocks.fetchOperationalWallets.mock.calls.length >= 2 && mocks.readIdentityWalletSummary.mock.calls.length >= 2,
      'post-success refresh',
    );
    expect(container.querySelector('[data-testid="identity-wallet-result"]')?.textContent).toContain('Admin wallet registered');
    await unmount();
  });

  it('keeps the broadcast hash visible when receipt confirmation is unknown', async () => {
    mocks.addAdmin.mockRejectedValue(new WalletReceiptWaitError(TX_HASH, new Error('timeout'), 'action'));
    const { container, unmount } = await renderSection();
    await waitFor(() => container.textContent?.includes('authorized admin signer') === true, 'authorized state');
    await act(async () => setInputValue(container.querySelector('#identity-admin-address')!, TARGET));
    await click(container.querySelector('[data-testid="add-admin"]')!);
    await waitFor(() => container.textContent?.includes('confirmation is unknown') === true, 'uncertain receipt result');
    const result = container.querySelector('[data-testid="identity-wallet-result"]')!;
    expect(result.textContent).toContain(TARGET);
    expect(result.querySelector('a')?.href).toContain(TX_HASH);
    await unmount();
  });

  it('shows the wrong-network state and keeps writes disabled', async () => {
    useWalletStore.setState({ chainId: 1 });
    const { container, unmount } = await renderSection();
    await waitFor(() => container.textContent?.includes("Switch the connected wallet to this node's network") === true, 'network warning');
    await act(async () => setInputValue(container.querySelector('#identity-operational-address')!, TARGET));
    expect((container.querySelector('[data-testid="add-operational"]') as HTMLButtonElement).disabled).toBe(true);
    await unmount();
  });
});
