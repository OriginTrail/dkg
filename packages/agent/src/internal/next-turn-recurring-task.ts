// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — a recurring task whose requested pass can start one turn of the event loop after the
 * request, not on the requester's stack.
 *
 * `CoalescingRecurringTask.request()` launches an idle task at once: the pass runs up to its
 * first await inside the call. For the finalized-private supervisor that is the listing of every
 * durable marker and the start of the first repair, on the stack of the publication that asked
 * for a placement. `requestNextTurn()` admits or coalesces the same pass and starts it one turn
 * later. The start that is pending belongs to this task: `whenIdle` waits for it and `close`
 * cancels it, so nothing is left to fire after the task is closed.
 */
import type { CoalescingRecurringTask } from '../coalescing-recurring-task.js';

// Taken at load: a start one turn later is a turn of the loop, not a timer for a fake clock to hold.
const nextTurn = setImmediate;
const cancelNextTurn = clearImmediate;

interface PendingStartV1 {
  readonly handle: ReturnType<typeof setImmediate>;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export class NextTurnRecurringTaskV1 {
  readonly #task: CoalescingRecurringTask;
  #pendingStart: PendingStartV1 | null = null;

  constructor(task: CoalescingRecurringTask) {
    this.#task = task;
  }

  get running(): boolean {
    return this.#task.running;
  }

  get closed(): boolean {
    return this.#task.closed;
  }

  /** Admit or coalesce a pass; an idle task starts it inside this call. */
  request(): boolean {
    return this.#task.request();
  }

  /** Arm one delayed pass, unless a pass is active or a deadline is armed already. */
  schedule(delayMs: number): boolean {
    return this.#task.schedule(delayMs);
  }

  /**
   * Admit or coalesce a pass that starts one turn later; false only for a closed task. A pass
   * that is active coalesces the request at once, which starts nothing on the caller's stack.
   */
  requestNextTurn(): boolean {
    if (this.#task.closed) return false;
    if (this.#task.running) return this.#task.request();
    if (this.#pendingStart === null) {
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const handle = nextTurn(() => {
        this.#pendingStart = null;
        try {
          this.#task.request();
        } finally {
          settle();
        }
      });
      this.#pendingStart = { handle, settled, settle };
    }
    return true;
  }

  /** Resolves once no start is pending and no pass is active. */
  async whenIdle(): Promise<void> {
    do {
      while (this.#pendingStart !== null) await this.#pendingStart.settled;
      await this.#task.whenIdle();
    } while (this.#pendingStart !== null);
  }

  /** Cancel a start that is pending, then fence, abort and drain the task. */
  async close(): Promise<void> {
    const pending = this.#pendingStart;
    if (pending !== null) {
      this.#pendingStart = null;
      cancelNextTurn(pending.handle);
      pending.settle();
    }
    await this.#task.close();
  }
}
