export const FINALIZATION_RECOVERY_WORKER_BATCH_SIZE = 16;
export const FINALIZATION_RECOVERY_WORKER_POLL_INTERVAL_MS = 5_000;

interface FinalizationRecoveryWorkerLog {
  info(message: string): void;
  warn(message: string): void;
}

interface FinalizationRecoveryWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
}

/**
 * Lifecycle-owned asynchronous retry loop for the durable finalization inbox.
 *
 * SQLite reads are batched, while graph materialization remains serial inside
 * `processDueBatch`. This is an I/O scheduler on the Node.js event loop, not a
 * worker thread: it never blocks startup and never introduces concurrent
 * Blazegraph finalization writes.
 */
export class FinalizationRecoveryWorker {
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(
    private readonly processDueBatch: (limit: number) => Promise<number>,
    private readonly log: FinalizationRecoveryWorkerLog,
    options: FinalizationRecoveryWorkerOptions = {},
  ) {
    this.#batchSize = Math.max(
      1,
      Math.trunc(options.batchSize ?? FINALIZATION_RECOVERY_WORKER_BATCH_SIZE),
    );
    this.#pollIntervalMs = Math.max(
      1,
      Math.trunc(
        options.pollIntervalMs ?? FINALIZATION_RECOVERY_WORKER_POLL_INTERVAL_MS,
      ),
    );
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (!this.#running || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#running) return;
      const run = this.runBatch();
      this.#inFlight = run;
      void run.finally(() => {
        if (this.#inFlight === run) this.#inFlight = undefined;
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  private async runBatch(): Promise<void> {
    let selected = 0;
    try {
      selected = await this.processDueBatch(this.#batchSize);
      if (selected > 0) {
        this.log.info(
          `Finalization recovery worker inspected ${selected} due inbox entr`
            + `${selected === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch (error) {
      this.log.warn(
        `Finalization recovery worker batch failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (this.#running) {
        // A full durable-inbox batch means that more historical work is
        // probably ready, but it must not turn this maintenance worker into a
        // zero-delay loop. Each item may perform several chain reads and store
        // operations. Yielding for the normal poll interval preserves capacity
        // for foreground publish, selected sync, and exact VM recovery work.
        this.schedule(this.#pollIntervalMs);
      }
    }
  }
}
