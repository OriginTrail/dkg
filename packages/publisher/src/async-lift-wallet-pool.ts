/** Scheduling only: the queue's durable wallet lock remains the ownership authority. */
export class AsyncLiftWalletPool {
  private readonly active = new Set<string>();
  private cursor = 0;

  constructor(private readonly walletIds: readonly string[]) {
    if (new Set(walletIds).size !== walletIds.length) throw new Error('Publisher wallet IDs must be unique');
  }

  acquire(): string | undefined {
    for (let offset = 0; offset < this.walletIds.length; offset += 1) {
      const walletId = this.walletIds[(this.cursor + offset) % this.walletIds.length]!;
      if (this.active.has(walletId)) continue;
      this.active.add(walletId);
      return walletId;
    }
    return undefined;
  }

  release(walletId: string, processed: boolean): void {
    this.active.delete(walletId);
    // Empty polling must not spend the rotation: six idle checks would wrap straight back
    // to wallet zero before the next sparse arrival. Advance only after actual work.
    if (processed) this.cursor = (this.walletIds.indexOf(walletId) + 1) % this.walletIds.length;
  }
}
