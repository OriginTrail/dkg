// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { WalletConnectControl } from '../src/ui/components/Wallet/WalletConnectControl.js';
import { PcaWalletConnectControl } from '../src/ui/components/Pca/PcaWalletConnectControl.js';
import { WalletConnectControl as PcaSurfaceWalletConnectControl } from '../src/ui/components/Pca/index.js';
import { useWalletStore } from '../src/ui/stores/wallet.js';

describe('feature-owned wallet connection guidance', () => {
  beforeEach(() => {
    useWalletStore.setState({ address: null, discovered: [], unsupported: [] });
  });

  it('keeps the shared identity-wallet surface free of PCA publishing language', () => {
    const html = renderToStaticMarkup(React.createElement(WalletConnectControl));
    expect(html).toContain('Verify every transaction on the signing device');
    expect(html).not.toContain('Publishing wallets sign automatically');
    expect(html).not.toContain('per-epoch allowance');
  });

  it('renders PCA publishing guidance only through the PCA wrapper', () => {
    // Render through the PCA barrel, not the leaf module: the barrel alias is the
    // one line that routes every PCA surface to the PCA copy, so a revert of it
    // must fail this test.
    expect(PcaSurfaceWalletConnectControl).toBe(PcaWalletConnectControl);
    const html = renderToStaticMarkup(React.createElement(PcaSurfaceWalletConnectControl));
    expect(html).toContain('Publishing wallets sign automatically');
    expect(html).toContain('allowance, plus any top-up balance');
  });

  it.each([
    ['disconnected', null, '[data-testid="wallet-connect"]'],
    ['connected', '0x1111111111111111111111111111111111111111', '.v10-wallet-pill'],
  ] as const)('puts `leading` controls on its own action row when %s, with the notes below it', async (_state, address, control) => {
    // Mount in a live DOM: server rendering reads the store's initial (disconnected) snapshot.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useWalletStore.setState({ address });
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(React.createElement(WalletConnectControl, { leading: React.createElement('input', { 'data-testid': 'lead' }) }));
      });
      const row = host.querySelector('.v10-wallet-connect > .v10-wallet-connect-row')!;
      expect(row).toBeTruthy();
      expect(row.children).toHaveLength(2);
      expect(row.firstElementChild?.getAttribute('data-testid')).toBe('lead');
      // The wallet's own control for this state sits beside the leading control.
      expect(row.lastElementChild?.matches(control) || row.lastElementChild?.querySelector(control)).toBeTruthy();
      expect(row.querySelector('.v10-wallet-note')).toBeNull();
      expect(host.querySelectorAll('.v10-wallet-connect > .v10-wallet-note').length).toBeGreaterThan(0);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });

  it('keeps its plain layout without `leading`', () => {
    const html = renderToStaticMarkup(React.createElement(WalletConnectControl));
    expect(html).not.toContain('v10-wallet-connect-row');
  });
});
