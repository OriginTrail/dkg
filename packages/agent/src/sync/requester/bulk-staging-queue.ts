// SPDX-License-Identifier: Apache-2.0
import { BULK_STAGING_ASSETS, BULK_STAGING_BYTES, type BulkAssetHeader } from '../bulk-graph-contract.js';

export interface BulkStagedAsset { index: number; path: string; header: BulkAssetHeader; chunks: number }
type Delivery<T> = { kind: 'item'; value: T } | { kind: 'flush' } | { kind: 'done' };

/** One reader and one consumer. Reservations include files being written or verified. */
export class BulkStagingQueue {
  private readonly cancellation = new AbortController();
  readonly signal: AbortSignal;
  private readonly items: BulkStagedAsset[] = [];
  private wake?: () => void;
  private failure?: { cause: unknown };
  private ended = false;
  private bytes = 0;
  private count = 0;
  peakBytes = 0;

  constructor(signal: AbortSignal) { this.signal = AbortSignal.any([signal, this.cancellation.signal]); }
  get completed() { return this.ended; }
  get error() { return this.failure?.cause; }

  reserve(bytes: number) {
    this.signal.throwIfAborted();
    if (this.ended || this.bytes + bytes > BULK_STAGING_BYTES || this.count >= BULK_STAGING_ASSETS)
      throw new RangeError('Bulk chunk or staging credit exceeded');
    this.bytes += bytes; this.count++;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }
  consumed(bytes: number) {
    if (this.count < 1 || bytes > this.bytes) throw new Error('Invalid bulk staging release');
    this.bytes -= bytes; this.count--;
  }
  deliver(value: BulkStagedAsset) {
    this.signal.throwIfAborted();
    if (this.ended) throw new Error('Bulk staging already completed');
    this.items.push(value); this.wake?.();
  }
  complete() { this.ended = true; this.wake?.(); }
  fail(cause: unknown) {
    this.failure ??= { cause };
    this.cancellation.abort(this.failure.cause);
    this.wake?.();
  }
  async next(flushAt?: number): Promise<Delivery<BulkStagedAsset>> {
    for (;;) {
      this.signal.throwIfAborted();
      const value = this.items.shift();
      if (value) return { kind: 'item', value };
      if (this.ended) return { kind: 'done' };
      if (flushAt !== undefined && Date.now() >= flushAt) return { kind: 'flush' };
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => {
          if (timer) clearTimeout(timer);
          this.signal.removeEventListener('abort', wake);
          if (this.wake === wake) this.wake = undefined;
          resolve();
        };
        this.wake = wake;
        this.signal.addEventListener('abort', wake, { once: true });
        if (flushAt !== undefined) timer = setTimeout(wake, Math.max(0, flushAt - Date.now()));
        if (this.signal.aborted) wake();
      });
    }
  }
}
