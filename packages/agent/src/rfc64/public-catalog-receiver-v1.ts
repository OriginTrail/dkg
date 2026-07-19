// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 receiver scheduler for public author-catalog head availability.
 *
 * `onCatalogHeadAvailable` hands us an untrusted, policy-admitted hint. The
 * transport awaits that callback *before* it ACKs the announcement, so this
 * scheduler MUST return synchronously: {@link Rfc64PublicCatalogReceiverV1.schedule}
 * only enqueues and pumps; the fetch/verify/stage work runs on the pool after
 * the announcement handler has returned.
 *
 * Per hinted head it: (1) deduplicates against both in-flight work and heads
 * already durably staged, (2) fetches the exact head by digest (the transport
 * re-verifies structure + issuer signature), and (3) durably stages the
 * verified head into the control-object store. It STOPS there — Gate 1 never
 * admits candidate rows, activates catalog state, or advances any SWM/VM
 * pointer. Correctness comes from pull: a dropped or failed announcement is
 * simply re-triggered by a later hint or a future reconcile cadence.
 */

import type {
  FetchedRfc64PublicCatalogHeadV1,
  Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

/** Side effects the scheduler drives; all supplied by the wired service. */
export interface Rfc64PublicCatalogReceiverStagerV1 {
  /** True when the exact head is already durably staged (restart/prior-fetch dedup). */
  isHeadStaged(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Promise<boolean>;
  /** Fetch the exact head by digest; null == authoritative not-found. */
  fetchHead(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<FetchedRfc64PublicCatalogHeadV1 | null>;
  /** Durably stage the verified head. Must not return before the write is durable. */
  stageHead(fetched: FetchedRfc64PublicCatalogHeadV1): Promise<void>;
}

export interface Rfc64PublicCatalogReceiverOptionsV1 {
  /** Max concurrent fetch/stage chains. Default 4. */
  readonly maxConcurrent?: number;
  /** Max queued distinct heads before new hints are dropped. Default 1024. */
  readonly maxQueue?: number;
  /** Max fetch attempts per head before giving up. Default 3. */
  readonly maxAttempts?: number;
  /** Base backoff between attempts (doubled per retry). Default 250ms. */
  readonly retryBackoffMs?: number;
  readonly onHeadStaged?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ) => void;
  readonly onError?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    error: unknown,
  ) => void;
}

export interface Rfc64PublicCatalogReceiverStatsV1 {
  readonly scheduled: number;
  readonly dedupedInFlight: number;
  readonly dedupedAlreadyStaged: number;
  readonly staged: number;
  readonly notFound: number;
  readonly failed: number;
  readonly droppedQueueFull: number;
  readonly inFlight: number;
  readonly queued: number;
}

interface ReceiverTaskV1 {
  readonly key: string;
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly remotePeerId: string;
}

const DEFAULTS = Object.freeze({
  maxConcurrent: 4,
  maxQueue: 1024,
  maxAttempts: 3,
  retryBackoffMs: 250,
});

export class Rfc64PublicCatalogReceiverV1 {
  readonly #stager: Rfc64PublicCatalogReceiverStagerV1;
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  readonly #maxAttempts: number;
  readonly #retryBackoffMs: number;
  readonly #onHeadStaged?: Rfc64PublicCatalogReceiverOptionsV1['onHeadStaged'];
  readonly #onError?: Rfc64PublicCatalogReceiverOptionsV1['onError'];

  readonly #queue: ReceiverTaskV1[] = [];
  /** Every head key currently queued or in-flight — the dedup set. */
  readonly #pendingKeys = new Set<string>();
  readonly #active = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  #closed = false;
  #idleWaiters: Array<() => void> = [];

  #scheduled = 0;
  #dedupedInFlight = 0;
  #dedupedAlreadyStaged = 0;
  #staged = 0;
  #notFound = 0;
  #failed = 0;
  #droppedQueueFull = 0;

  constructor(
    stager: Rfc64PublicCatalogReceiverStagerV1,
    options: Rfc64PublicCatalogReceiverOptionsV1 = {},
  ) {
    this.#stager = stager;
    this.#maxConcurrent = positiveInt(options.maxConcurrent, DEFAULTS.maxConcurrent);
    this.#maxQueue = positiveInt(options.maxQueue, DEFAULTS.maxQueue);
    this.#maxAttempts = positiveInt(options.maxAttempts, DEFAULTS.maxAttempts);
    this.#retryBackoffMs = nonNegativeInt(options.retryBackoffMs, DEFAULTS.retryBackoffMs);
    this.#onHeadStaged = options.onHeadStaged;
    this.#onError = options.onError;
  }

  /**
   * Enqueue an announced head for fetch+stage. Non-blocking and synchronous:
   * it never awaits the fetch, so the transport's ACK path is not stalled.
   * Duplicate (already queued/in-flight) heads and post-close hints are dropped.
   */
  schedule(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ): void {
    if (this.#closed) return;
    this.#scheduled += 1;
    const key = headKey(announcement);
    if (this.#pendingKeys.has(key)) {
      this.#dedupedInFlight += 1;
      return;
    }
    if (this.#queue.length >= this.#maxQueue) {
      this.#droppedQueueFull += 1;
      return;
    }
    this.#pendingKeys.add(key);
    this.#queue.push({ key, announcement, remotePeerId });
    this.#pump();
  }

  /** Resolve once no work is queued or in-flight. */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * Stop accepting hints, abort in-flight fetch retries, and await every
   * in-flight chain so no durable stage write races the control store close.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      await Promise.allSettled([...this.#active]);
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    this.#closing.abort(new Error('RFC-64 public catalog receiver closing'));
    await Promise.allSettled([...this.#active]);
    this.#resolveIdle();
  }

  stats(): Rfc64PublicCatalogReceiverStatsV1 {
    return Object.freeze({
      scheduled: this.#scheduled,
      dedupedInFlight: this.#dedupedInFlight,
      dedupedAlreadyStaged: this.#dedupedAlreadyStaged,
      staged: this.#staged,
      notFound: this.#notFound,
      failed: this.#failed,
      droppedQueueFull: this.#droppedQueueFull,
      inFlight: this.#active.size,
      queued: this.#queue.length,
    });
  }

  #pump(): void {
    while (!this.#closed && this.#active.size < this.#maxConcurrent && this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      const run = this.#runTask(task).finally(() => {
        this.#active.delete(run);
        this.#pendingKeys.delete(task.key);
        if (!this.#closed) this.#pump();
        if (this.#isIdle()) this.#resolveIdle();
      });
      this.#active.add(run);
    }
  }

  async #runTask(task: ReceiverTaskV1): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      if (this.#closing.signal.aborted) return;
      try {
        if (await this.#stager.isHeadStaged(task.announcement)) {
          this.#dedupedAlreadyStaged += 1;
          return;
        }
        const fetched = await this.#stager.fetchHead(task.remotePeerId, task.announcement);
        if (fetched === null) {
          this.#notFound += 1;
          return;
        }
        await this.#stager.stageHead(fetched);
        this.#staged += 1;
        this.#safeNotify(() => this.#onHeadStaged?.(task.announcement, task.remotePeerId));
        return;
      } catch (error) {
        lastError = error;
        if (this.#closing.signal.aborted) return;
        if (attempt + 1 >= this.#maxAttempts) break;
        await this.#backoff(attempt);
      }
    }
    if (this.#closing.signal.aborted) return;
    this.#failed += 1;
    this.#safeNotify(() => this.#onError?.(task.announcement, lastError));
  }

  #backoff(attempt: number): Promise<void> {
    const delay = this.#retryBackoffMs * 2 ** attempt;
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const signal = this.#closing.signal;
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      (timer as { unref?: () => void }).unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #safeNotify(fn: () => void): void {
    try {
      fn();
    } catch {
      // Observer callbacks must never break the scheduler.
    }
  }

  #isIdle(): boolean {
    return this.#active.size === 0 && this.#queue.length === 0;
  }

  #resolveIdle(): void {
    if (!this.#isIdle()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * Dedup key: the exact head identity (scope + both digests). Heads at a new
 * era/version or with a different object/signature digest are distinct work.
 * `policyDigest` is intentionally excluded — the head binds to scope, not to a
 * policy generation, and a stale policy fails the transport's own check.
 */
function headKey(a: Rfc64PublicCatalogHeadAnnouncementV1): string {
  return [
    a.networkId,
    a.contextGraphId,
    a.subGraphName ?? '',
    a.authorAddress,
    a.catalogEra,
    a.catalogVersion,
    a.catalogHeadObjectDigest,
    a.signatureVariantDigest,
  ].join('\n');
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
