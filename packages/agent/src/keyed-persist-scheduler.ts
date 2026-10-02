// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration for a {@link KeyedPersistScheduler}. Each persistence domain
 * (membership, subscription, ...) supplies its own bounds and typed errors so a
 * caller can still branch on `instanceof` and on the stable error `code`.
 */
export interface KeyedPersistSchedulerOptions {
  /**
   * Lower-case noun phrase naming the domain, for example
   * `context-graph membership persistence`. It appears in bound and reopen
   * error messages.
   */
  readonly label: string;
  /** Distinct keys that may hold a lane at once. */
  readonly maxLanes: number;
  /** Writes one key may hold pending behind its active write. */
  readonly maxPendingPerLane: number;
  /** Builds the rejection for a lane or pending-write bound. */
  readonly queueFullError: (message: string) => Error;
  /** Builds the rejection for admission after {@link KeyedPersistScheduler.closeAndDrain}. */
  readonly queueClosedError: () => Error;
}

interface PendingWrite {
  strict: boolean;
  write: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PersistLane {
  active: boolean;
  pending: PendingWrite[];
  drained: Promise<void>;
  resolveDrained: () => void;
}

export interface KeyedPersistSchedulerStatus {
  closed: boolean;
  lanes: number;
  active: number;
  pending: number;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Bounded keyed serialization for persistent-store mutations.
 *
 * Writes for one key run one at a time in arrival order; writes for different
 * keys run concurrently. That is what lets a task on key A enqueue and await a
 * task on key B, on this scheduler or another, without deadlocking.
 *
 * Strict operations preserve FIFO order and receive explicit backpressure.
 * Adjacent background mutations coalesce to their latest write while the
 * displaced caller settles successfully: those callers are deliberately
 * best-effort, and only the final persisted state is meaningful.
 *
 * A write that rejects settles only its own caller. The lane keeps draining,
 * so one failed write never stalls or poisons the next one for that key.
 *
 * `closeAndDrain()` fences admission synchronously and resolves once every
 * admitted write, including those still pending, has physically settled.
 * `reopen()` admits new work again after a drain.
 */
export class KeyedPersistScheduler {
  private readonly lanes = new Map<string, PersistLane>();
  private readonly label: string;
  private readonly maxLanes: number;
  private readonly maxPendingPerLane: number;
  private readonly queueFullError: (message: string) => Error;
  private readonly queueClosedError: () => Error;
  private closed = false;

  constructor(options: KeyedPersistSchedulerOptions) {
    this.label = options.label;
    this.maxLanes = options.maxLanes;
    this.maxPendingPerLane = options.maxPendingPerLane;
    this.queueFullError = options.queueFullError;
    this.queueClosedError = options.queueClosedError;
    if (!Number.isSafeInteger(this.maxLanes) || this.maxLanes < 1) {
      throw new Error(`${capitalize(this.label)} maxLanes must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(this.maxPendingPerLane) || this.maxPendingPerLane < 1) {
      throw new Error(`${capitalize(this.label)} maxPendingPerLane must be a positive safe integer`);
    }
  }

  enqueue(
    key: string,
    write: () => Promise<void>,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.queueClosedError());
    }

    let lane = this.lanes.get(key);
    if (!lane) {
      if (this.lanes.size >= this.maxLanes) {
        return Promise.reject(this.queueFullError(
          `${capitalize(this.label)} reached its ${this.maxLanes}-lane limit`,
        ));
      }
      let resolveDrained!: () => void;
      const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
      lane = { active: false, pending: [], drained, resolveDrained };
      this.lanes.set(key, lane);
    }

    const strict = options.strict === true;
    return new Promise<void>((resolve, reject) => {
      const tail = lane!.pending.at(-1);
      if (!strict && tail && !tail.strict) {
        tail.resolve();
        lane!.pending[lane!.pending.length - 1] = { strict, write, resolve, reject };
      } else {
        if (lane!.pending.length >= this.maxPendingPerLane) {
          reject(this.queueFullError(
            `${capitalize(this.label)} key "${key}" reached its `
            + `${this.maxPendingPerLane}-write pending limit`,
          ));
          return;
        }
        lane!.pending.push({ strict, write, resolve, reject });
      }
      if (!lane!.active) {
        lane!.active = true;
        void this.runLane(key, lane!);
      }
    });
  }

  closeAndDrain(): Promise<void> {
    this.closed = true;
    return Promise.all([...this.lanes.values()].map((lane) => lane.drained)).then(() => undefined);
  }

  reopen(): void {
    if (this.lanes.size > 0) {
      throw new Error(`Cannot reopen ${this.label} before it drains`);
    }
    this.closed = false;
  }

  /** True while `key` has an active or pending write. */
  hasLane(key: string): boolean {
    return this.lanes.has(key);
  }

  status(): KeyedPersistSchedulerStatus {
    let active = 0;
    let pending = 0;
    for (const lane of this.lanes.values()) {
      if (lane.active) active += 1;
      pending += lane.pending.length;
    }
    return { closed: this.closed, lanes: this.lanes.size, active, pending };
  }

  private async runLane(key: string, lane: PersistLane): Promise<void> {
    while (lane.pending.length > 0) {
      const operation = lane.pending.shift()!;
      try {
        await operation.write();
        operation.resolve();
      } catch (error) {
        operation.reject(error);
      }
    }
    lane.active = false;
    if (this.lanes.get(key) === lane) this.lanes.delete(key);
    lane.resolveDrained();
  }
}

/**
 * Resolves `true` when `drain` settles within `timeoutMs`, `false` when the
 * timer wins. The timer is unref'd and always cleared, so it never holds the
 * process open and never outlives the race.
 */
export async function drainsWithin(drain: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([drain.then(() => true as const), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
