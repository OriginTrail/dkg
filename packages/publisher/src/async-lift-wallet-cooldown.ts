import { claimTrace } from './async-lift-claim-trace.js';

export interface AsyncLiftWalletEligibility {
  prepare(walletId: string): Promise<boolean>;
  /** Rechecked under the canonical claim lock; never authorizes a transaction. */
  isEligible(walletId: string): boolean;
  defer(walletId: string): void;
}

/** Process-local pacing after a real native-gas failure, with no funding estimates or RPCs. */
export class AsyncLiftWalletCooldown implements AsyncLiftWalletEligibility {
  private readonly retryAt = new Map<string, number>();
  private readonly wallets: ReadonlySet<string>;

  constructor(walletIds: readonly string[], private readonly now: () => number = Date.now) {
    this.wallets = new Set(walletIds);
  }

  async prepare(walletId: string): Promise<boolean> {
    return this.isEligible(walletId);
  }

  isEligible(walletId: string): boolean {
    return this.wallets.has(walletId) && this.now() >= (this.retryAt.get(walletId) ?? 0);
  }

  defer(walletId: string): void {
    if (!this.wallets.has(walletId)) return;
    const observedAt = this.now();
    const retryAt = Math.max(this.retryAt.get(walletId) ?? 0, observedAt + 30_000);
    this.retryAt.set(walletId, retryAt);
    claimTrace.emit('wallet_funding', { reason: 'funding-cooldown', observedAt, retryAt }, walletId);
  }
}
