import { fetchWalletsBalances, pcaAgentAccount } from '../../api.js';
import { useFetch } from '../../hooks.js';

/** Recheck rate: the same 30s the publish chip's eligibility poll uses. */
export const NO_PCA_COVERAGE_RECHECK_MS = 30_000;

/**
 * One check: `true` only when this node has wallets and every one resolves to `accountId: null`.
 * Never throws. A failed lookup (including the 503 on networks without PCAs) returns `false`,
 * because `useFetch` keeps its last value after a thrown error and that could leave a stale
 * full-fee claim showing.
 */
async function checkNoPcaCoverage(): Promise<boolean> {
  try {
    const { wallets } = await fetchWalletsBalances();
    if (!wallets?.length) return false;
    const accounts = await Promise.all(wallets.map((w) => pcaAgentAccount(w)));
    return accounts.every((a) => a?.accountId == null);
  } catch {
    return false;
  }
}

/**
 * Whether this node's publishes are confirmed to pay the full TRAC fee because none of its
 * operational (publishing) wallets is on ANY PCA, tracked or not. Checked on-chain per wallet
 * through `pcaAgentAccount`, so a sponsor's untracked PCA that covers a wallet is seen.
 *
 * Rechecked every `intervalMs` through the shared `useFetch` lifecycle, so a sponsor approving
 * a wallet later clears it without a remount; `useFetch` pauses while the tab is hidden, skips
 * a tick while a check is still running, and only publishes the newest result. `false` until
 * the first check confirms, and whenever a check finds coverage or fails.
 */
export function useNoPcaCoverage(intervalMs = NO_PCA_COVERAGE_RECHECK_MS): boolean {
  const { data } = useFetch(checkNoPcaCoverage, [], intervalMs);
  return data === true;
}
