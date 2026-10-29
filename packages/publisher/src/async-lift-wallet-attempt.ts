import type { PersistedLiftJob } from './lift-job.js';

/** Prepared concurrently; wallet binding and freshness stay with the publisher. */
export interface AsyncLiftClaimScheduling {
  prepare(walletId: string): Promise<AsyncLiftWalletAttempt | null>;
}

/** Single use. Refresh stale eligibility outside the canonical lock before claiming. */
export interface AsyncLiftWalletAttempt {
  /** Acknowledgement releases scheduling order while execution continues concurrently. */
  process(onClaimed: () => void): Promise<PersistedLiftJob | null>;
}
