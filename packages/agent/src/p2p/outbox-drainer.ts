import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Shutdown-safe bounded scheduler: its active promise covers every started worker. */
export class OutboxDrainer<T> {
  private active: Promise<void> | null = null;

  constructor(
    private readonly loadDue: (now: number, limit: number) => readonly T[],
    private readonly processEntry: (entry: T) => Promise<void>,
    private readonly batchSize: number,
    private readonly concurrency: number,
  ) {}

  tick(now: number): Promise<void> {
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

  private async drain(now: number): Promise<void> {
    const due = this.loadDue(now, this.batchSize);
    const outcomes = await mapWithConcurrency(due, this.concurrency, async (entry) => {
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
