/** Admission and cancellation boundary for one node lifetime's peer workflows. */
export class PeerEventTasks {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  abort(): void {
    this.controller.abort();
  }

  run(work: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void): void {
    if (this.signal.aborted) return;
    void work(this.signal).catch((error: unknown) => {
      if (!this.signal.aborted) onError(error);
    });
  }
}
