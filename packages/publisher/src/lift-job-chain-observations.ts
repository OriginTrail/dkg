// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { PersistedLiftJob } from './lift-job.js';
import { getLiftJobTransactionEvidence } from './async-lift-publisher-utils.js';
import { LiftJobCompletionTiming } from './lift-job-completion-timing.js';

const sharedByStore = new WeakMap<TripleStore, Map<string, LiftJobChainObservations>>();

/** Diagnostics only. An observation cannot authorize a job transition or wallet release. */
export class LiftJobChainObservations {
  private readonly entries = new Map<string, {
    txHash: string;
    receiptObservedAt: number;
    finalityObservedAt?: number;
  }>();

  /**
   * GH#3081 — the timeline these observations open, up to the job's terminal record. Diagnostics
   * only, like the observations themselves; replaceable, for example to inject a clock.
   */
  completion = new LiftJobCompletionTiming();

  /**
   * The observations of one store and control graph in this process. A daemon serves job views
   * from another publisher instance than the one that executes and reconciles jobs. Both are
   * built over the same store, so each reads what the other observed before it is persisted.
   */
  static shared(store: TripleStore, graphUri: string): LiftJobChainObservations {
    let byGraph = sharedByStore.get(store);
    if (!byGraph) {
      byGraph = new Map();
      sharedByStore.set(store, byGraph);
    }
    let observations = byGraph.get(graphUri);
    if (!observations) {
      observations = new LiftJobChainObservations();
      byGraph.set(graphUri, observations);
    }
    return observations;
  }

  /**
   * First receipt or inclusion evidence of a transaction, at the time the caller observed it.
   * The restart schema accepts finite numbers only, so nothing else is kept.
   */
  receipt(jobId: string, txHash: string, at: number): void {
    if (!txHash || !Number.isFinite(at)) return;
    const key = txHash.toLowerCase();
    if (this.entries.get(jobId)?.txHash === key) return;
    this.entries.delete(jobId);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(jobId, { txHash: key, receiptObservedAt: at });
    this.completion.receipt(jobId, key);
  }

  /** Canonical evidence at the configured confirmation depth, recorded where it is observed. */
  finality(jobId: string, txHash: string, at: number): void {
    this.receipt(jobId, txHash, at);
    const entry = this.entries.get(jobId);
    if (entry?.txHash !== txHash.toLowerCase() || !Number.isFinite(at)) return;
    entry.finalityObservedAt ??= at;
    this.completion.finality(jobId);
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
