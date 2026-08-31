// SPDX-License-Identifier: Apache-2.0

/** Shared restart-safe scheduler for RFC-64 periodic and coalesced workloads. */

export interface Rfc64CoalescingSupervisorOptionsV1 {
  readonly retryIntervalMs?: number;
  readonly runPass: (signal: AbortSignal) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly beforePeriodicPass?: () => void;
  readonly closingMessage: string;
}

export class Rfc64CoalescingSupervisorV1 {
  readonly #options: Rfc64CoalescingSupervisorOptionsV1;
  #closed = false;
  #requested = false;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #abortController: AbortController | null = null;
  #run: Promise<void> | null = null;

  constructor(options: Rfc64CoalescingSupervisorOptionsV1) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Admit or coalesce a pass without creating concurrent workload owners. */
  request(): boolean {
    if (this.#closed) return false;
    this.#requested = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#launch();
    return true;
  }

  /** Abort a stale active pass and guarantee one fresh pass afterward. */
  invalidateAndRequest(reason: string): boolean {
    if (this.#closed) return false;
    this.#requested = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#abortController?.abort(new Error(reason));
    this.#launch();
    return true;
  }

  async whenIdle(): Promise<void> {
    while (this.#run !== null) {
      const current = this.#run;
      await current;
      if (this.#run === current) return;
    }
  }

  /** Fence new work, abort the active pass, and await physical retirement. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#requested = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#abortController?.abort(new Error(this.#options.closingMessage));
    await this.#run?.catch(() => undefined);
  }

  #launch(): void {
    if (this.#closed || this.#run !== null || !this.#requested) return;
    const run = this.#drainRequestedPasses()
      .catch(this.#options.onError)
      .finally(() => {
        if (this.#run === run) this.#run = null;
        if (this.#closed) return;
        if (this.#requested) {
          this.#launch();
          return;
        }
        const retryIntervalMs = this.#options.retryIntervalMs ?? 0;
        if (retryIntervalMs > 0) {
          this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#options.beforePeriodicPass?.();
            this.request();
          }, retryIntervalMs);
          this.#timer.unref?.();
        }
      });
    this.#run = run;
  }

  async #drainRequestedPasses(): Promise<void> {
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#running = true;
    try {
      while (!this.#closed && !abortController.signal.aborted && this.#requested) {
        this.#requested = false;
        await this.#options.runPass(abortController.signal);
      }
    } finally {
      if (this.#abortController === abortController) this.#abortController = null;
      this.#running = false;
    }
  }
}
