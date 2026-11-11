import { useEffect, useState } from 'react';
import { fetchWalletsBalances, pcaAgentAccount } from '../../api.js';

/**
 * Whether this node's publishes are confirmed to pay the full TRAC fee because none of its
 * operational (publishing) wallets is on ANY PCA, tracked or not. Checked on-chain per wallet
 * through `pcaAgentAccount`, so a sponsor's untracked PCA that covers a wallet is seen.
 *
 * `true` only when every wallet resolves to `accountId: null`. Anything unconfirmed stays
 * `false`: still checking, no wallets, a wallet on some PCA, or a failed lookup (which also
 * covers networks without PCAs, where the route answers 503). Fails toward saying nothing.
 */
export function useNoPcaCoverage(): boolean {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { wallets } = await fetchWalletsBalances();
        if (!wallets?.length) return;
        const accounts = await Promise.all(wallets.map((w) => pcaAgentAccount(w)));
        if (alive && accounts.every((a) => a?.accountId == null)) setConfirmed(true);
      } catch {
        // Unconfirmed: leave it false.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return confirmed;
}
