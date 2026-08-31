// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64PublicCatalogReceiverCompletionV1,
} from './public-catalog-reconciliation-outcome-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from
  './public-catalog-transport-v1.js';

/** Mutable task state owned by the receiver lifecycle scheduler. */
export interface Rfc64ReceiverLifecycleTaskV1 {
  readonly key: string;
  readonly contextGraphId: string;
  readonly cancellation: AbortController;
  completionWaiters?: Array<(result: Rfc64PublicCatalogReceiverCompletionV1) => void>;
  running?: boolean;
  settled?: boolean;
}

/**
 * One owner for receiver task membership and terminal settlement.
 *
 * A task may be queued, deferred, or active (`running`). The receiver owns the
 * active promise and scope lock, while this lifecycle object owns every task's
 * pending-key identity, queue/deferred transition, cancellation, and exactly-
 * once completion settlement. Keeping those invariants here prevents each
 * scheduler branch from open-coding a slightly different cleanup sequence.
 */
export class Rfc64ReceiverTaskLifecycleV1<
  TTask extends Rfc64ReceiverLifecycleTaskV1,
> {
  readonly #queue: TTask[] = [];
  readonly #pendingByKey = new Map<string, TTask>();
  readonly #deferred = new Set<TTask>();

  get queuedCount(): number {
    return this.#queue.length;
  }

  get deferredCount(): number {
    return this.#deferred.size;
  }

  get isIdle(): boolean {
    return this.#queue.length === 0 && this.#deferred.size === 0;
  }

  pending(key: string): TTask | undefined {
    return this.#pendingByKey.get(key);
  }

  schedule(task: TTask): void {
    this.#pendingByKey.set(task.key, task);
    this.#queue.push(task);
  }

  requeue(task: TTask): boolean {
    if (task.settled === true || task.cancellation.signal.aborted) return false;
    this.#deferred.delete(task);
    this.#queue.push(task);
    return true;
  }

  defer(task: TTask): boolean {
    if (task.settled === true || task.cancellation.signal.aborted) return false;
    this.#deferred.add(task);
    return true;
  }

  removeDeferred(task: TTask): boolean {
    return this.#deferred.delete(task);
  }

  takeNextRunnable(canRun: (task: TTask) => boolean): TTask | undefined {
    const index = this.#queue.findIndex(canRun);
    if (index < 0) return undefined;
    const [task] = this.#queue.splice(index, 1);
    return task;
  }

  cancelContextGraph(
    contextGraphId: string,
    reason: Error,
    completion: (task: TTask) => Rfc64PublicCatalogReceiverCompletionV1,
    beforeSettle: (task: TTask) => void,
    notify: (waiter: () => void) => void,
  ): void {
    const tasks = new Set(
      [...this.#pendingByKey.values()].filter(
        (task) => task.contextGraphId === contextGraphId,
      ),
    );
    for (const task of tasks) {
      task.cancellation.abort(reason);
      if (task.running === true) continue;
      this.finalize(task, completion(task), beforeSettle, notify);
    }
  }

  abortAll(reason: Error): void {
    for (const task of new Set(this.#pendingByKey.values())) {
      task.cancellation.abort(reason);
    }
  }

  finalizeNonRunning(
    completion: (task: TTask) => Rfc64PublicCatalogReceiverCompletionV1,
    beforeSettle: (task: TTask) => void,
    notify: (waiter: () => void) => void,
  ): void {
    for (const task of new Set(this.#pendingByKey.values())) {
      if (task.running === true) continue;
      this.finalize(task, completion(task), beforeSettle, notify);
    }
  }

  finalize(
    task: TTask,
    result: Rfc64PublicCatalogReceiverCompletionV1,
    beforeSettle: (task: TTask) => void,
    notify: (waiter: () => void) => void,
  ): boolean {
    if (task.settled === true) return false;
    task.settled = true;
    const queueIndex = this.#queue.indexOf(task);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    this.#deferred.delete(task);
    if (this.#pendingByKey.get(task.key) === task) this.#pendingByKey.delete(task.key);
    beforeSettle(task);
    const waiters = task.completionWaiters?.splice(0) ?? [];
    for (const resolve of waiters) notify(() => resolve(result));
    return true;
  }
}

/** Exact-head deduplication key owned by the receiver scheduler. */
export function rfc64ReceiverHeadKeyV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return [
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName ?? '',
    announcement.authorAddress,
    announcement.catalogEra,
    announcement.catalogVersion,
    announcement.policyDigest,
    announcement.catalogHeadObjectDigest,
    announcement.signatureVariantDigest,
  ].join('\n');
}

/** One-writer semantic scope key owned by the receiver scheduler. */
export function rfc64ReceiverCatalogScopeKeyV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return [
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName ?? '',
    announcement.authorAddress,
    announcement.catalogEra,
  ].join('\n');
}

/** Provider identity is policy-bound so policy rotation cannot alias work. */
export function rfc64ReceiverProviderContextKeyV1(
  peerId: string,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return `${peerId}\n${announcement.policyDigest}`;
}

export function rfc64ReceiverPositiveIntV1(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function rfc64ReceiverNonNegativeIntV1(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}
