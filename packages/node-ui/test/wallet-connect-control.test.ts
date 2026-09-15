import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { WalletConnectControl } from '../src/ui/components/Wallet/WalletConnectControl.js';
import { PcaWalletConnectControl } from '../src/ui/components/Pca/PcaWalletConnectControl.js';
import { useWalletStore } from '../src/ui/stores/wallet.js';

describe('feature-owned wallet connection guidance', () => {
  beforeEach(() => {
    useWalletStore.setState({ address: null, discovered: [], unsupported: [] });
  });

  it('keeps the shared identity-wallet surface free of PCA publishing language', () => {
    const html = renderToStaticMarkup(React.createElement(WalletConnectControl));
    expect(html).toContain('Verify every transaction on the signing device');
    expect(html).not.toContain('Hot publishing wallets');
    expect(html).not.toContain('per-epoch allowance');
  });

  it('renders PCA publishing guidance only through the PCA wrapper', () => {
    const html = renderToStaticMarkup(React.createElement(PcaWalletConnectControl));
    expect(html).toContain('Hot publishing wallets');
    expect(html).toContain('per-epoch allowance');
  });
});
