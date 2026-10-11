// SPDX-License-Identifier: Apache-2.0
import type { GossipSubManager, SubscriptionSource } from '@origintrail-official/dkg-core';
import type { ContextGraphSub } from './dkg-agent-types.js';
import { UnansweredAuthorityRecheck } from './internal/unanswered-authority-recheck.js';

export type SwmHostModeHandler = (topic: string, data: Uint8Array, from: string) => void;
export type SwmHostModeCustody =
  | Readonly<{ kind: 'curated' }>
  | Readonly<{ kind: 'manual-public' }>
  | Readonly<{ kind: 'automatic-public'; current: () => boolean }>;
export type SwmHostModeRegistration = Readonly<{
  source: SubscriptionSource;
  handler: SwmHostModeHandler;
  custody: SwmHostModeCustody;
}>;

/** Read-only historical probes derive from the registration, never side tables. */
function registrationView<T>(records: ReadonlyMap<string, SwmHostModeRegistration>, project: (row: SwmHostModeRegistration) => T) {
  return Object.freeze({
    get size() { return records.size; },
    has: (key: string) => records.has(key),
    get: (key: string) => { const row = records.get(key); return row === undefined ? undefined : project(row); },
    keys: () => records.keys(),
    *values() { for (const row of records.values()) yield project(row); },
  });
}

/** One transition owner for listener provenance, classification and custody. */
class SwmHostModeRegistrations {
  readonly #records = new Map<string, SwmHostModeRegistration>();
  readonly sources = registrationView(this.#records, row => row.source);
  readonly classifications = registrationView(this.#records, row => row.custody.kind === 'curated');
  readonly handlers = registrationView(this.#records, row => row.handler);
  get(key: string): SwmHostModeRegistration | undefined { return this.#records.get(key); }
  has(key: string): boolean { return this.#records.has(key); }
  register(key: string, registration: SwmHostModeRegistration): boolean {
    if (this.#records.has(key)) return false;
    this.#records.set(key, Object.freeze({ ...registration, custody: Object.freeze(registration.custody) }));
    return true;
  }
  classify(key: string, custody: SwmHostModeCustody): void {
    const current = this.#records.get(key);
    if (current) this.#records.set(key, Object.freeze({ ...current, custody: Object.freeze(custody) }));
  }
  remove(key: string): SwmHostModeRegistration | undefined {
    const current = this.#records.get(key);
    if (!current) return undefined;
    this.#records.delete(key);
    return current;
  }
}

/** All bookkeeping belongs to the manager whose wiring it describes. */
export class GossipSession {
  readonly gossipRegistered = new Set<string>();
  readonly sharedMemoryGossipRegistered = new Set<string>();
  readonly hostModeRegistrations = new SwmHostModeRegistrations();
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
