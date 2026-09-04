// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64PublicCatalogReceiverCompletionV1,
} from './public-catalog-reconciliation-outcome-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from
  './public-catalog-transport-v1.js';

export type Rfc64ReceiverSchedulingClassV1 =
  | 'ambient'
  | 'isolated'
  | 'verified-current-head';

export interface Rfc64ReceiverSchedulingPolicyV1 {
  readonly schedulingClass: Rfc64ReceiverSchedulingClassV1;
  readonly placement: 'tail' | 'before-same-scope';
  readonly retiresOlderAmbientAfterDurableSuccess: boolean;
}

const RFC64_RECEIVER_SCHEDULING_POLICIES_V1 = Object.freeze({
  ambient: Object.freeze({
    schedulingClass: 'ambient',
    placement: 'tail',
    retiresOlderAmbientAfterDurableSuccess: false,
  }),
  isolated: Object.freeze({
    schedulingClass: 'isolated',
    placement: 'tail',
    retiresOlderAmbientAfterDurableSuccess: false,
  }),
  'verified-current-head': Object.freeze({
    schedulingClass: 'verified-current-head',
    placement: 'before-same-scope',
    retiresOlderAmbientAfterDurableSuccess: true,
  }),
} satisfies Record<Rfc64ReceiverSchedulingClassV1, Rfc64ReceiverSchedulingPolicyV1>);

/** One explicit policy snapshot for every validated receiver task class. */
export function rfc64ReceiverSchedulingPolicyV1(
  schedulingClass: Rfc64ReceiverSchedulingClassV1,
): Rfc64ReceiverSchedulingPolicyV1 {
  return RFC64_RECEIVER_SCHEDULING_POLICIES_V1[schedulingClass];
}

/** Mutable task state owned by the receiver lifecycle scheduler. */
export interface Rfc64ReceiverLifecycleTaskV1 {
  readonly key: string;
  readonly scopeKey: string;
  readonly contextGraphId: string;
  readonly catalogVersion: bigint;
  readonly schedulingPolicy: Rfc64ReceiverSchedulingPolicyV1;
  readonly cancellation: AbortController;
  completionWaiters?: Array<(result: Rfc64PublicCatalogReceiverCompletionV1) => void>;
  running?: boolean;
  settled?: boolean;
}

/**
 * One owner for receiver task membership and terminal settlement.
 *
 * A task may be queued, deferred, or active (`running`). This scheduler owns
 * every mutable transition: pending-key identity, scope lock, timer, active
 * membership, cancellation, and exactly-once completion settlement. The
 * receiver supplies the reconciliation body only, so it cannot independently
 * mutate task membership or idleness.
 */
export class Rfc64ReceiverTaskLifecycleV1<
  TTask extends Rfc64ReceiverLifecycleTaskV1,
> {
  readonly #queue: TTask[] = [];
  readonly #pendingByKey = new Map<string, TTask>();
  readonly #deferred = new Set<TTask>();
  readonly #active = new Set<TTask>();
  readonly #activeScopeKeys = new Set<string>();
  readonly #deferredTimers = new Map<TTask, ReturnType<typeof setTimeout>>();

  get queuedCount(): number {
    return this.#queue.length;
  }

  get deferredCount(): number {
    return this.#deferred.size;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get isIdle(): boolean {
    return this.#queue.length === 0 && this.#deferred.size === 0 && this.#active.size === 0;
  }

  pending(key: string): TTask | undefined {
    return this.#pendingByKey.get(key);
  }

  schedule(task: TTask): void {
    this.#pendingByKey.set(task.key, task);
    if (task.schedulingPolicy.placement === 'tail') {
      this.#queue.push(task);
      return;
    }
    const scopeIndex = this.#queue.findIndex((queued) => queued.scopeKey === task.scopeKey);
    if (scopeIndex < 0) this.#queue.push(task);
    else this.#queue.splice(scopeIndex, 0, task);
  }

  requeue(task: TTask): boolean {
    if (task.settled === true || task.cancellation.signal.aborted) return false;
    this.#deferred.delete(task);
    this.#queue.push(task);
    return true;
  }

  defer(task: TTask, delayMs: number, onReady: () => void): boolean {
    if (task.settled === true || task.cancellation.signal.aborted) return false;
    this.#deferred.add(task);
    const timer = setTimeout(() => {
      this.#deferredTimers.delete(task);
      this.#deferred.delete(task);
      onReady();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.#deferredTimers.set(task, timer);
    return true;
  }

  removeDeferred(task: TTask): boolean {
    const timer = this.#deferredTimers.get(task);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#deferredTimers.delete(task);
    }
    return this.#deferred.delete(task);
  }

  takeNextRunnable(): TTask | undefined {
    const index = this.#queue.findIndex((task) => !this.#activeScopeKeys.has(task.scopeKey));
    if (index < 0) return undefined;
    const [task] = this.#queue.splice(index, 1);
    return task;
  }

  begin(task: TTask): void {
    this.#active.add(task);
    this.#activeScopeKeys.add(task.scopeKey);
    task.running = true;
  }

  finishRunning(task: TTask): void {
    task.running = false;
    this.#active.delete(task);
    this.#activeScopeKeys.delete(task.scopeKey);
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

  clearDeferredTimers(): void {
    for (const timer of this.#deferredTimers.values()) clearTimeout(timer);
    this.#deferredTimers.clear();
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

  finalizeNonRunningWhere(
    predicate: (task: TTask) => boolean,
    completion: (task: TTask) => Rfc64PublicCatalogReceiverCompletionV1,
    beforeSettle: (task: TTask) => void,
    notify: (waiter: () => void) => void,
  ): number {
    let finalized = 0;
    for (const task of new Set(this.#pendingByKey.values())) {
      if (task.running === true || !predicate(task)) continue;
      if (this.finalize(task, completion(task), beforeSettle, notify)) finalized += 1;
    }
    return finalized;
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
    this.removeDeferred(task);
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
