/** Cooperative continuation supervision; transports retain physical drain ownership. */
export class PeerEventLifetime {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  get state(): 'running' | 'stopped' { return this.signal.aborted ? 'stopped' : 'running'; }
  checkpoint(): boolean { return this.state === 'running'; }

  /** Commit synchronous bookkeeping only while this captured lifetime is current. */
  commit(work: () => void): void { if (this.checkpoint()) work(); }

  close(): void {
    if (!this.checkpoint()) return;
    this.controller.abort();
  }

  onClose(cleanup: () => void): () => void {
    if (!this.checkpoint()) { cleanup(); return () => {}; }
    this.signal.addEventListener('abort', cleanup, { once: true });
    return () => { this.signal.removeEventListener('abort', cleanup); };
  }

  /** Fence both sides of one awaited continuation against this lifetime. */
  async step<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const result = await work(this.signal);
    this.signal.throwIfAborted();
    return result;
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
