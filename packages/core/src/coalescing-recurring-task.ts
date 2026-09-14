// SPDX-License-Identifier: Apache-2.0

/** Shared restart-safe scheduler for periodic and coalesced workloads. */

export type CoalescingRecurringTaskPassResult =
  | 'rearm'
  | 'idle'
  | { readonly rearmAfterMs: number };

export interface CoalescingRecurringTaskOptions {
  readonly retryIntervalMs?: number;
  /** Default queues one follow-up pass; periodic owners may instead drop overlap. */
  readonly requestWhileRunning?: 'coalesce' | 'drop';
  /** Returning idle suppresses periodic rearming until the next explicit request. */
  readonly runPass: (
    signal: AbortSignal,
  ) => Promise<CoalescingRecurringTaskPassResult | void>;
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
  #closeAbortReason: Error | null = null;
  #drainAbortReason: Error | null = null;
  #suppressRearm = false;

  constructor(options: CoalescingRecurringTaskOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Read-only operational signal; the timer handle remains scheduler-owned. */
  get scheduled(): boolean {
    return this.#timer !== null;
  }

  owns(signal: AbortSignal): boolean {
    return this.#abortController?.signal === signal && !signal.aborted;
  }

  /** Admit or coalesce a pass without creating concurrent workload owners. */
  request(): boolean {
    if (this.#closed) return false;
    if (this.#run !== null && this.#options.requestWhileRunning === 'drop') return false;
    this.#requested = true;
    this.#launch();
    return true;
  }

  /** Run immediately, replacing an armed deadline with this explicit request. */
  requestNow(): boolean {
    if (this.#closed) return false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.request();
  }

  /** Schedule one initial or externally delayed request through the same timer owner. */
  schedule(delayMs = 0): boolean {
    if (this.#closed || this.#timer !== null || this.#run !== null) return false;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.request();
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
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

  /** Abort stale logical work and wait until its physical pass has retired. */
  async cancelAndDrain(reason: string): Promise<boolean> {
    if (this.#closed) return false;
    this.#requested = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const active = this.#run;
    if (active !== null) {
      const drainAbortReason = new Error(reason);
      drainAbortReason.name = 'AbortError';
      this.#drainAbortReason = drainAbortReason;
      this.#suppressRearm = true;
      this.#abortController?.abort(drainAbortReason);
      await active;
    }
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
    const closeAbortReason = new Error(this.#options.closingMessage);
    closeAbortReason.name = 'AbortError';
    this.#closeAbortReason = closeAbortReason;
    this.#abortController?.abort(closeAbortReason);
    await this.#run?.catch(() => undefined);
  }

  #launch(): void {
    if (
      this.#closed
      || this.#run !== null
      || !this.#requested
    ) return;
    let passResult: CoalescingRecurringTaskPassResult = 'rearm';
    const run = this.#drainRequestedPasses()
      .then((result) => { passResult = result; })
      // close() owns cancellation and drains the physical pass. Reporting the
      // resulting rejection as a workload failure would create a misleading
      // warning during ordinary shutdown.
      .catch((error) => {
        if (error !== this.#closeAbortReason && error !== this.#drainAbortReason) {
          this.#options.onError(error);
        }
      })
      .finally(() => {
        if (this.#run === run) this.#run = null;
        const suppressRearm = this.#suppressRearm;
        this.#suppressRearm = false;
        this.#drainAbortReason = null;
        if (this.#closed) return;
        if (suppressRearm) return;
        if (this.#requested) {
          this.#launch();
          return;
        }
        this.#requested = false;
        if (passResult === 'rearm') {
          this.#schedulePeriodicPass();
        } else if (typeof passResult === 'object') {
          this.#schedulePeriodicPass(passResult.rearmAfterMs);
        } else if (this.#timer !== null) {
          // `idle` suppresses every periodic wake-up, including one retained
          // while an explicit pass ran ahead of its existing deadline.
          clearTimeout(this.#timer);
          this.#timer = null;
        }
      });
    this.#run = run;
  }

  /** Arm one post-completion periodic deadline without postponing it for live work. */
  #schedulePeriodicPass(delayMs = this.#options.retryIntervalMs ?? 0): void {
    if (
      delayMs <= 0
      || this.#timer !== null
      || this.#closed
    ) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#options.beforePeriodicPass?.();
      this.request();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #drainRequestedPasses(): Promise<CoalescingRecurringTaskPassResult> {
    const abortController = new AbortController();
    let passResult: CoalescingRecurringTaskPassResult = 'rearm';
    this.#abortController = abortController;
    this.#running = true;
    try {
      while (
        !this.#closed
        && !abortController.signal.aborted
        && this.#requested
      ) {
        this.#requested = false;
        passResult = (await this.#options.runPass(abortController.signal)) ?? 'rearm';
      }
      return passResult;
    } finally {
      if (this.#abortController === abortController) this.#abortController = null;
      this.#running = false;
    }
  }
}
