// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  useWalletStore,
  visibleProviders,
  reconnectTarget,
  isWrongNetwork,
  _resetWalletModuleStateForTesting,
} from '../src/ui/stores/wallet.js';
import { _resetDiscoveryForTesting } from '../src/ui/web3/eip6963.js';
import { MockEip6963Provider } from './mocks/mockEip6963Provider.js';
import type { PcaContracts } from '../src/ui/api.js';
import type { Eip6963ProviderDetail } from '../src/ui/web3/eip6963.js';

const CONTRACTS: PcaContracts = {
  nft: `0x${'11'.repeat(20)}`,
  token: `0x${'22'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};

function detail(rdns: string): Eip6963ProviderDetail {
  return new MockEip6963Provider({ rdns }).detail();
}

beforeEach(() => {
  _resetWalletModuleStateForTesting();
  _resetDiscoveryForTesting();
  try { localStorage.clear(); } catch { /* ignore */ }
  useWalletStore.setState({
    discovered: [], unsupported: [], provider: null, providerInfo: null,
    address: null, chainId: null, expectedChainId: null, bootstrap: null,
  });
});
afterEach(() => { _resetWalletModuleStateForTesting(); _resetDiscoveryForTesting(); });

describe('wallet store — pure helpers', () => {
  it('visibleProviders filters excluded wallets (phantom)', () => {
    const list = [detail('io.metamask'), detail('app.phantom'), detail('app.rabby')];
    expect(visibleProviders(list).map((p) => p.info.rdns)).toEqual(['io.metamask', 'app.rabby']);
  });

  it('reconnectTarget returns a single unambiguous match, null otherwise', () => {
    const list = [detail('io.metamask'), detail('app.rabby')];
    expect(reconnectTarget(list, 'io.metamask')?.info.rdns).toBe('io.metamask');
    expect(reconnectTarget(list, 'absent')).toBeNull();
    expect(reconnectTarget([detail('dup'), detail('dup')], 'dup')).toBeNull(); // ambiguous
    expect(reconnectTarget(list, null)).toBeNull();
  });

  it('isWrongNetwork only when connected AND on a different chain', () => {
    expect(isWrongNetwork({ address: null, chainId: 1, expectedChainId: 84532 })).toBe(false);
    expect(isWrongNetwork({ address: `0x${'33'.repeat(20)}`, chainId: 1, expectedChainId: 84532 })).toBe(true);
    expect(isWrongNetwork({ address: `0x${'33'.repeat(20)}`, chainId: 84532, expectedChainId: 84532 })).toBe(false);
  });
});

describe('wallet store — bootstrap + connect lifecycle', () => {
  it('setBootstrap records the expected (numeric) chain id', () => {
    useWalletStore.getState().setBootstrap(CONTRACTS);
    expect(useWalletStore.getState().expectedChainId).toBe(84532); // numeric tail of "base:84532"
  });

  it('connect populates address/chainId and persists the rdns; disconnect clears it', async () => {
    const p = new MockEip6963Provider({ rdns: 'io.metamask', accounts: [`0x${'33'.repeat(20)}`], chainId: 84532 });
    await useWalletStore.getState().connect(p.detail());
    const s = useWalletStore.getState();
    expect(s.address).toBe(`0x${'33'.repeat(20)}`);
    expect(s.chainId).toBe(84532);
    expect(localStorage.getItem('dkg-node-ui:wallet-provider-rdns')).toBe('io.metamask');

    useWalletStore.getState().disconnect();
    expect(useWalletStore.getState().address).toBeNull();
    expect(localStorage.getItem('dkg-node-ui:wallet-provider-rdns')).toBeNull();
  });

  it('reflects an in-wallet account switch via accountsChanged', async () => {
    const p = new MockEip6963Provider({ rdns: 'io.metamask', accounts: [`0x${'33'.repeat(20)}`] });
    await useWalletStore.getState().connect(p.detail());
    p.setAccounts([`0x${'55'.repeat(20)}`]);
    expect(useWalletStore.getState().address).toBe(`0x${'55'.repeat(20)}`);
  });

  it('treats accountsChanged([]) (disconnect-all in the wallet) as a full disconnect', async () => {
    const p = new MockEip6963Provider({ rdns: 'io.metamask', accounts: [`0x${'33'.repeat(20)}`] });
    await useWalletStore.getState().connect(p.detail());
    p.setAccounts([]);
    expect(useWalletStore.getState().address).toBeNull();
    expect(localStorage.getItem('dkg-node-ui:wallet-provider-rdns')).toBeNull();
  });

  it('reflects an in-wallet chain switch via chainChanged (drives the wrong-network guard)', async () => {
    useWalletStore.getState().setBootstrap(CONTRACTS);
    const p = new MockEip6963Provider({ rdns: 'io.metamask', accounts: [`0x${'33'.repeat(20)}`], chainId: 84532 });
    await useWalletStore.getState().connect(p.detail());
    expect(isWrongNetwork(useWalletStore.getState())).toBe(false);
    p.setChainId(1); // user switches to Ethereum mainnet in their wallet
    expect(useWalletStore.getState().chainId).toBe(1);
    expect(isWrongNetwork(useWalletStore.getState())).toBe(true);
  });

  it('switchToExpectedChain asks the wallet to switch to the bootstrap chain', async () => {
    useWalletStore.getState().setBootstrap(CONTRACTS);
    const p = new MockEip6963Provider({ rdns: 'io.metamask', accounts: [`0x${'33'.repeat(20)}`], chainId: 1 });
    await useWalletStore.getState().connect(p.detail());
    await useWalletStore.getState().switchToExpectedChain();
    expect(p.calls).toContain('wallet_switchEthereumChain');
    expect(useWalletStore.getState().chainId).toBe(84532); // mock applies the switch + emits chainChanged
  });
});
