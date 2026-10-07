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

  receipt(jobId: string, txHash: string): void {
    if (!txHash) return;
    const key = txHash.toLowerCase();
    if (this.entries.get(jobId)?.txHash === key) return;
    this.entries.delete(jobId);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(jobId, { txHash: key, receiptObservedAt: this.now() });
  }

  finality(jobId: string, txHash: string): void {
    this.receipt(jobId, txHash);
    const entry = this.entries.get(jobId);
    if (entry) entry.finalityObservedAt ??= this.now();
  }

  /** Owned read projection; persisted on the next canonical state transition. */
  project<T extends PersistedLiftJob | null>(job: T): T {
    if (!job || job.status === 'accepted' || job.status === 'claimed' || job.status === 'validated') return job;
    const entry = this.entries.get(job.jobId);
    if (!entry || entry.txHash !== getLiftJobTransactionEvidence(job)?.toLowerCase()) return job;
    return {
      ...job,
      timestamps: {
        ...job.timestamps,
        receiptObservedAt: job.timestamps.receiptObservedAt ?? entry.receiptObservedAt,
        finalityObservedAt: job.timestamps.finalityObservedAt ?? entry.finalityObservedAt,
      },
    } as T;
  }
}
