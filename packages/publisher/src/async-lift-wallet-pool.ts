/** Scheduling only: the queue's durable wallet lock remains the ownership authority. */
export class AsyncLiftWalletPool {
  private readonly active = new Set<string>();
  private cursor = 0;
  private workCursor = 0;

  constructor(private readonly walletIds: readonly string[]) {
    if (new Set(walletIds).size !== walletIds.length) throw new Error('Publisher wallet IDs must be unique');
  }

  acquire(): string | undefined {
    for (let offset = 0; offset < this.walletIds.length; offset += 1) {
      const index = (this.cursor + offset) % this.walletIds.length;
      const walletId = this.walletIds[index]!;
      if (this.active.has(walletId)) continue;
      this.active.add(walletId);
      this.cursor = (index + 1) % this.walletIds.length;
      return walletId;
    }
    return undefined;
  }

  release(walletId: string, processed: boolean): void {
    this.active.delete(walletId);
    if (processed) {
      this.workCursor = (this.walletIds.indexOf(walletId) + 1) % this.walletIds.length;
      this.cursor = this.workCursor;
    }
  }

  /** New work starts after actual prior work; idle polls independently visit every wallet. */
  workAvailable(): void { this.cursor = this.workCursor; }
}
