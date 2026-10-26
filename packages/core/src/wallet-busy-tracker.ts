/** Whether at least one configured wallet was free at an instant. */
export type WalletAvailability = 'free' | 'busy' | 'unknown';

/**
 * Busy intervals of the publisher wallets, built from wallet-lock writes and deletes.
 *
 * It answers one question for the usage line: when a job became ready, did at least one of
 * the configured wallets hold no wallet lock? That is the "worker-free" condition of the
 * publisher pick-up metric (OT-RFC-73 §8.4, D-16): each wallet runs one publisher worker, so a
 * free wallet means a worker was available to claim the job.
 *
 * An instant before the tracker first saw a wallet is `unknown` for that wallet: the process
 * may have started with the lock already held. A closed interval is kept only up to
 * `maxClosedPerWallet` per wallet; an instant older than the oldest one kept is unknown too.
 * Times are wall-clock milliseconds.
 */
export class WalletBusyTracker {
  private configured: string[] = [];
  /** Earliest instant from which this wallet's whole history is known. */
  private readonly knownSince = new Map<string, number>();
  private readonly openSince = new Map<string, number>();
  private readonly closed = new Map<string, Array<{ start: number; end: number }>>();

  constructor(private readonly maxClosedPerWallet = 1024) {}

  /** The wallets that run publisher workers. An empty set makes every instant `unknown`. */
  setConfigured(walletIds: readonly string[]): void {
    this.configured = [...new Set(walletIds)];
  }

  get configuredCount(): number {
    return this.configured.length;
  }

  /** The wallet's lock was written active. A refresh of a lock that is already open changes nothing. */
  markBusy(walletId: string, atMs: number): void {
    if (!this.knownSince.has(walletId)) this.knownSince.set(walletId, atMs);
    if (!this.openSince.has(walletId)) this.openSince.set(walletId, atMs);
  }

  /** The wallet's lock was deleted. */
  markFree(walletId: string, atMs: number): void {
    if (!this.knownSince.has(walletId)) this.knownSince.set(walletId, atMs);
    const start = this.openSince.get(walletId);
    if (start === undefined) return;
    this.openSince.delete(walletId);
    const intervals = this.closed.get(walletId) ?? [];
    intervals.push({ start, end: Math.max(start, atMs) });
    while (intervals.length > this.maxClosedPerWallet) {
      // History before the oldest interval kept is gone, so the wallet is unknown before it ends.
      const evicted = intervals.shift()!;
      this.knownSince.set(walletId, Math.max(this.knownSince.get(walletId) ?? 0, evicted.end));
    }
    this.closed.set(walletId, intervals);
  }

  /**
   * The state a read of the wallet's lock found: a usable lock means busy, anything else
   * (no lock, or one that expired) means free. This seeds a wallet after a restart.
   */
  observe(walletId: string, usable: boolean, atMs: number): void {
    if (!this.knownSince.has(walletId)) this.knownSince.set(walletId, atMs);
    if (!usable) {
      this.markFree(walletId, atMs);
    } else if (!this.openSince.has(walletId)) {
      // Busy as of this read, not back to the first sighting, which may be long before it.
      this.openSince.set(walletId, atMs);
    }
  }

  /**
   * Busy means the lock was held strictly inside the interval, so the lock the claiming worker
   * wrote at the instant the job became ready does not count against that job.
   */
  private busyAt(walletId: string, atMs: number): boolean {
    const open = this.openSince.get(walletId);
    if (open !== undefined && open < atMs) return true;
    return (this.closed.get(walletId) ?? []).some((interval) => interval.start < atMs && atMs < interval.end);
  }

  /** `free` if any known wallet held no lock at the instant, `busy` if every wallet was known and held one. */
  classify(atMs: number): WalletAvailability {
    if (this.configured.length === 0) return 'unknown';
    let allKnown = true;
    for (const walletId of this.configured) {
      const since = this.knownSince.get(walletId);
      if (since === undefined || since > atMs) {
        allKnown = false;
        continue;
      }
      if (!this.busyAt(walletId, atMs)) return 'free';
    }
    return allKnown ? 'busy' : 'unknown';
  }
}
