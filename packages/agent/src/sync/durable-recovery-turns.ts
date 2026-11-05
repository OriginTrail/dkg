// SPDX-License-Identifier: Apache-2.0

/**
 * Turns at the node's durable-sync slots for graph-owned recovery.
 *
 * A node runs durable sync in few slots, often one, because that bounds memory
 * during large syncs. A recovery round whose slice finds no free slot ends at
 * once: it tries no other peer and charges no peer. Its graph then waits in a
 * line, in the order graphs were first refused, and the runner retries it:
 * - when a graph-owned slice that ran in a slot ends: the slot goes to the
 *   first graph in line whose slice the admission would take, and an owner
 *   that would continue waits at the back of the line for its next turn;
 * - after its own back-off (1 s doubling to 60 s, plus up to a quarter more),
 *   when the admission would take its slice then (for a slot that other sync
 *   work held, or another slot that frees) and no turn is being handed over.
 *   A back-off that ends while the slot is still taken counts as one more
 *   refusal, without a round.
 * So graphs take turns slice by slice, where before the first owner kept the
 * slot until its graph was complete, and a refused graph neither asks again at
 * once nor waits for a trigger once the slot is free. Slots are not all alike
 * (a selected graph may take one that background recovery may not): a graph
 * whose slice the admission would not take is passed over, and a turn that its
 * graph still cannot use goes to the first waiting owner that can use it.
 *
 * A waiting owner holds no admission. It stops waiting, and its round ends
 * deferred, when no graph-owned slice has run in a slot for
 * {@link DURABLE_RECOVERY_PARKED_IDLE_MS} and none holds a turn: other work
 * holds the slot, and the owner's callers are not kept waiting for it.
 */

/** First retry delay of a graph whose recovery found no free sync slot. */
export const DURABLE_RECOVERY_RETRY_BASE_MS = 1_000;

/** Longest retry delay. Each refusal in a row doubles the delay up to this. */
export const DURABLE_RECOVERY_RETRY_MAX_MS = 60_000;

/**
 * How long an owner waits for its next turn while no graph-owned slice runs in
 * a slot. Longer than the longest retry delay, so a refused graph that asks
 * again can take the slot first and hand it on.
 */
export const DURABLE_RECOVERY_PARKED_IDLE_MS = 2 * DURABLE_RECOVERY_RETRY_MAX_MS;

/**
 * The delay before a refused graph asks again: 1 s doubling to 60 s, plus up
 * to a quarter more so that graphs refused together do not ask in step.
 */
export function durableRecoveryRetryDelayMs(refusals: number, random: () => number = Math.random): number {
  const delay = Math.min(
    DURABLE_RECOVERY_RETRY_MAX_MS,
    DURABLE_RECOVERY_RETRY_BASE_MS * 2 ** Math.min(30, Math.max(0, refusals - 1)),
  );
  return delay + Math.floor(random() * delay / 4);
}

/** How the runner retries a graph that waits for a slot. */
export interface DurableRecoveryRetry {
  /** Start a round of the graph with the latest caller's inputs. */
  run(): void;
  /** Whether the node's admission would take a slice of the graph now: a read, nothing is claimed. */
  admissible(): boolean;
}

export interface DurableRecoveryTurnsClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  now(): number;
  random(): number;
}

const systemClock: DurableRecoveryTurnsClock = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
};

type Waiter =
  /** Its round ended without a slot. The runner retries it. */
  | { readonly state: 'deferred'; readonly refusals: number; retry: DurableRecoveryRetry; timer: unknown }
  /** An owner that handed its slot over and waits to continue. */
  | {
    readonly state: 'parked';
    readonly refusals: number;
    readonly retry: DurableRecoveryRetry;
    readonly resume: (turn: boolean) => void;
    timer: unknown;
  }
  /**
   * Given a turn: with a slot that a slice released, or by its own back-off
   * (`retried`), which hands it no slot. It keeps its place until its slice
   * runs or is refused, or its round ends.
   */
  | { readonly state: 'woken'; readonly refusals: number; readonly retried?: true };

export class DurableRecoveryTurns {
  private readonly clock: DurableRecoveryTurnsClock;

  /** Waiting graphs in the order they first waited, which is the order of turns. */
  private readonly line = new Map<string, Waiter>();

  /** Graphs that hold a turn: a slice of theirs runs, or they were given the slot and have not used it yet. */
  private readonly holders = new Set<string>();

  /** Graphs given a turn whose slice has not started yet: no retry may take the slot from them meanwhile. */
  private readonly handingOver = new Set<string>();

  /** When a graph-owned slice last ran in a slot. */
  private lastRanAt: number;

  constructor(clock: Partial<DurableRecoveryTurnsClock> = {}) {
    this.clock = { ...systemClock, ...clock };
    this.lastRanAt = this.clock.now();
  }

  /** True while the graph waits for a slot and no owner runs for it: a new round would be deferred at once. */
  isDeferred(contextGraphId: string): boolean {
    return this.line.get(contextGraphId)?.state === 'deferred';
  }

  /** A later caller's inputs for the retry of a deferred graph. */
  setRetry(contextGraphId: string, retry: DurableRecoveryRetry): void {
    const waiter = this.line.get(contextGraphId);
    if (waiter?.state === 'deferred') waiter.retry = retry;
  }

  /** A slice of the graph starts: the graph holds a turn. */
  sliceStarting(contextGraphId: string): void {
    this.holders.add(contextGraphId);
    this.handingOver.delete(contextGraphId);
  }

  /** The graph's slice ran in a slot, so the graph no longer waits. It keeps its turn. */
  sliceRan(contextGraphId: string): void {
    this.lastRanAt = this.clock.now();
    this.leaveLine(contextGraphId);
  }

  /**
   * The graph's slice found no free slot: it keeps its place in line, or joins
   * the back, and asks again after its back-off. A slot it was handed and could
   * not use goes to the first waiting owner whose slice the admission would
   * take; refused graphs ask again only after their own back-off.
   */
  refused(contextGraphId: string, retry: DurableRecoveryRetry): void {
    const waiter = this.line.get(contextGraphId);
    const handedSlot = waiter?.state === 'woken' && !waiter.retried;
    this.holders.delete(contextGraphId);
    this.handingOver.delete(contextGraphId);
    this.defer(contextGraphId, (waiter?.refusals ?? 0) + 1, retry);
    if (handedSlot) this.wakeFirst((candidate) => candidate.state === 'parked');
  }

  /**
   * The graph's owner ran a slice in a slot and would run another. While other
   * graphs wait, the slot goes to the first of them and the owner waits at the
   * back of the line. Resolves `true` on the owner's next turn, and `false`
   * when it stopped waiting, its graph then waiting as a refused one, or when
   * `stop` (the node's stop signal) fires; its round then ends deferred.
   */
  handOver(contextGraphId: string, retry: DurableRecoveryRetry, stop?: AbortSignal): Promise<boolean> {
    if (stop?.aborted) return Promise.resolve(false);
    // No graph waits whose slice the admission would take: the owner keeps its turn.
    const next = this.first();
    if (next === undefined) return Promise.resolve(true);
    this.holders.delete(contextGraphId);
    const turn = new Promise<boolean>((resolve) => {
      const onStop = () => {
        if (this.line.get(contextGraphId)?.state !== 'parked') return;
        this.leaveLine(contextGraphId);
        resolve(false);
      };
      stop?.addEventListener('abort', onStop, { once: true });
      const resume = (next: boolean) => {
        stop?.removeEventListener('abort', onStop);
        resolve(next);
      };
      this.line.set(contextGraphId, {
        state: 'parked', refusals: 0, retry, resume, timer: this.parkedTimer(contextGraphId, DURABLE_RECOVERY_PARKED_IDLE_MS),
      });
    });
    this.wake(next[0], next[1], {});
    return turn;
  }

  /**
   * The graph's round ended. A turn it still holds goes to the first graph in
   * line whose slice the admission would take. A graph that asked again on its
   * own and used no slot hands nothing on.
   */
  roundEnded(contextGraphId: string): void {
    this.handingOver.delete(contextGraphId);
    if (!this.holders.delete(contextGraphId)) return;
    const waiter = this.line.get(contextGraphId);
    if (waiter?.state === 'woken') this.leaveLine(contextGraphId);
    if (waiter?.state !== 'woken' || !waiter.retried) this.wakeFirst();
  }

  private defer(contextGraphId: string, refusals: number, retry: DurableRecoveryRetry): void {
    this.clearWaiterTimer(contextGraphId);
    // Setting an existing key keeps its place in the line.
    this.line.set(contextGraphId, {
      state: 'deferred', refusals, retry, timer: this.retryTimer(contextGraphId, refusals),
    });
  }

  private retryTimer(contextGraphId: string, refusals: number): unknown {
    return this.clock.setTimeout(() => {
      const waiter = this.line.get(contextGraphId);
      if (waiter?.state !== 'deferred') return;
      // A turn handed over is not raced for: ask again after the same delay.
      if (this.handingOver.size > 0) waiter.timer = this.retryTimer(contextGraphId, refusals);
      else if (!waiter.retry.admissible()) this.defer(contextGraphId, refusals + 1, waiter.retry);
      else this.wake(contextGraphId, waiter, { retried: true });
    }, durableRecoveryRetryDelayMs(refusals, this.clock.random));
  }

  private parkedTimer(contextGraphId: string, ms: number): unknown {
    return this.clock.setTimeout(() => {
      const waiter = this.line.get(contextGraphId);
      if (waiter?.state !== 'parked') return;
      const idleMs = this.clock.now() - this.lastRanAt;
      if (this.holders.size > 0 || idleMs < DURABLE_RECOVERY_PARKED_IDLE_MS) {
        waiter.timer = this.parkedTimer(
          contextGraphId,
          this.holders.size > 0 ? DURABLE_RECOVERY_PARKED_IDLE_MS : DURABLE_RECOVERY_PARKED_IDLE_MS - idleMs,
        );
        return;
      }
      this.defer(contextGraphId, waiter.refusals + 1, waiter.retry);
      waiter.resume(false);
    }, ms);
  }

  /** The first waiting graph, in line order, that `eligible` admits and whose slice the admission would take. */
  private first(
    eligible: (waiter: Exclude<Waiter, { state: 'woken' }>) => boolean = () => true,
  ): [string, Exclude<Waiter, { state: 'woken' }>] | undefined {
    for (const [contextGraphId, waiter] of this.line) {
      if (waiter.state !== 'woken' && eligible(waiter) && waiter.retry.admissible()) return [contextGraphId, waiter];
    }
    return undefined;
  }

  private wakeFirst(eligible?: (waiter: Exclude<Waiter, { state: 'woken' }>) => boolean): void {
    const next = this.first(eligible);
    if (next !== undefined) this.wake(next[0], next[1], {});
  }

  private wake(
    contextGraphId: string,
    waiter: Exclude<Waiter, { state: 'woken' }>,
    turn: { readonly retried?: true },
  ): void {
    this.clock.clearTimeout(waiter.timer);
    this.line.set(contextGraphId, { state: 'woken', refusals: waiter.refusals, ...turn });
    this.holders.add(contextGraphId);
    this.handingOver.add(contextGraphId);
    if (waiter.state === 'parked') waiter.resume(true);
    else waiter.retry.run();
  }

  private leaveLine(contextGraphId: string): void {
    this.clearWaiterTimer(contextGraphId);
    this.line.delete(contextGraphId);
  }

  private clearWaiterTimer(contextGraphId: string): void {
    const waiter = this.line.get(contextGraphId);
    if (waiter && waiter.state !== 'woken') this.clock.clearTimeout(waiter.timer);
  }
}
