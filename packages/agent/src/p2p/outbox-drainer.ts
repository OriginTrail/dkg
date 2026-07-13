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
    const failures: unknown[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopping) {
        const index = cursor++;
        if (index >= due.length) return;
        try {
          await this.processEntry(due[index]);
        } catch (error) {
          failures.push(error);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.options.concurrency, due.length) },
        () => worker(),
      ),
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} outbox retry worker(s) failed`);
    }
  }
}
