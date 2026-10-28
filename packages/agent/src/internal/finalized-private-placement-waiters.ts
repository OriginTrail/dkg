// SPDX-License-Identifier: Apache-2.0

import type {
  CatalogPlacementAdmissionV1,
  CatalogPlacementWaiterObserverV1,
} from './catalog-placement-timing.js';

/** One accepted request: what settles it, when it was accepted (timing clock) and who observes it. */
interface FinalizedPrivatePlacementWaiterV1 {
  readonly settle: () => void;
  readonly requestedAt: number;
  readonly observer: CatalogPlacementWaiterObserverV1 | undefined;
}

/** Tell a waiter's observer what happened. Observation only: its failure never reaches the supervisor. */
function tell(waiter: FinalizedPrivatePlacementWaiterV1, notify: (observer: CatalogPlacementWaiterObserverV1) => void): void {
  if (waiter.observer === undefined) return;
  try {
    notify(waiter.observer);
  } catch { /* observation only */ }
}

/**
 * The finalized-private supervisor's accepted requests, by repair key (GH#3081). Each waiter
 * settles once: after the first attempt for its key ends, when its key leaves the queue, when the
 * runner refuses it, or when the supervisor closes. Its observer, when the request carried one, is
 * told about the cooldown skips it waits through and the attempt that released it, and settling
 * never depends on that observer.
 */
export class FinalizedPrivatePlacementWaitersV1 {
  readonly #byKey = new Map<string, Set<FinalizedPrivatePlacementWaiterV1>>();

  /** Accept a waiter for `key`; `withdraw` forgets and settles it when the runner refused the work. */
  add(
    key: string,
    requestedAt: number,
    observer?: CatalogPlacementWaiterObserverV1,
  ): Readonly<{ whenAttempted: Promise<void>; withdraw: () => void }> {
    let settle!: () => void;
    const whenAttempted = new Promise<void>((resolve) => { settle = resolve; });
    const waiter: FinalizedPrivatePlacementWaiterV1 = { settle, requestedAt, observer };
    const waiters = this.#byKey.get(key) ?? new Set<FinalizedPrivatePlacementWaiterV1>();
    waiters.add(waiter);
    this.#byKey.set(key, waiters);
    return Object.freeze({
      whenAttempted,
      withdraw: () => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#byKey.delete(key);
        settle();
      },
    });
  }

  /** The keys that have waiters. */
  keys(): IterableIterator<string> {
    return this.#byKey.keys();
  }

  /** A pass skipped `key`'s repair because its retry cooldown had not elapsed. */
  cooldownSkipped(key: string): void {
    for (const waiter of this.#byKey.get(key) ?? []) tell(waiter, (observer) => observer.cooldownSkipped());
  }

  /** Settle `key`'s waiters: after `attempt` when one ran, or with none when the key left the queue. */
  release(key: string, attempt?: CatalogPlacementAdmissionV1): void {
    const waiters = this.#byKey.get(key);
    this.#byKey.delete(key);
    for (const waiter of waiters ?? []) {
      tell(waiter, (observer) => observer.released(attempt));
      waiter.settle();
    }
  }

  /** Settle every waiter without an attempt: the supervisor is closing. */
  releaseAll(): void {
    for (const key of this.#byKey.keys()) this.release(key);
  }

  /** Aggregates for the queue status; no key, callback or observer leaves this class. */
  summary(): Readonly<{ count: number; oldestRequestedAt: number | undefined }> {
    let count = 0;
    let oldestRequestedAt: number | undefined;
    for (const waiters of this.#byKey.values()) {
      count += waiters.size;
      for (const { requestedAt } of waiters) {
        if (Number.isFinite(requestedAt) && (oldestRequestedAt === undefined || requestedAt < oldestRequestedAt)) {
          oldestRequestedAt = requestedAt;
        }
      }
    }
    return Object.freeze({ count, oldestRequestedAt });
  }
}
