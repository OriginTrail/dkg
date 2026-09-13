import { nativeGasSymbol } from '../lib/nativeGasSymbol.js';
import { chainIdHex, numericChainId } from './chainId.js';
import type { Eip1193Provider } from './eip6963.js';

export interface WalletChainBootstrap {
  chainId: string | number;
  walletRpcUrls?: string[];
}

function rpcUrlsForWalletAdd(bootstrap: WalletChainBootstrap): string[] {
  return (bootstrap.walletRpcUrls ?? []).filter((rpcUrl) => /^https?:\/\//i.test(rpcUrl));
}

/** Switch an injected wallet to the chain owned by the calling feature's bootstrap. */
export async function switchWalletToBootstrap(
  provider: Eip1193Provider,
  bootstrap: WalletChainBootstrap,
): Promise<void> {
  const hex = chainIdHex(bootstrap.chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (err: unknown) {
    if ((err as { code?: number })?.code !== 4902) throw err;

    const symbol = nativeGasSymbol(bootstrap.chainId);
    const rpcUrls = rpcUrlsForWalletAdd(bootstrap);
    if (rpcUrls.length === 0) {
      throw new Error(
        'Wallet does not know this chain and the node did not provide wallet-public RPC URLs. ' +
        'Add the network in your wallet, then try again.',
      );
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: `chain-${numericChainId(bootstrap.chainId)}`,
          nativeCurrency: { name: symbol, symbol, decimals: 18 },
          rpcUrls,
        },
      ],
    });
  }
}
