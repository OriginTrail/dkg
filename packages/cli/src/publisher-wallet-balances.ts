import type { AsyncLiftWalletBalanceReader, AsyncLiftWalletBalances } from '@origintrail-official/dkg-publisher';
import type { PublisherChainAdapters } from './publisher-chain-proof.js';

const UNREADABLE: AsyncLiftWalletBalances = { native: null, trac: null };

interface WalletBalanceSource {
  readPublisherWalletBalances?: (address: string) => Promise<AsyncLiftWalletBalances>;
}

/**
 * #3591 — each async publisher wallet's balances, read through that wallet's own chain adapter, so
 * the publisher keeps a wallet the chain refused for funds out of claims until it is topped up.
 * An adapter that cannot read balances (no chain configured, a mock) answers "unreadable", which
 * never keeps a wallet out on its own: the refused wallet then just waits out its cooldown.
 */
export function createPublisherWalletBalanceReader(adapters: PublisherChainAdapters): AsyncLiftWalletBalanceReader {
  return async (walletId) => {
    const chain = adapters.get(walletId) as WalletBalanceSource | undefined;
    if (typeof chain?.readPublisherWalletBalances !== 'function') return UNREADABLE;
    return await chain.readPublisherWalletBalances(walletId);
  };
}
