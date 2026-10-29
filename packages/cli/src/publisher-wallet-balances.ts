import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { AsyncLiftWalletBalanceReader, AsyncLiftWalletBalances } from '@origintrail-official/dkg-publisher';
import type { PublisherChainAdapters } from './publisher-chain-proof.js';

const UNREADABLE: AsyncLiftWalletBalances = { native: null, trac: null };

interface WalletBalanceSource {
  readPublisherWalletBalances?: (address: string) => Promise<AsyncLiftWalletBalances>;
}

/**
 * #3591 — each async publisher wallet's balances, read through that wallet's own chain adapter, so
 * the publisher keeps a wallet the chain refused for funds out of claims until it is topped up.
 * Besides native gas and TRAC this reads what the wallet's Publishing Conviction Account can still
 * cover: registering or funding an account restores a wallet without changing either balance.
 * Each part fails on its own. An adapter that cannot read a part (no chain configured, a mock, no
 * PCA contract) answers it as unknown, which never keeps a wallet out: the refused wallet then
 * waits out its cooldown.
 */
export function createPublisherWalletBalanceReader(
  adapters: PublisherChainAdapters,
  nowMs: () => number = () => Date.now(),
): AsyncLiftWalletBalanceReader {
  return async (walletId) => {
    const chain = adapters.get(walletId) as (ChainAdapter & WalletBalanceSource) | undefined;
    if (!chain) return UNREADABLE;
    const [balances, pca] = await Promise.all([
      typeof chain.readPublisherWalletBalances === 'function'
        ? chain.readPublisherWalletBalances(walletId).catch(() => UNREADABLE)
        : UNREADABLE,
      readConvictionCoverage(chain, walletId, nowMs),
    ]);
    return { native: balances.native, trac: balances.trac, pca };
  };
}

/** What the wallet's Publishing Conviction Account can still cover this epoch: `0n` for no agent or an expired account. */
async function readConvictionCoverage(chain: ChainAdapter, walletId: string, nowMs: () => number): Promise<bigint | null> {
  if (!chain.getConvictionAgentAccountId || !chain.getPublishingConvictionAccountInfo) return null;
  try {
    // Strict, so a chain without the PCA contract or a failed read is unknown rather than "no agent".
    const accountId = await chain.getConvictionAgentAccountId(walletId, { strict: true });
    if (accountId <= 0n) return 0n;
    const info = await chain.getPublishingConvictionAccountInfo(accountId, { extended: true });
    if (!info) return 0n;
    if (info.expiresAtTimestamp > 0 && nowMs() / 1000 >= info.expiresAtTimestamp) return 0n;
    return info.remainingAllowance ?? null;
  } catch {
    return null;
  }
}
