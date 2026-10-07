// SPDX-License-Identifier: Apache-2.0

import type { PersistedLiftJob } from './lift-job.js';
import { getLiftJobTransactionEvidence } from './async-lift-publisher-utils.js';

/** Diagnostics only. An observation cannot authorize a job transition or wallet release. */
export class LiftJobChainObservations {
  private readonly entries = new Map<string, {
    txHash: string;
    receiptObservedAt: number;
    finalityObservedAt?: number;
  }>();

  constructor(private readonly now: () => number) {}

  /**
   * First receipt or inclusion evidence of a transaction. `at` is the evidence's own time when
   * the caller has one. The restart schema accepts finite numbers only, so nothing else is kept.
   */
  receipt(jobId: string, txHash: string, at: number = this.now()): void {
    if (!txHash || !Number.isFinite(at)) return;
    const key = txHash.toLowerCase();
    if (this.entries.get(jobId)?.txHash === key) return;
    this.entries.delete(jobId);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(jobId, { txHash: key, receiptObservedAt: at });
  }

  /** Canonical evidence at the configured confirmation depth, recorded where it is observed. */
  finality(jobId: string, txHash: string): void {
    const at = this.now();
    this.receipt(jobId, txHash, at);
    const entry = this.entries.get(jobId);
    if (entry?.txHash === txHash.toLowerCase() && Number.isFinite(at)) entry.finalityObservedAt ??= at;
  }

  /** Owned copy with the observations of the job's transaction; a write persists it. */
  project<T extends PersistedLiftJob | null>(job: T): T {
    if (!job || job.status === 'accepted' || job.status === 'claimed' || job.status === 'validated') return job;
    const entry = this.entries.get(job.jobId);
    if (!entry || entry.txHash !== getLiftJobTransactionEvidence(job)?.toLowerCase()) return job;
    const finalityObservedAt = job.timestamps.finalityObservedAt ?? entry.finalityObservedAt;
    return {
      ...job,
      timestamps: {
        ...job.timestamps,
        receiptObservedAt: job.timestamps.receiptObservedAt ?? entry.receiptObservedAt,
        ...(finalityObservedAt === undefined ? {} : { finalityObservedAt }),
      },
    };
  }
}
