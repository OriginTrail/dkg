import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Shutdown-safe bounded scheduler: its active promise covers every started worker. */
export class OutboxDrainer<T> {
  private active: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly loadDue: (now: number, limit: number) => readonly T[],
    private readonly processEntry: (entry: T) => Promise<void>,
    private readonly options: { batchSize: number; concurrency: number },
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new RangeError('OutboxDrainer batchSize must be a positive integer');
    }
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new RangeError('OutboxDrainer concurrency must be a positive integer');
    }
  }

  tick(now: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    const drain = this.drain(now);
    this.active = drain;
    void drain.finally(() => {
      if (this.active === drain) this.active = null;
    }).catch(() => {});
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

  private async drain(now: number): Promise<void> {
    const due = this.loadDue(now, this.options.batchSize).slice(0, this.options.batchSize);
    const outcomes = await mapWithConcurrency(due, this.options.concurrency, async (entry) => {
      if (this.stopping) return undefined;
      try {
        await this.processEntry(entry);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    const failures = outcomes.filter((error) => error !== undefined);
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} outbox retry worker(s) failed`);
    }
  }
}
