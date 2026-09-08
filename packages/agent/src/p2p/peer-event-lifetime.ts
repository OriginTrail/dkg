/** Cooperative continuation supervision; transports retain physical drain ownership. */
export class PeerEventLifetime {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<() => void>();
  readonly signal = this.controller.signal;

  get state(): 'running' | 'stopped' { return this.signal.aborted ? 'stopped' : 'running'; }
  checkpoint(): boolean { return this.state === 'running'; }

  /** Commit synchronous bookkeeping only while this captured lifetime is current. */
  commit(work: () => void): void { if (this.checkpoint()) work(); }

  close(): void {
    if (!this.checkpoint()) return;
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  onClose(cleanup: () => void): () => void {
    if (!this.checkpoint()) { cleanup(); return () => {}; }
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  async run(work: (signal: AbortSignal) => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    if (!this.checkpoint()) return;
    try { await work(this.signal); }
    catch (error: unknown) {
      if (!this.checkpoint()) return;
      if (onError) onError(error);
      else throw error;
    }
  }
}
