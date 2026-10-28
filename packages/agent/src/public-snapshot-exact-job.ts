// SPDX-License-Identifier: Apache-2.0
import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import type { PublicSnapshotExactRecoveryOptions } from './public-snapshot-exact.js';
import type { PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';
import { PublicSnapshotRecoveryPacing } from './public-snapshot-exact-pacing.js';

/** Private state owned once by an exact recovery job, regardless of lane count. */
export class PublicSnapshotExactJob {
  readonly committed = new Set<string>();
  readonly signal: AbortSignal;
  readonly pacing: PublicSnapshotRecoveryPacing;
  private alreadyPresent = 0;
  private readonly failure = new AbortController();
  private readonly peerLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: PublicSnapshotExactRecoveryOptions) {
    this.signal = AbortSignal.any([options.signal, this.failure.signal]);
    this.pacing = new PublicSnapshotRecoveryPacing({ ...options, signal: this.signal, assertCurrent: this.assertCurrent });
  }

  readonly assertCurrent = (): void => { this.options.assertCurrent(); this.signal.throwIfAborted(); };
  readonly isCurrent = (): boolean => { try { this.assertCurrent(); return true; } catch { return false; } };
  incomplete(reason?: string): Error {
    return new Error(`Snapshot recovery incomplete: ${this.progress()} committed${reason ? ` (${reason})` : ''}`);
  }
  progress(): string { return `${this.committed.size}/${this.options.uals.length}`; }
  assertActive(): void {
    if (Date.now() >= this.options.deadline) throw this.incomplete('job time limit reached');
    this.assertCurrent();
  }
  record(uals: readonly string[], held = false): number {
    const before = this.committed.size;
    for (const ual of uals) this.committed.add(ual);
    const added = this.committed.size - before;
    if (held) this.alreadyPresent += added;
    return added;
  }
  async serializePeer<T>(peer: string, run: () => Promise<T>): Promise<T> {
    return withKeyedLocks(this.peerLocks, [peer], async () => {
      this.assertActive();
      return run();
    });
  }
  async run(workers: Array<() => Promise<void>>): Promise<PublicSnapshotRecoveryResult> {
    let firstFailure: unknown;
    await Promise.allSettled(workers.map(async worker => {
      try { await worker(); }
      catch (error) {
        if (!this.failure.signal.aborted) { firstFailure = error; this.failure.abort(error); }
        throw error;
      }
    }));
    // Every physical callback and peer lock has drained before ownership returns.
    if (this.failure.signal.aborted) throw firstFailure;
    this.assertActive();
    return { committed: this.committed, alreadyPresent: this.alreadyPresent };
  }
}
