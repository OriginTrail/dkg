/** A retry verdict is issued only before any inventory mutation was attempted. */
export type Rfc64SwmInventoryObservationVerdictV1 = void | 'retry-preparation-read';

const RETRY_DELAYS_MS = Object.freeze([100, 250, 1_000, 4_000, 10_000, 30_000, 30_000, 30_000]);
const MAX_RETRY_OBLIGATIONS = 128;

/** Process-owned post-commit observations. Each attempt separately owns its asset admission. */
export class Rfc64SwmInventoryObservationRetryV1 {
  readonly #pending = new Map<string, Promise<void>>();
  #retryOwners = 0;
  #waiting = 0;

  constructor(
    private readonly delays: readonly number[] = RETRY_DELAYS_MS,
    private readonly maxRetryOwners = MAX_RETRY_OBLIGATIONS,
  ) {}

  get size(): number { return this.#pending.size; }
  get waitingCount(): number { return this.#waiting; }

  schedule(
    key: string,
    attempt: () => Promise<Rfc64SwmInventoryObservationVerdictV1>,
    signal: AbortSignal,
    exhausted: (reason: 'attempts' | 'capacity') => void,
  ): void {
    if (signal.aborted || this.#pending.has(key)) return;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    // Reserve before invoking user work: reentrant scheduling joins this exact obligation.
    this.#pending.set(key, pending);
    void this.run(attempt, signal, exhausted).catch(() => undefined).finally(() => {
      this.#pending.delete(key);
      settle();
    });
  }

  async drain(): Promise<void> {
    await Promise.all(this.#pending.values());
  }

  private async run(
    attempt: () => Promise<Rfc64SwmInventoryObservationVerdictV1>,
    signal: AbortSignal,
    exhausted: (reason: 'attempts' | 'capacity') => void,
  ): Promise<void> {
    let ownsRetry = false;
    let retry = 0;
    try {
      while (!signal.aborted) {
        if (await attempt() !== 'retry-preparation-read' || signal.aborted) return;
        if (!ownsRetry) {
          if (this.#retryOwners >= this.maxRetryOwners) { exhausted('capacity'); return; }
          this.#retryOwners += 1;
          ownsRetry = true;
        }
        const delay = this.delays[retry++];
        if (delay === undefined) { exhausted('attempts'); return; }
        this.#waiting += 1;
        try { if (!await wait(delay, signal)) return; }
        finally { this.#waiting -= 1; }
      }
    } finally {
      if (ownsRetry) this.#retryOwners -= 1;
    }
  }
}

function wait(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (elapsed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(elapsed);
    };
    const aborted = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
