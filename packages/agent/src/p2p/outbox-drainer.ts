import { mapWithConcurrency } from '../map-with-concurrency.js';

export const DEFAULT_OUTBOX_DRAIN_BATCH_SIZE = 100;
export const DEFAULT_OUTBOX_DRAIN_CONCURRENCY = 4;

export interface OutboxDrainerOptions {
  batchSize?: number;
  concurrency?: number;
}

interface ResolvedOutboxDrainerOptions {
  batchSize: number;
  concurrency: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`OutboxDrainer ${name} must be a positive integer`);
  }
  return resolved;
}

/** Shutdown-safe bounded scheduler: its active promise covers every started worker. */
export class OutboxDrainer<T> {
  private active: Promise<void> | null = null;
  private stopping = false;
  private readonly options: ResolvedOutboxDrainerOptions;

  constructor(
    private readonly loadDue: (now: number, limit: number) => readonly T[],
    private readonly processEntry: (entry: T) => Promise<void>,
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
    };
  }

  tick(now: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    const drain = this.drain(now);
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

  private async drain(now: number): Promise<void> {
    const due = this.loadDue(now, this.options.batchSize).slice(0, this.options.batchSize);
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
  }
}
