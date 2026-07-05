// @vitest-environment happy-dom
//
// useWalletBootstrap fail-closed coverage (#1446 review). The detail view's
// wallet layer bootstraps PCA contracts on mount; if that read fails, the hook
// must STILL initialize the wallet (so provider/network discovery isn't stuck)
// while leaving `bootstrap` unset so owner writes fail closed through the
// owner-action resolver. Prior tests only covered the successful path.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listPcaContracts: vi.fn() }));
vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, listPcaContracts: mocks.listPcaContracts };
});

const { useWalletBootstrap } = await import('../src/ui/hooks/useWalletBootstrap.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');

const CONTRACTS = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};

function Harness() {
  useWalletBootstrap();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let setBootstrap: ReturnType<typeof vi.fn>;
let initWallet: ReturnType<typeof vi.fn>;
let setScope: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  setBootstrap = vi.fn();
  initWallet = vi.fn();
  setScope = vi.fn();
  // Override the store actions the hook consumes with spies (shallow-merged).
  useWalletStore.setState({ setBootstrap, initWallet } as any);
  usePcaStore.setState({ setScope } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderAndSettle() {
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  // Flush the listPcaContracts then/catch + finally chain.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('useWalletBootstrap', () => {
  it('fail-closed: a listPcaContracts rejection still runs initWallet but leaves bootstrap unset', async () => {
    mocks.listPcaContracts.mockRejectedValue(new Error('contracts read failed'));
    await renderAndSettle();
    expect(initWallet).toHaveBeenCalledTimes(1); // wallet init still runs (finally)
    expect(setBootstrap).not.toHaveBeenCalled(); // bootstrap stays unset -> owner writes fail closed
    expect(setScope).not.toHaveBeenCalled();
  });

  it('success: sets the PCA scope + wallet bootstrap, then inits the wallet', async () => {
    mocks.listPcaContracts.mockResolvedValue(CONTRACTS);
    await renderAndSettle();
    expect(setScope).toHaveBeenCalledTimes(1);
    expect(setBootstrap).toHaveBeenCalledWith(CONTRACTS);
    expect(initWallet).toHaveBeenCalledTimes(1);
  });
});
