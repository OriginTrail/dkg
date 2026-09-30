// SPDX-License-Identifier: Apache-2.0

import { KeyedPersistScheduler } from './keyed-persist-scheduler.js';

export class ContextGraphSubscriptionPersistQueueFullError extends Error {
  readonly code = 'CG_SUBSCRIPTION_PERSIST_QUEUE_FULL';

  constructor(message: string) {
    super(message);
    this.name = 'ContextGraphSubscriptionPersistQueueFullError';
  }
}

export class ContextGraphSubscriptionPersistQueueClosedError extends Error {
  readonly code = 'CG_SUBSCRIPTION_PERSIST_QUEUE_CLOSED';

  constructor() {
    super('Context-graph subscription persistence is closed');
    this.name = 'ContextGraphSubscriptionPersistQueueClosedError';
  }
}

export const CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE =
  'CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT';

export class ContextGraphSubscriptionPersistShutdownTimeoutError extends Error {
  readonly code = CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE;

  constructor(timeoutMs: number) {
    super(`Context-graph subscription persistence did not drain within ${timeoutMs}ms`);
    this.name = 'ContextGraphSubscriptionPersistShutdownTimeoutError';
  }
}

/**
 * Subscription persistence was an unbounded promise chain before it moved onto
 * the shared scheduler, and a rejected write here is a durable record that is
 * silently not saved. These bounds are therefore memory backstops for a wedged
 * store, sized far above any burst a healthy node produces (one lane per
 * context graph with a write in flight, a handful of writes per lane).
 * Membership's 1 000-lane and 16-write bounds are tuned for backpressure and
 * would reject writes the chain used to accept.
 */
export const CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_MAX_LANES = 100_000;
export const CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_MAX_PENDING_PER_LANE = 4_096;

/**
 * Keyed serialization for context-graph subscription store writes: a
 * {@link KeyedPersistScheduler} keyed on `contextGraphId`.
 *
 * Every write is strict. Subscription callers await each write and rely on it
 * running: a strict join or cursor snapshot re-checks its generation inside the
 * write, `clearContextGraphSubscriptions` counts a delete only when it ran, and
 * rehydration status follows a record that was actually saved. Coalescing a
 * displaced write would settle its caller successfully without any of that.
 */
export class ContextGraphSubscriptionPersistScheduler extends KeyedPersistScheduler {
  constructor(
    maxLanes = CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_MAX_LANES,
    maxPendingPerLane = CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_MAX_PENDING_PER_LANE,
  ) {
    super({
      label: 'context-graph subscription persistence',
      maxLanes,
      maxPendingPerLane,
      queueFullError: (message) => new ContextGraphSubscriptionPersistQueueFullError(message),
      queueClosedError: () => new ContextGraphSubscriptionPersistQueueClosedError(),
    });
  }

  override enqueue(key: string, write: () => Promise<void>): Promise<void> {
    return super.enqueue(key, write, { strict: true });
  }

  /**
   * Admit writes again after a shutdown drain. A never-closed scheduler is left
   * alone: subscription writes can be in flight before the first `start()`, and
   * `reopen()` refuses while any lane exists.
   */
  reopenIfClosed(): void {
    if (this.status().closed) this.reopen();
  }
}
