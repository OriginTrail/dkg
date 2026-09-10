/** Scheduler-owned bounds for one Universal Messenger outbox drain. */
export interface OutboxDrainOptions {
  batchSize?: number;
  concurrency?: number;
  maxPayloadBytes?: number;
}

/** Fixed-cardinality state owned by the in-process outbox scheduler. */
export interface OutboxDrainStats {
  batchSize: number;
  maxPayloadBytes: number;
  /** Bytes/entries reserved by the active in-process page, not a durable lease. */
  claimedEntries: number;
  claimedBytes: number;
  lastBatchEntries: number;
  lastBatchPayloadBytes: number;
  /** Repeated skips of the same oversized row are counted once per observed page. */
  skippedOversizedEntriesTotal: number;
  byteBudgetDeferralsTotal: number;
}
