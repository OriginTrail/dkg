import type { PublisherGasFundingObservation } from '@origintrail-official/dkg-chain';
import { claimTrace } from './async-lift-claim-trace.js';

export interface AsyncLiftWalletEligibility {
  prepare(walletId: string): Promise<boolean>;
  /** Synchronous freshness check after waiting for the canonical claim lock. */
  isEligible(walletId: string): boolean;
  defer(walletId: string): void;
}

export interface WalletFundingStatus {
  readonly walletId: string;
  readonly reason: 'eligible' | 'insufficient-gas' | 'funding-unavailable' | 'funding-cooldown' | 'unsupported';
  readonly observedAt: number;
  readonly retryAt: number;
  readonly observation?: PublisherGasFundingObservation;
}

/** Bounded process-local routing hints. Never grants a claim or transaction authority. */
export class AsyncLiftWalletFunding implements AsyncLiftWalletEligibility {
  private readonly statuses = new Map<string, WalletFundingStatus>();
  private readonly reads = new Map<string, Promise<boolean>>();

  constructor(
    private readonly readers: ReadonlyMap<string, (() => Promise<PublisherGasFundingObservation>) | undefined>,
    private readonly now: () => number = Date.now,
  ) {}

  prepare(walletId: string): Promise<boolean> {
    const status = this.statuses.get(walletId);
    if (status && this.now() < status.retryAt) return Promise.resolve(false);
    if (this.isEligible(walletId)) return Promise.resolve(true);
    const pending = this.reads.get(walletId);
    if (pending) return pending;
    const read = this.observe(walletId).finally(() => {
      if (this.reads.get(walletId) === read) this.reads.delete(walletId);
    });
    this.reads.set(walletId, read);
    return read;
  }

  isEligible(walletId: string): boolean {
    const status = this.statuses.get(walletId);
    if (!status || this.now() < status.retryAt) return false;
    const age = this.now() - status.observedAt;
    return (status.reason === 'eligible' || status.reason === 'unsupported') && age >= 0 && age <= 5_000;
  }

  defer(walletId: string): void {
    if (!this.readers.has(walletId)) return;
    this.record({ walletId, reason: 'funding-cooldown', observedAt: this.now(), retryAt: this.now() + 30_000 });
  }

  snapshot(): readonly (WalletFundingStatus & { readonly ageMs: number })[] {
    return [...this.statuses.values()].map((status) => ({ ...status, ageMs: Math.max(0, this.now() - status.observedAt) }));
  }

  private async observe(walletId: string): Promise<boolean> {
    if (!this.readers.has(walletId)) return false;
    const reader = this.readers.get(walletId);
    const previous = this.statuses.get(walletId);
    try {
      const observation = await reader?.();
      if (this.statuses.get(walletId) !== previous) return false;
      const age = observation ? this.now() - observation.observedAt : 0;
      if (observation && (age < 0 || age > 5_000 || observation.gasLimit <= 0n
        || observation.feePerGasWei < 0n || observation.requiredWei < 0n || observation.balanceWei < 0n)) {
        throw new Error('Unusable publisher funding observation');
      }
      const reason = !observation ? 'unsupported'
        : observation.balanceWei < observation.requiredWei ? 'insufficient-gas' : 'eligible';
      this.record({ walletId, reason, observedAt: observation?.observedAt ?? this.now(),
        retryAt: reason === 'insufficient-gas' ? this.now() + 30_000 : 0, observation });
    } catch {
      if (this.statuses.get(walletId) !== previous) return false;
      this.record({ walletId, reason: 'funding-unavailable', observedAt: this.now(), retryAt: this.now() + 5_000 });
    }
    return this.isEligible(walletId);
  }

  private record(status: WalletFundingStatus): void {
    this.statuses.set(status.walletId, status);
    claimTrace.emit('wallet_funding', {
      reason: status.reason, observedAt: status.observedAt, retryAt: status.retryAt,
      ageMs: Math.max(0, this.now() - status.observedAt),
      balanceWei: status.observation?.balanceWei.toString(), requiredWei: status.observation?.requiredWei.toString(),
    }, status.walletId);
  }
}
