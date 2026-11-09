// SPDX-License-Identifier: Apache-2.0

/**
 * The gateway's turns (OT-RFC-27): calls on one budget run one at a time, and
 * wait for their turn in a queue of bounded length; the gateway as a whole
 * takes a bounded number of calls at once, from their first chain read,
 * running or waiting. A call that would pass either bound is refused at once,
 * and a call whose client goes away while it waits leaves the queue, so its
 * turn is never taken.
 *
 * Every call that waits holds one of the daemon's in-flight request slots,
 * which loopback clients share with every other route: the bounds keep the
 * gateway's share of them small, whatever its clients send.
 */

/** A call refused because its budget's queue, or the gateway, has no room. */
export class TurnsFull extends Error {
  constructor(readonly scope: 'budget' | 'gateway') {
    super(scope === 'budget' ? 'too many calls wait on this budget' : 'the gateway takes no more calls now');
    this.name = 'TurnsFull';
  }
}

/** A call whose client went away before its turn came. */
export class CallerGone extends Error {
  constructor() {
    super('the client went away before its call was sent');
    this.name = 'CallerGone';
  }
}

export interface TurnLimits {
  /** Calls that may wait on one budget while one of its calls runs. */
  waitingPerKey: number;
  /** Calls the gateway takes at once, running or waiting, over every budget. */
  calls: number;
}

export const DEFAULT_TURN_LIMITS: Readonly<TurnLimits> = Object.freeze({ waitingPerKey: 4, calls: 16 });

type Waiter = { start: () => void };

export class Turns {
  private readonly queues = new Map<string, Waiter[]>();
  /** The keys with a call running. */
  private readonly running = new Set<string>();
  /** Calls taken, running or waiting. */
  private taken = 0;

  constructor(private readonly limits: TurnLimits = DEFAULT_TURN_LIMITS) {}

  /** Calls with a place in the gateway, reading the chain, waiting or running. */
  get size(): number {
    return this.taken;
  }

  /** Calls waiting for their turn, over every key. */
  get waiting(): number {
    let n = 0;
    for (const queue of this.queues.values()) n += queue.length;
    return n;
  }

  /**
   * Run `fn` with a place in the gateway, refused with `TurnsFull('gateway')`
   * when the gateway has as many calls as it takes. A call takes its place
   * before its first chain read, so a slow chain holds no more calls than that.
   */
  async admit<R>(fn: () => Promise<R>): Promise<R> {
    if (this.taken >= this.limits.calls) throw new TurnsFull('gateway');
    this.taken++;
    try {
      return await fn();
    } finally {
      this.taken--;
    }
  }

  /**
   * Within a place in the gateway, run `fn` once every call queued on `key`
   * before it has run. Refused with `TurnsFull('budget')` when the queue has no
   * room, and with `CallerGone` when `signal` aborts before its turn comes.
   */
  async turn<R>(key: string, fn: () => Promise<R>, signal?: AbortSignal): Promise<R> {
    if (signal?.aborted) throw new CallerGone();
    const busy = this.running.has(key);
    if (busy && (this.queues.get(key)?.length ?? 0) >= this.limits.waitingPerKey) throw new TurnsFull('budget');
    if (busy) await this.turnOf(key, signal);
    else this.running.add(key);
    try {
      return await fn();
    } finally {
      this.pass(key);
    }
  }

  /** A place in the gateway, then the turn on `key`. */
  async run<R>(key: string, fn: () => Promise<R>, signal?: AbortSignal): Promise<R> {
    if (signal?.aborted) throw new CallerGone();
    return this.admit(() => this.turn(key, fn, signal));
  }

  /** Wait in `key`'s queue until the call before it passes the turn on, or leave it when `signal` aborts first. */
  private turnOf(key: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener('abort', leave);
          resolve();
        },
      };
      const leave = () => {
        const queue = this.queues.get(key);
        const at = queue?.indexOf(waiter) ?? -1;
        // Already given the turn: the call runs, and checks its client itself.
        if (!queue || at < 0) return;
        queue.splice(at, 1);
        if (queue.length === 0) this.queues.delete(key);
        reject(new CallerGone());
      };
      signal?.addEventListener('abort', leave, { once: true });
      const queue = this.queues.get(key) ?? [];
      queue.push(waiter);
      this.queues.set(key, queue);
    });
  }

  /** The turn on `key` passes to the next call waiting, or ends. */
  private pass(key: string): void {
    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.queues.delete(key);
    if (next) next.start();
    else this.running.delete(key);
  }
}
