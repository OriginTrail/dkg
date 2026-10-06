// SPDX-License-Identifier: Apache-2.0

import { KeyedPersistScheduler, type KeyedPersistSchedulerStatus } from './keyed-persist-scheduler.js';

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

export const CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE =
  'CG_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT';

export class ContextGraphMembershipPersistShutdownTimeoutError extends Error {
  readonly code = CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE;

  constructor(timeoutMs: number) {
    super(`Context-graph membership persistence did not drain within ${timeoutMs}ms`);
    this.name = 'ContextGraphMembershipPersistShutdownTimeoutError';
  }
}

export type ContextGraphMembershipPersistSchedulerStatus = KeyedPersistSchedulerStatus;

/**
 * Bounded keyed serialization for membership-store mutations: a
 * {@link KeyedPersistScheduler} with membership's bounds and typed errors.
 *
 * Background membership writes omit `strict` and coalesce to the latest write
 * per key; callers that need every write, in order, pass `{ strict: true }`.
 */
export class ContextGraphMembershipPersistScheduler extends KeyedPersistScheduler {
  constructor(maxLanes = 1_000, maxPendingPerLane = 16) {
    super({
      label: 'context-graph membership persistence',
      maxLanes,
      maxPendingPerLane,
      queueFullError: (message) => new ContextGraphMembershipPersistQueueFullError(message),
      queueClosedError: () => new ContextGraphMembershipPersistQueueClosedError(),
    });
  }
}
