// SPDX-License-Identifier: Apache-2.0
import type { GossipSubManager, SubscriptionSource } from '@origintrail-official/dkg-core';
import type { ContextGraphSub } from './dkg-agent-types.js';
import { UnansweredAuthorityRecheck } from './internal/unanswered-authority-recheck.js';

/** All bookkeeping belongs to the manager whose wiring it describes. */
export class GossipSession {
  readonly gossipRegistered = new Set<string>();
  readonly sharedMemoryGossipRegistered = new Set<string>();
  readonly swmHostModeSubscribed = new Map<string, SubscriptionSource>();
  readonly swmHostModeCurated = new Map<string, boolean>();
  readonly swmHostModeHandlers = new Map<string, (topic: string, data: Uint8Array, from: string) => void>();
  /** Live intents snapshotted before the durable startup plan is read. */
  readonly startupLiveIntents = new Map<string, Pick<ContextGraphSub, 'syncMode'>>();
  #retired = false;

  readonly #manager: GossipSubManager | undefined;
  constructor(manager?: GossipSubManager) { this.#manager = manager; }

  get active(): boolean { return this.live() !== null; }

  /** The only manager accessor for optional wiring establishes the live invariant. */
  live(): Readonly<{ manager: GossipSubManager }> | null {
    return this.#retired || this.#manager === undefined ? null : { manager: this.#manager };
  }

  requireManager(): GossipSubManager {
    const live = this.live();
    if (live === null) throw new Error('Gossip manager is unavailable outside a live session');
    return live.manager;
  }

  /** Capture startup ownership before any durable read can yield. */
  beginDurableStartupPlan(previouslyDurableIds: Iterable<string>): Readonly<{
    claimDurableRows(rows: Iterable<{ id: string }>): void;
    finish(): void;
  }> {
    const fallbackIds = new Set(previouslyDurableIds);
    let durablePlanRead = false;
    return Object.freeze({
      claimDurableRows: (rows: Iterable<{ id: string }>) => {
        // Durable activation (or dormancy) wins over the pre-read live snapshot.
        // A later save completion cannot change this session's startup plan.
        for (const row of rows) this.startupLiveIntents.delete(row.id);
        durablePlanRead = true;
      },
      finish: () => {
        // A failed store read must not bypass authority for an intent already
        // known to be durable. The fallback is fixed before the awaited read.
        if (!durablePlanRead) {
          for (const id of fallbackIds) this.startupLiveIntents.delete(id);
        }
      },
    });
  }

  retire(): void {
    this.#retired = true;
    sharedMemoryAuthorityRechecks.get(this)?.close();
  }
}

const sharedMemoryAuthorityRechecks = new WeakMap<object, UnansweredAuthorityRecheck>();

/**
 * The shared-memory subscriptions of one gossip session whose authority check
 * got no answer. It is looked up by the session and not kept on it, so the
 * reconcile needs nothing more of a session than it did; a session that
 * retires closes its own.
 */
export function sharedMemoryAuthorityRecheckOf(session: object): UnansweredAuthorityRecheck {
  let recheck = sharedMemoryAuthorityRechecks.get(session);
  if (recheck === undefined) {
    recheck = new UnansweredAuthorityRecheck();
    sharedMemoryAuthorityRechecks.set(session, recheck);
  }
  return recheck;
}
