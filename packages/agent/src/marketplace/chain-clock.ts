/**
 * CHAIN-time clock for the marketplace runtime. Authorization expiries are
 * enforced against `block.timestamp` on-chain, and on devnets
 * (`evm_increaseTime`) or behind drifted RPCs chain time can sit far from the
 * host wall clock — a wall-clock expiry then makes every claim revert
 * `AuthorizationExpired` (chain ahead) or lets the seller serve
 * already-dead authorizations (chain behind).
 *
 * The clock reads `chain.getLatestBlockTimestamp()` at most once per refresh
 * interval and carries the result forward as a monotonic LOCAL offset
 * (`chainNow − localNow`), so steady-state calls cost nothing and time keeps
 * advancing between refreshes. When the adapter has no chain-time read, or a
 * read fails with no prior offset, it falls back to the local clock with a
 * one-time warning.
 */

export interface ChainClockChain {
  getLatestBlockTimestamp?(): Promise<bigint>;
}

export interface ChainClock {
  /** Chain-time estimate (unix seconds); refreshes the offset when stale. */
  nowSeconds(): Promise<bigint>;
  /** Synchronous estimate from the last known offset (never fetches). */
  nowSecondsSync(): bigint;
}

const DEFAULT_REFRESH_SECONDS = 30;

export function createChainClock(deps: {
  chain: ChainClockChain;
  /** Injectable local unix-seconds clock (the test seam). */
  localNowSeconds: () => number;
  refreshSeconds?: number;
  warn?: (message: string) => void;
}): ChainClock {
  const refreshSeconds = deps.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
  let offsetSeconds: bigint | undefined;
  let fetchedAtLocalSeconds = 0;
  let warnedFallback = false;

  const warnOnce = (message: string): void => {
    if (warnedFallback) return;
    warnedFallback = true;
    deps.warn?.(message);
  };

  const nowSecondsSync = (): bigint => BigInt(deps.localNowSeconds()) + (offsetSeconds ?? 0n);

  return {
    nowSecondsSync,
    async nowSeconds(): Promise<bigint> {
      const local = deps.localNowSeconds();
      if (typeof deps.chain.getLatestBlockTimestamp !== 'function') {
        warnOnce('[marketplace] chain adapter exposes no latest-block-timestamp read — expiry falls back to the wall clock');
        return BigInt(local);
      }
      if (offsetSeconds === undefined || local - fetchedAtLocalSeconds >= refreshSeconds) {
        try {
          const chainNow = await deps.chain.getLatestBlockTimestamp();
          offsetSeconds = chainNow - BigInt(local);
          fetchedAtLocalSeconds = local;
        } catch (error) {
          warnOnce(
            '[marketplace] latest-block-timestamp read failed — expiry uses '
            + `${offsetSeconds === undefined ? 'the wall clock' : 'the last known chain offset'}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return BigInt(local) + (offsetSeconds ?? 0n);
    },
  };
}
