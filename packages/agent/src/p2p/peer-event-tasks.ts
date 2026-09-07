/** Admission and retirement boundary for one node lifetime's peer workflows. */
export class PeerEventTasks {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<() => void>();
  readonly signal = this.controller.signal;

  constructor(private readonly retireSyncState: () => void) {}

  /** Remove listeners and release this lifetime's state synchronously. */
  close(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.retireSyncState();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  /** Register a pending connection fence until its workflow settles. */
  onClose(cleanup: () => void): () => void {
    if (this.signal.aborted) {
      cleanup();
      return () => {};
    }
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  run(work: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void): void {
    if (this.signal.aborted) return;
    void work(this.signal).catch((error: unknown) => {
      if (!this.signal.aborted) onError(error);
    });
  }
}
