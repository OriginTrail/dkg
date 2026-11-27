// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from '../dkg-agent-types.js';

/** Entries whose last change is remembered; past this the memory is dropped and every version moves once. */
export const MAX_TRACKED_SUBSCRIPTION_CHANGES = 4096;

/**
 * The subscription registry: a plain map that also counts the writes made to each of its entries.
 *
 * An entry can be created, replaced and removed from many places, and comparing an entry by value cannot tell a
 * change that was reverted from no change. A work in flight that must know whether a graph's subscription moved
 * (the write preflight's stamp, OT-RFC-73 S4a) compares `versionOf(id)` instead: it moves with every `set`,
 * `delete` and `clear` that touches the entry, even when the new entry equals the old one, and it never returns to
 * a value it had before.
 *
 * A row mutated in place moves nothing by itself; the agent publishes such a change through
 * `setContextGraphSubscription`, which writes the row back here.
 */
export class VersionedSubscriptionRegistry extends Map<string, ContextGraphSub> {
  private epoch = 0;
  private clock = 0;
  /** The clock value of each id's last change, kept after a delete so that a re-created entry has a new version. */
  private readonly changedAt = new Map<string, number>();

  constructor() {
    super();
  }

  /** Moves whenever `id`'s entry is written or removed. Compare for equality only. */
  versionOf(id: string): string {
    return `${this.epoch}.${this.changedAt.get(id) ?? 0}`;
  }

  override set(id: string, value: ContextGraphSub): this {
    this.noteChange(id);
    return super.set(id, value);
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.noteChange(id);
    return removed;
  }

  override clear(): void {
    if (this.size > 0) {
      this.epoch += 1;
      this.changedAt.clear();
    }
    super.clear();
  }

  private noteChange(id: string): void {
    if (!this.changedAt.has(id) && this.changedAt.size >= MAX_TRACKED_SUBSCRIPTION_CHANGES) {
      // Forgetting is safe: a new epoch is a version no earlier stamp holds.
      this.epoch += 1;
      this.changedAt.clear();
    }
    this.clock += 1;
    this.changedAt.set(id, this.clock);
  }
}
