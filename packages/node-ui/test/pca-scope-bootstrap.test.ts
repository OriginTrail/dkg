// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPcaContracts: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    listPcaContracts: mocks.listPcaContracts,
  };
});

const { usePcaScopeBootstrap } = await import('../src/ui/hooks/usePcaScopeBootstrap.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');

const CONTRACTS = {
  chainId: 'gnosis:100',
  nft: '0x1111111111111111111111111111111111111111',
  token: '0x2222222222222222222222222222222222222222',
  rpcUrls: ['/api/pca/rpc'],
};

function Harness() {
  usePcaScopeBootstrap();
  return null;
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  usePcaStore.setState({
    scopeKey: null,
    trackedIds: [],
    createPending: null,
    topUpPending: {},
    createPendingPersisted: false,
  });
  mocks.listPcaContracts.mockResolvedValue(CONTRACTS);
});

describe('usePcaScopeBootstrap', () => {
  it('loads the deployment-scoped PCA store for non-conviction surfaces', async () => {
    localStorage.setItem(
      'dkg-pca:gnosis:100:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222',
      JSON.stringify({ trackedIds: ['4'] }),
    );

    const handle = await render(React.createElement(Harness));
    await act(async () => { await Promise.resolve(); });

    expect(mocks.listPcaContracts).toHaveBeenCalledTimes(1);
    expect(usePcaStore.getState().scopeKey).toBe(
      'gnosis:100:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222',
    );
    expect(usePcaStore.getState().trackedIds).toEqual(['4']);
    await handle.unmount();
  });
});
