// SPDX-License-Identifier: Apache-2.0

export const RFC64_CATALOG_AUTHORITY_REFRESH_INTERVAL_MS_V1 = 5 * 60_000;

export interface Rfc64CatalogAuthorityRefreshSchedulerV1 {
  setInterval(
    callback: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

/** Production cadence boundary; exposed so lifecycle tests can replace only this timer. */
export const rfc64CatalogAuthorityRefreshSchedulerV1:
  Rfc64CatalogAuthorityRefreshSchedulerV1 = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer);
  },
};

export interface Rfc64CatalogAuthorityRefreshLoopOptionsV1 {
  readonly readActiveContextGraphIds: () => readonly string[];
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly intervalMs?: number;
}

/** One bounded recurring authority pass with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #closed = false;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
    this.#intervalMs = options.intervalMs
      ?? RFC64_CATALOG_AUTHORITY_REFRESH_INTERVAL_MS_V1;
  }

  start(): void {
    if (this.#closed) {
      throw new Error('RFC-64 catalog authority refresh loop is closed');
    }
    if (this.#timer !== null) return;
    this.#timer = this.#scheduler.setInterval(this.trigger, this.#intervalMs);
  }

  readonly trigger = (): void => {
    if (this.#closed || this.#inFlight !== null) return;
    const controller = new AbortController();
    this.#controller = controller;
    const run = (async (): Promise<void> => {
      // Sequential refresh is an intentional global bound. A large Core
      // responsibility set cannot turn one timer tick into an RPC burst,
      // and a later tick coalesces while this pass is still running.
      for (const contextGraphId of this.options.readActiveContextGraphIds()) {
        try {
          await this.options.refreshContextGraph(contextGraphId, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) {
            this.options.onRefreshFailure(contextGraphId, error);
          }
        }
      }
    })();
    this.#inFlight = run;
    void run.finally(() => {
      if (this.#inFlight === run) {
        this.#inFlight = null;
        this.#controller = null;
      }
    }).catch(() => undefined);
  };

  close(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#controller?.abort(reason);
  }
}
