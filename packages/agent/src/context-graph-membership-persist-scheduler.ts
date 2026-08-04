// SPDX-License-Identifier: Apache-2.0

export class ContextGraphMembershipPersistQueueFullError extends Error {
  readonly code = 'CG_MEMBERSHIP_PERSIST_QUEUE_FULL';

  constructor(message: string) {
    super(message);
    this.name = 'ContextGraphMembershipPersistQueueFullError';
  }
}

export class ContextGraphMembershipPersistQueueClosedError extends Error {
  readonly code = 'CG_MEMBERSHIP_PERSIST_QUEUE_CLOSED';

  constructor() {
    super('Context-graph membership persistence is closed');
    this.name = 'ContextGraphMembershipPersistQueueClosedError';
  }
}

export class ContextGraphMembershipPersistShutdownTimeoutError extends Error {
  readonly code = 'CG_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`Context-graph membership persistence did not drain within ${timeoutMs}ms`);
    this.name = 'ContextGraphMembershipPersistShutdownTimeoutError';
  }
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

export interface ContextGraphMembershipPersistSchedulerStatus {
  closed: boolean;
  lanes: number;
  active: number;
  pending: number;
}

/**
 * Bounded keyed serialization for membership-store mutations.
 *
 * Strict operations preserve FIFO order and receive explicit backpressure.
 * Adjacent background mutations coalesce to their latest write while the
 * displaced caller settles successfully: those callers are deliberately
 * best-effort, and only the final persisted state is meaningful.
 */
export class ContextGraphMembershipPersistScheduler {
  private readonly lanes = new Map<string, PersistLane>();
  private closed = false;

  constructor(
    private readonly maxLanes = 1_000,
    private readonly maxPendingPerLane = 16,
  ) {
    if (!Number.isSafeInteger(maxLanes) || maxLanes < 1) {
      throw new Error('Membership persistence maxLanes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxPendingPerLane) || maxPendingPerLane < 1) {
      throw new Error('Membership persistence maxPendingPerLane must be a positive safe integer');
    }
  }

  enqueue(
    key: string,
    write: () => Promise<void>,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ContextGraphMembershipPersistQueueClosedError());
    }

    let lane = this.lanes.get(key);
    if (!lane) {
      if (this.lanes.size >= this.maxLanes) {
        return Promise.reject(new ContextGraphMembershipPersistQueueFullError(
          `Context-graph membership persistence reached its ${this.maxLanes}-lane limit`,
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
          reject(new ContextGraphMembershipPersistQueueFullError(
            `Context-graph membership persistence key "${key}" reached its `
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
      throw new Error('Cannot reopen context-graph membership persistence before it drains');
    }
    this.closed = false;
  }

  status(): ContextGraphMembershipPersistSchedulerStatus {
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
