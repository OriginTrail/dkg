// @vitest-environment happy-dom
import React from 'react';
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
    ['disconnected', null],
    ['connected', '0x1111111111111111111111111111111111111111'],
  ] as const)('puts `leading` controls on its own action row when %s, with the notes below it', (_state, address) => {
    useWalletStore.setState({ address });
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(React.createElement(WalletConnectControl, {
      leading: React.createElement('input', { 'data-testid': 'lead' }),
    }));
    const row = div.querySelector('.v10-wallet-connect > .v10-wallet-connect-row')!;
    expect(row).toBeTruthy();
    expect(row.firstElementChild?.getAttribute('data-testid')).toBe('lead');
    expect(row.children).toHaveLength(2);
    expect(row.querySelector('.v10-wallet-note')).toBeNull();
    expect(div.querySelectorAll('.v10-wallet-connect > .v10-wallet-note').length).toBeGreaterThan(0);
  });

  it('keeps its plain layout without `leading`', () => {
    const html = renderToStaticMarkup(React.createElement(WalletConnectControl));
    expect(html).not.toContain('v10-wallet-connect-row');
  });
});
