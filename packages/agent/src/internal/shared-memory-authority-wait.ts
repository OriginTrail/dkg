// SPDX-License-Identifier: Apache-2.0

/**
 * A shared-memory check that said "no" only because the graph's RFC-64
 * authority is not in place on this node yet, told apart from a refusal.
 *
 * A catalog-owned graph's shared memory is governed by the RFC-64 policy this
 * node has accepted for it. Until a policy is accepted, or while the node's
 * catalog authority for the graph is not active, nothing has decided whether
 * the node may use that shared memory: the check fails closed and says "no",
 * and the node checks the graph again once the policy is accepted. That "no"
 * is a wait. A refusal is an accepted policy that does not admit this node,
 * or a legacy check that answered "no".
 *
 * The check keeps its fail-closed boolean result. A caller that logs the "no"
 * passes the check an `onAuthorityWait` option, which hears what a "no" waits
 * for; it is not called for a refusal or a "yes".
 */

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';

/** What a graph's shared-memory check waits for, as the node's log names it. */
export interface SharedMemoryAuthorityWait {
  /** What the check waits for. */
  readonly waitingFor: string;
  /** Where that stands, e.g. `last refresh: registered-authority-unfinalized`. */
  readonly detail: string;
}

/** The shared-memory check's `onAuthorityWait` option. */
export type SharedMemoryAuthorityWaitSink = (wait: SharedMemoryAuthorityWait) => void;

/** The node's reads of one graph's RFC-64 authority that tell a wait from a refusal. */
export interface Rfc64SharedMemoryAuthorityReads {
  /** Whether the node's RFC-64 authority governs the graph's transport now. */
  isRfc64CatalogTransportAuthorityActiveV1(contextGraphId: string): boolean;
  /** The policy the node has accepted for the graph, or null while it has none. */
  readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId: string): unknown;
  /** The reason the graph's last authority refresh recorded, or null. */
  rfc64CatalogAuthorityRefreshFailureReasonV1(contextGraphId: string): string | null;
}

/**
 * What a "no" from the graph's RFC-64 authority waits for, or undefined when
 * a policy this node has accepted gave it: a refusal. Read it in the turn the
 * "no" was given, since the policy can be accepted at any await.
 */
export function rfc64SharedMemoryAuthorityWaitV1(
  reads: Rfc64SharedMemoryAuthorityReads,
  contextGraphId: string,
): SharedMemoryAuthorityWait | undefined {
  if (
    reads.isRfc64CatalogTransportAuthorityActiveV1(contextGraphId)
    && reads.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId) !== null
  ) return undefined;
  const failure = reads.rfc64CatalogAuthorityRefreshFailureReasonV1(contextGraphId);
  return {
    waitingFor: 'the graph\'s RFC-64 authority',
    detail: failure === null ? 'not accepted on this node yet' : `last refresh: ${failure}`,
  };
}

/** `<what it waits for> (<where that stands>)`, as a log line names a wait. */
export function describeSharedMemoryAuthorityWait(wait: SharedMemoryAuthorityWait): string {
  return `${wait.waitingFor} (${wait.detail})`;
}

/** Bound on the graphs one owner's log remembers as waiting. */
export const SHARED_MEMORY_AUTHORITY_WAITS_MAX = 4_096;

/**
 * The graphs whose wait one owner's log has reported, with what each waits
 * for. A new wait, or a wait for something else, is said at info, where an
 * operator sees it; a repeat goes to debug. When a wait is over, the line
 * that says so can name what was waited for.
 */
export class SharedMemoryAuthorityWaits {
  readonly #waiting = new Map<string, SharedMemoryAuthorityWait>();

  /** The graph waits for `wait`. Returns the level to log that at. */
  wait(contextGraphId: string, wait: SharedMemoryAuthorityWait): 'info' | 'debug' {
    const previous = this.#waiting.get(contextGraphId);
    this.#waiting.delete(contextGraphId);
    if (this.#waiting.size >= SHARED_MEMORY_AUTHORITY_WAITS_MAX) {
      // The wait reported longest ago is forgotten: its next report is said
      // again at info.
      const oldest = this.#waiting.keys().next();
      if (!oldest.done) this.#waiting.delete(oldest.value);
    }
    this.#waiting.set(contextGraphId, wait);
    return previous?.waitingFor === wait.waitingFor && previous.detail === wait.detail
      ? 'debug'
      : 'info';
  }

  /** The graph no longer waits. Returns what it waited for, or undefined. */
  settle(contextGraphId: string): SharedMemoryAuthorityWait | undefined {
    const wait = this.#waiting.get(contextGraphId);
    this.#waiting.delete(contextGraphId);
    return wait;
  }

  /** Graphs the log remembers as waiting. */
  get size(): number {
    return this.#waiting.size;
  }
}

const waitsByOwner = new WeakMap<object, SharedMemoryAuthorityWaits>();

/**
 * The waits one owner's log has reported: a gossip session's for its
 * shared-memory subscriptions, the agent's for its SWM sync planning. They
 * are looked up by the owner and not kept on it, so the owner needs nothing
 * new, and they end with it.
 */
export function sharedMemoryAuthorityWaitsOf(owner: object): SharedMemoryAuthorityWaits {
  let waits = waitsByOwner.get(owner);
  if (waits === undefined) {
    waits = new SharedMemoryAuthorityWaits();
    waitsByOwner.set(owner, waits);
  }
  return waits;
}

/**
 * The shared-memory check of one graph in the node's SWM sync planning: what
 * its "no" waits for, and the line that "no" gets.
 */
export class SharedMemorySyncAuthorityCheck {
  #wait: SharedMemoryAuthorityWait | undefined;

  constructor(
    private readonly contextGraphId: string,
    /** The planning node's waits, from {@link sharedMemoryAuthorityWaitsOf}. */
    private readonly waits: SharedMemoryAuthorityWaits,
  ) {}

  /** The check's `onAuthorityWait` option. */
  readonly onAuthorityWait: SharedMemoryAuthorityWaitSink = (wait) => {
    this.#wait = wait;
  };

  /**
   * Call with the check's result; returns it. A "no" that waits is said at
   * info, and at debug when repeated; any other "no" stays a warning. A
   * "yes" ends the graph's wait.
   */
  answer(
    canUse: boolean,
    log: Pick<Logger, 'info' | 'debug' | 'warn'>,
    ctx: OperationContext,
  ): boolean {
    const wait = canUse ? undefined : this.#wait;
    if (wait === undefined) {
      this.waits.settle(this.contextGraphId);
      if (!canUse) {
        log.warn(ctx, `Skipping SWM sync for unauthorized or unconfirmed context graph "${this.contextGraphId}"`);
      }
      return canUse;
    }
    log[this.waits.wait(this.contextGraphId, wait)](
      ctx,
      `Skipping SWM sync for "${this.contextGraphId}" for now: it waits for ${
        describeSharedMemoryAuthorityWait(wait)
      }`,
    );
    return false;
  }
}
