import { useEffect, useState } from 'react';
import { fetchWalletsBalances, pcaAgentAccount } from '../../api.js';

/** Recheck rate: the same 30s the publish chip's eligibility poll uses. */
export const NO_PCA_COVERAGE_RECHECK_MS = 30_000;

/**
 * Whether this node's publishes are confirmed to pay the full TRAC fee because none of its
 * operational (publishing) wallets is on ANY PCA, tracked or not. Checked on-chain per wallet
 * through `pcaAgentAccount`, so a sponsor's untracked PCA that covers a wallet is seen.
 *
 * `true` only while the latest check found every wallet at `accountId: null`. It's rechecked
 * every `intervalMs` while mounted, so a sponsor approving a wallet later clears it without a
 * remount. Anything unconfirmed makes it `false`: still checking, no wallets, a wallet on some
 * PCA, or a failed lookup (which also covers networks without PCAs, where the route answers
 * 503). Fails toward saying nothing.
 */
export function useNoPcaCoverage(intervalMs = NO_PCA_COVERAGE_RECHECK_MS): boolean {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let alive = true;
    let latest = 0;
    const check = async () => {
      const run = ++latest;
      let next = false;
      try {
        const { wallets } = await fetchWalletsBalances();
        if (wallets?.length) {
          const accounts = await Promise.all(wallets.map((w) => pcaAgentAccount(w)));
          next = accounts.every((a) => a?.accountId == null);
        }
      } catch {
        next = false;
      }
      // Only the newest check counts, so a slow older one can't bring back a stale answer.
      if (alive && run === latest) setConfirmed(next);
    };
    void check();
    const timer = intervalMs > 0 ? setInterval(() => { void check(); }, intervalMs) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [intervalMs]);

  return confirmed;
}
