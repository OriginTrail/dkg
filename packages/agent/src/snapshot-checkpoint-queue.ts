// SPDX-License-Identifier: Apache-2.0
import { BULK_STAGING_ASSETS, BULK_STAGING_BYTES } from './sync/bulk-graph-contract.js';
import type { SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';

/** Durable files stay isolated; only bounded references cross into verification. */
export class SnapshotCheckpointQueue {
  private readonly abort = new AbortController();
  readonly signal: AbortSignal;
  private readonly items: SnapshotCheckpointEntry[] = [];
  private readonly waiters = new Set<() => void>();
  private bytes = 0;
  private count = 0;
  private ended = false;

  constructor(signal: AbortSignal) { this.signal = AbortSignal.any([signal, this.abort.signal]); }
  private wake() { for (const waiter of this.waiters) waiter(); }
  private async wait(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>(resolve => {
      const wake = () => { this.waiters.delete(wake); signal.removeEventListener('abort', wake); resolve(); };
      this.waiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
      if (signal.aborted) wake();
    });
    signal.throwIfAborted();
  }
  async reserve(bytes: number, lifetime: AbortSignal = this.signal) {
    const signal = AbortSignal.any([lifetime, this.signal]);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > BULK_STAGING_BYTES) throw new RangeError('Invalid checkpoint staging size');
    while (this.count >= BULK_STAGING_ASSETS || this.bytes + bytes > BULK_STAGING_BYTES) await this.wait(signal);
    signal.throwIfAborted();
    if (this.ended) throw new Error('Checkpoint receiver already completed');
    this.count++; this.bytes += bytes;
  }
  publish(entry: SnapshotCheckpointEntry) {
    this.signal.throwIfAborted();
    if (this.ended) throw new Error('Checkpoint receiver already completed');
    this.items.push(entry); this.wake();
  }
  async next(signal: AbortSignal): Promise<SnapshotCheckpointEntry | undefined> {
    for (;;) {
      signal.throwIfAborted();
      const entry = this.items.shift();
      if (entry) return entry;
      if (this.ended) return undefined;
      await this.wait(signal);
    }
  }
  consumed(entry: SnapshotCheckpointEntry) {
    if (this.count < 1 || entry.encodedBytes > this.bytes) throw new Error('Invalid checkpoint staging release');
    this.count--; this.bytes -= entry.encodedBytes; this.wake();
  }
  complete() { this.ended = true; this.wake(); }
  fail(error: unknown) { this.abort.abort(error); this.wake(); }
}
