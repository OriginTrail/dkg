import { mapWithConcurrency } from '../map-with-concurrency.js';
import { DEFAULT_MAX_READ_BYTES, type ProtocolOutboxEntry, type ProtocolOutboxPage, type ProtocolOutboxPageBudget } from '@origintrail-official/dkg-core';
import type { OutboxDrainOptions, OutboxDrainStats } from './outbox-drain-types.js';

export const DEFAULT_OUTBOX_DRAIN_BATCH_SIZE = 100;
export const DEFAULT_OUTBOX_DRAIN_CONCURRENCY = 4;
// Retained payloads are encoded reliable envelopes, so allow the complete
// default transport frame rather than only the SWM application payload.
export const DEFAULT_OUTBOX_DRAIN_MAX_PAYLOAD_BYTES = DEFAULT_MAX_READ_BYTES;

/** @deprecated Import MessengerOutboxDrainOptions from the package root. */
export type OutboxDrainerOptions = OutboxDrainOptions;
export type { OutboxDrainStats } from './outbox-drain-types.js';

interface ResolvedOutboxDrainerOptions {
  batchSize: number;
  concurrency: number;
  maxPayloadBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`OutboxDrainer ${name} must be a positive integer`);
  }
  return resolved;
}

/** Shutdown-safe bounded scheduler: its active promise covers every started worker. */
export class OutboxDrainer {
  private active: Promise<void> | null = null;
  private stopping = false;
  private readonly options: ResolvedOutboxDrainerOptions;
  private claimedEntries = 0;
  private claimedBytes = 0;
  private lastBatchEntries = 0;
  private lastBatchPayloadBytes = 0;
  private skippedOversizedEntriesTotal = 0;
  private byteBudgetDeferralsTotal = 0;

  constructor(
    private readonly loadDue: (now: number, budget: ProtocolOutboxPageBudget) => ProtocolOutboxPage,
    private readonly processEntry: (entry: ProtocolOutboxEntry) => Promise<void>,
    options: OutboxDrainerOptions = {},
  ) {
    this.options = {
      batchSize: positiveInteger(
        options.batchSize,
        DEFAULT_OUTBOX_DRAIN_BATCH_SIZE,
        'batchSize',
      ),
      concurrency: positiveInteger(
        options.concurrency,
        DEFAULT_OUTBOX_DRAIN_CONCURRENCY,
        'concurrency',
      ),
      maxPayloadBytes: positiveInteger(options.maxPayloadBytes, DEFAULT_OUTBOX_DRAIN_MAX_PAYLOAD_BYTES, 'maxPayloadBytes'),
    };
  }

  tick(now: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    // Publish single-flight ownership before a synchronous loader/worker can re-enter.
    const drain = Promise.resolve().then(() => this.drain(now));
    this.active = drain;
    const clearActive = (): void => {
      if (this.active === drain) this.active = null;
    };
    void drain.then(clearActive, clearActive);
    return drain;
  }

  async wait(): Promise<void> {
    await this.active;
  }

  /** Stop admitting work and join retries that had already started. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }

  getStats(): OutboxDrainStats {
    return {
      batchSize: this.options.batchSize,
      maxPayloadBytes: this.options.maxPayloadBytes,
      claimedEntries: this.claimedEntries,
      claimedBytes: this.claimedBytes,
      lastBatchEntries: this.lastBatchEntries,
      lastBatchPayloadBytes: this.lastBatchPayloadBytes,
      skippedOversizedEntriesTotal: this.skippedOversizedEntriesTotal,
      byteBudgetDeferralsTotal: this.byteBudgetDeferralsTotal,
    };
  }

  private async drain(now: number): Promise<void> {
    if (this.stopping) return;
    const page = this.loadDue(now, { maxEntries: this.options.batchSize, maxPayloadBytes: this.options.maxPayloadBytes });
    const due = page.entries;
    const payloadBytes = due.reduce((sum, entry) => sum + entry.payload.byteLength, 0);
    if (due.length > this.options.batchSize || payloadBytes > this.options.maxPayloadBytes) {
      throw new Error('Outbox store violated the count or payload-byte page budget');
    }
    if (!Number.isSafeInteger(page.skippedOversizedEntries) || page.skippedOversizedEntries < 0 || typeof page.byteBudgetExhausted !== 'boolean') {
      throw new Error('Outbox store returned invalid page outcome metadata');
    }
    this.claimedEntries = this.lastBatchEntries = due.length;
    this.claimedBytes = this.lastBatchPayloadBytes = payloadBytes;
    this.skippedOversizedEntriesTotal += page.skippedOversizedEntries;
    if (page.byteBudgetExhausted) this.byteBudgetDeferralsTotal++;
    try {
      const results = await mapWithConcurrency(
        due,
        this.options.concurrency,
        async (entry): Promise<{ failed: true; error: unknown } | undefined> => {
          if (this.stopping) return undefined;
          try {
            await this.processEntry(entry);
            return undefined;
          } catch (error) {
            return { failed: true, error };
          }
        },
      );
      const failures = results
        .filter((result): result is { failed: true; error: unknown } => result !== undefined)
        .map((result) => result.error);
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} outbox retry worker(s) failed`);
      }
    } finally {
      this.claimedEntries = 0;
      this.claimedBytes = 0;
    }
  }
}
