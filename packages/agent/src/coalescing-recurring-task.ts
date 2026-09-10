// SPDX-License-Identifier: Apache-2.0

/** Shared restart-safe scheduler for periodic and coalesced workloads. */

export interface CoalescingRecurringTaskOptions {
  readonly retryIntervalMs?: number;
  /** Default queues one follow-up pass; periodic owners may instead drop overlap. */
  readonly requestWhileRunning?: 'coalesce' | 'drop';
  /** A false result retires the periodic loop until an owner requests it again. */
  readonly shouldRun?: () => boolean;
  readonly runPass: (signal: AbortSignal) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly beforePeriodicPass?: () => void;
  readonly closingMessage: string;
}

/** Owns one cancellable pass, coalescing, periodic scheduling, and physical drain. */
export class CoalescingRecurringTask {
  readonly #options: CoalescingRecurringTaskOptions;
  #closed = false;
  #requested = false;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #abortController: AbortController | null = null;
  #run: Promise<void> | null = null;

  constructor(options: CoalescingRecurringTaskOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  get closed(): boolean {
    return this.#closed;
  }

  owns(signal: AbortSignal): boolean {
    return this.#abortController?.signal === signal && !signal.aborted;
  }

  /** Admit or coalesce a pass without creating concurrent workload owners. */
  request(): boolean {
    if (this.#closed || this.#options.shouldRun?.() === false) return false;
    if (this.#run !== null && this.#options.requestWhileRunning === 'drop') return false;
    this.#requested = true;
    this.#launch();
    return true;
  }

  /** Schedule one initial or externally delayed request through the same timer owner. */
  schedule(delayMs = 0): boolean {
    if (
      this.#closed
      || this.#timer !== null
      || this.#run !== null
      || this.#options.shouldRun?.() === false
    ) return false;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.request();
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
    return true;
  }

  /** Abort a stale active pass and guarantee one fresh pass afterward. */
  invalidateAndRequest(reason: string): boolean {
    if (this.#closed || this.#options.shouldRun?.() === false) return false;
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
    if (
      this.#closed
      || this.#run !== null
      || !this.#requested
      || this.#options.shouldRun?.() === false
    ) return;
    const run = this.#drainRequestedPasses()
      .catch(this.#options.onError)
      .finally(() => {
        if (this.#run === run) this.#run = null;
        if (this.#closed) return;
        if (this.#requested && this.#options.shouldRun?.() !== false) {
          this.#launch();
          return;
        }
        this.#requested = false;
        this.#schedulePeriodicPass();
      });
    this.#run = run;
  }

  /** Arm one post-completion periodic deadline without postponing it for live work. */
  #schedulePeriodicPass(): void {
    const retryIntervalMs = this.#options.retryIntervalMs ?? 0;
    if (
      retryIntervalMs <= 0
      || this.#timer !== null
      || this.#closed
      || this.#options.shouldRun?.() === false
    ) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#options.beforePeriodicPass?.();
      this.request();
    }, retryIntervalMs);
    this.#timer.unref?.();
  }

  async #drainRequestedPasses(): Promise<void> {
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#running = true;
    try {
      while (
        !this.#closed
        && !abortController.signal.aborted
        && this.#requested
        && this.#options.shouldRun?.() !== false
      ) {
        this.#requested = false;
        await this.#options.runPass(abortController.signal);
      }
    } finally {
      if (this.#abortController === abortController) this.#abortController = null;
      this.#running = false;
    }
  }
}
