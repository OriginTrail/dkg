// SPDX-License-Identifier: Apache-2.0
import type { ExactAssetEncodedExportLease } from './exact-asset-export-cache.js';

type Outcome = { lease: ExactAssetEncodedExportLease | null } | { error: unknown };

/** One optional next export, charged to the same cache budget as the current one. */
export class CheckpointExportLookahead {
  private readonly abort = new AbortController();
  readonly signal: AbortSignal;
  private pending?: { index: number; result: Promise<Outcome> };

  constructor(signal: AbortSignal, private readonly acquire: (
    index: number, signal: AbortSignal,
  ) => Promise<ExactAssetEncodedExportLease | null>) {
    this.signal = AbortSignal.any([signal, this.abort.signal]);
  }

  prepare(index: number): void {
    if (this.pending) throw new Error('Checkpoint lookahead already occupied');
    this.signal.throwIfAborted();
    // Observe rejection immediately, including while the current stream send is blocked.
    this.pending = { index, result: this.acquire(index, this.signal).then(
      lease => ({ lease }), error => ({ error }),
    ) };
  }

  async take(index: number): Promise<ExactAssetEncodedExportLease | null> {
    this.signal.throwIfAborted();
    const pending = this.pending;
    if (!pending) return this.acquire(index, this.signal);
    if (pending.index !== index) throw new Error('Invalid checkpoint lookahead order');
    this.pending = undefined;
    const outcome = await pending.result;
    if ('error' in outcome) throw outcome.error;
    if (outcome.lease) return outcome.lease;
    // An optional preparation can lack budget while the previous response owns
    // it. Now that response is released, use the ordinary admission path once.
    // Integrity/authority/deadline failures above are never retried.
    this.signal.throwIfAborted();
    return this.acquire(index, this.signal);
  }

  async close(): Promise<void> {
    this.abort.abort(new Error('Checkpoint export completed'));
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      const outcome = await pending.result;
      if ('lease' in outcome) outcome.lease?.release();
    }
  }
}
