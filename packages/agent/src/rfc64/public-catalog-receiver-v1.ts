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
 * Per hinted head it deduplicates exact work, retains every distinct provider,
 * serializes mutations for one author-catalog scope, and delegates the full
 * fetch/verify/activate/applied-inventory transaction to a reconciler. Durable
 * applied state -- never mere control-object staging -- is the restart dedup
 * boundary. Correctness still comes from pull: a dropped or failed hint is
 * retriggered by a later announcement or reconcile cadence.
 */

import { isFinalizedChainAdmissionContention } from '@origintrail-official/dkg-chain';

import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export type Rfc64PublicCatalogReconcileResultV1 = 'applied' | 'not-found' | 'staged-only';

/** Full semantic reconciliation supplied by the wired service. */
export interface Rfc64PublicCatalogReceiverReconcilerV1 {
  /** True only when this exact inventory head is durably recorded as applied. */
  isHeadApplied(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Promise<boolean>;
  /**
   * Fetch, verify, activate, exact-post-read, then durably commit applied state.
   * The operation must be idempotent so a restart can repair the semantic-store
   * / SQLite crash gap by replaying it.
   */
  reconcileHead(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    signal: AbortSignal,
  ): Promise<Rfc64PublicCatalogReconcileResultV1>;
}

export interface Rfc64PublicCatalogReceiverOptionsV1 {
  /** Max concurrent fetch/stage chains. Default 4. */
  readonly maxConcurrent?: number;
  /** Max queued distinct heads before new hints are dropped. Default 1024. */
  readonly maxQueue?: number;
  /** Max reconcile attempts per provider before giving up on that provider. Default 3. */
  readonly maxAttempts?: number;
  /** Max distinct providers retained for one exact head. Default 8. */
  readonly maxProvidersPerHead?: number;
  /** Base backoff between attempts (doubled per retry). Default 250ms. */
  readonly retryBackoffMs?: number;
  /**
   * Wait before re-queuing a task that found the process-wide finalized
   * chain-read lane busy. Default 500ms.
   */
  readonly admissionDeferralMs?: number;
  /**
   * Bound on those deferrals so a permanently wedged lane degrades into an
   * ordinary failure instead of looping. Default 240 (~2 minutes at 500ms).
   */
  readonly maxAdmissionDeferrals?: number;
  /**
   * Which failures mean "retry later, nothing is wrong with this head".
   * Defaults to the chain layer's own contention predicate; injectable so the
   * receiver does not hardcode another layer's error shapes.
   */
  readonly isDeferrableError?: (error: unknown) => boolean;
  readonly onHeadApplied?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ) => void;
  /** Called once when a distinct exact-head attempt is admitted to the queue. */
  readonly onAttemptStart?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => void;
  readonly onError?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    error: unknown,
  ) => void;
}

export interface Rfc64PublicCatalogReceiverStatsV1 {
  readonly scheduled: number;
  readonly dedupedInFlight: number;
  readonly dedupedAlreadyApplied: number;
  readonly applied: number;
  readonly stagedOnly: number;
  readonly notFound: number;
  readonly failed: number;
  readonly droppedQueueFull: number;
  readonly droppedProviders: number;
  /**
   * Times a task stepped aside for a busy finalized chain lane. Distinct from
   * `failed`: the head is still pending, not lost.
   */
  readonly admissionDeferred: number;
  /** Accepted heads currently waiting on the chain lane: neither queued nor active. */
  readonly deferred: number;
  readonly inFlight: number;
  readonly queued: number;
}

interface ReceiverTaskV1 {
  readonly key: string;
  readonly scopeKey: string;
  readonly providers: ReceiverProviderV1[];
  readonly providerKeys: Set<string>;
  /**
   * How many times this task has stepped aside for a busy finalized chain lane.
   * Mutable, and deliberately NOT a provider attempt: contention says nothing
   * about the head or the peer.
   */
  admissionDeferrals?: number;
  /**
   * Provider retry bookkeeping, carried ACROSS admission deferrals.
   *
   * These were locals in `#runTask`. Because a deferral exits and requeues the
   * task, the next run restarted them at zero — so `maxAttempts` stopped being a
   * per-provider bound whenever contention landed between ordinary failures: a
   * provider could fail twice, hit a busy lane, and then get a fresh three
   * attempts. Repeated contention multiplied retries without limit.
   */
  attemptsByProvider?: Map<string, number>;
  notFoundProviders?: Set<string>;
  providerCursor?: number;
}

interface ReceiverProviderV1 {
  readonly key: string;
  readonly peerId: string;
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
}

const DEFAULTS = Object.freeze({
  maxConcurrent: 4,
  maxQueue: 1024,
  maxAttempts: 3,
  maxProvidersPerHead: 8,
  retryBackoffMs: 250,
  admissionDeferralMs: 500,
  maxAdmissionDeferrals: 240,
});

/**
 * Default deferral policy: "the chain lane is busy" rather than "this head is bad".
 *
 * The pinned finalized read is one-per-chain PROCESS-WIDE, so an unrelated
 * context graph on the same chain can legitimately hold it for up to the
 * snapshot deadline. That is contention, not an error about this head — but the
 * generic retry path treated it like a provider failure: three attempts and
 * exponential backoff finish in under two seconds, the task is marked failed,
 * and its pending key is deleted.
 *
 * The predicate itself is OWNED BY THE CHAIN PACKAGE, whose code
 * `concurrency-saturated` is, and is injectable here — the receiver should not
 * be crawling the shape of errors from a layer it does not own.
 */
const DEFAULT_DEFERRABLE_ERROR = isFinalizedChainAdmissionContention;

export class Rfc64PublicCatalogReceiverV1 {
  readonly #reconciler: Rfc64PublicCatalogReceiverReconcilerV1;
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  readonly #maxAttempts: number;
  readonly #maxProvidersPerHead: number;
  readonly #retryBackoffMs: number;
  readonly #onHeadApplied?: Rfc64PublicCatalogReceiverOptionsV1['onHeadApplied'];
  readonly #onAttemptStart?: Rfc64PublicCatalogReceiverOptionsV1['onAttemptStart'];
  readonly #onError?: Rfc64PublicCatalogReceiverOptionsV1['onError'];

  readonly #queue: ReceiverTaskV1[] = [];
  /** Every exact head currently queued or in-flight, including alternate peers. */
  readonly #pendingByKey = new Map<string, ReceiverTaskV1>();
  /** One semantic writer per exact author-catalog scope. */
  readonly #activeScopeKeys = new Set<string>();
  readonly #active = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  #closed = false;
  #idleWaiters: Array<() => void> = [];

  readonly #admissionDeferralMs: number;
  readonly #maxAdmissionDeferrals: number;
  readonly #isDeferrableError: (error: unknown) => boolean;
  readonly #deferralTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * The third scheduler state, made explicit: accepted work that is neither
   * queued nor active because it is waiting for the chain lane.
   *
   * It MUST be observable by `#isIdle()`. Without it a deferred head sits in
   * `#pendingByKey` and a timer only, so `whenIdle()` resolved during the retry
   * window and a caller draining the receiver — `synchronizeCurrentCatalogHead()`
   * — could conclude scheduling had settled before the head was applied.
   */
  readonly #deferred = new Set<ReceiverTaskV1>();

  #scheduled = 0;
  #admissionDeferred = 0;
  #dedupedInFlight = 0;
  #dedupedAlreadyApplied = 0;
  #applied = 0;
  #stagedOnly = 0;
  #notFound = 0;
  #failed = 0;
  #droppedQueueFull = 0;
  #droppedProviders = 0;

  constructor(
    reconciler: Rfc64PublicCatalogReceiverReconcilerV1,
    options: Rfc64PublicCatalogReceiverOptionsV1 = {},
  ) {
    this.#reconciler = reconciler;
    this.#maxConcurrent = positiveInt(options.maxConcurrent, DEFAULTS.maxConcurrent);
    this.#maxQueue = positiveInt(options.maxQueue, DEFAULTS.maxQueue);
    this.#maxAttempts = positiveInt(options.maxAttempts, DEFAULTS.maxAttempts);
    this.#maxProvidersPerHead = positiveInt(
      options.maxProvidersPerHead,
      DEFAULTS.maxProvidersPerHead,
    );
    this.#retryBackoffMs = nonNegativeInt(options.retryBackoffMs, DEFAULTS.retryBackoffMs);
    this.#admissionDeferralMs = nonNegativeInt(
      options.admissionDeferralMs,
      DEFAULTS.admissionDeferralMs,
    );
    this.#maxAdmissionDeferrals = positiveInt(
      options.maxAdmissionDeferrals,
      DEFAULTS.maxAdmissionDeferrals,
    );
    this.#isDeferrableError = options.isDeferrableError ?? DEFAULT_DEFERRABLE_ERROR;
    this.#onHeadApplied = options.onHeadApplied;
    this.#onAttemptStart = options.onAttemptStart;
    this.#onError = options.onError;
  }

  /**
   * Enqueue an announced head for reconciliation. Non-blocking and synchronous:
   * it never awaits network or storage work, so the ACK path is not stalled.
   * Duplicate heads contribute alternate providers instead of creating a second
   * semantic writer.
   */
  schedule(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ): void {
    if (this.#closed) return;
    this.#scheduled += 1;
    const key = headKey(announcement);
    const existing = this.#pendingByKey.get(key);
    if (existing !== undefined) {
      this.#dedupedInFlight += 1;
      const providerKey = providerContextKey(remotePeerId, announcement);
      if (!existing.providerKeys.has(providerKey)) {
        if (existing.providers.length >= this.#maxProvidersPerHead) {
          this.#droppedProviders += 1;
          return;
        }
        existing.providerKeys.add(providerKey);
        existing.providers.push({ key: providerKey, peerId: remotePeerId, announcement });
      }
      return;
    }
    if (this.#queue.length >= this.#maxQueue) {
      this.#droppedQueueFull += 1;
      return;
    }
    const providerKey = providerContextKey(remotePeerId, announcement);
    const task: ReceiverTaskV1 = {
      key,
      scopeKey: catalogScopeKey(announcement),
      providers: [{ key: providerKey, peerId: remotePeerId, announcement }],
      providerKeys: new Set([providerKey]),
    };
    this.#pendingByKey.set(key, task);
    this.#queue.push(task);
    this.#safeNotify(() => this.#onAttemptStart?.(announcement));
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
    for (const timer of this.#deferralTimers) clearTimeout(timer);
    this.#deferralTimers.clear();
    for (const task of this.#deferred) this.#pendingByKey.delete(task.key);
    this.#deferred.clear();
    const abandoned = this.#queue.splice(0);
    for (const task of abandoned) this.#pendingByKey.delete(task.key);
    this.#closing.abort(new Error('RFC-64 public catalog receiver closing'));
    await Promise.allSettled([...this.#active]);
    this.#resolveIdle();
  }

  stats(): Rfc64PublicCatalogReceiverStatsV1 {
    return Object.freeze({
      scheduled: this.#scheduled,
      dedupedInFlight: this.#dedupedInFlight,
      dedupedAlreadyApplied: this.#dedupedAlreadyApplied,
      applied: this.#applied,
      stagedOnly: this.#stagedOnly,
      notFound: this.#notFound,
      failed: this.#failed,
      droppedQueueFull: this.#droppedQueueFull,
      droppedProviders: this.#droppedProviders,
      admissionDeferred: this.#admissionDeferred,
      deferred: this.#deferred.size,
      inFlight: this.#active.size,
      queued: this.#queue.length,
    });
  }

  #pump(): void {
    while (!this.#closed && this.#active.size < this.#maxConcurrent && this.#queue.length > 0) {
      const taskIndex = this.#queue.findIndex(
        (candidate) => !this.#activeScopeKeys.has(candidate.scopeKey),
      );
      if (taskIndex < 0) return;
      const [task] = this.#queue.splice(taskIndex, 1);
      if (task === undefined) return;
      this.#activeScopeKeys.add(task.scopeKey);
      const run = this.#runTask(task).then((outcome) => {
        // A deferral releases the concurrency slot AND the semantic scope lock
        // before waiting, and keeps the pending key so a duplicate announcement
        // still dedupes onto this task instead of creating a second writer.
        if (outcome === 'defer-admission' && !this.#closed) {
          this.#scheduleAdmissionRetry(task);
          return;
        }
        this.#pendingByKey.delete(task.key);
      }).finally(() => {
        this.#active.delete(run);
        this.#activeScopeKeys.delete(task.scopeKey);
        if (!this.#closed) this.#pump();
        if (this.#isIdle()) this.#resolveIdle();
      });
      this.#active.add(run);
    }
  }

  /**
   * Re-queue a task whose chain lane was busy, after a bounded delay.
   *
   * Detached on purpose: the receiver slot and the per-scope semantic lock are
   * already released by the time this runs, so waiting here costs no capacity.
   * The counter bounds it so a permanently wedged lane degrades into a normal
   * failure instead of looping forever.
   */
  #scheduleAdmissionRetry(task: ReceiverTaskV1): void {
    task.admissionDeferrals = (task.admissionDeferrals ?? 0) + 1;
    this.#admissionDeferred += 1;
    if (task.admissionDeferrals > this.#maxAdmissionDeferrals) {
      this.#failed += 1;
      this.#deferred.delete(task);
      this.#pendingByKey.delete(task.key);
      this.#safeNotify(() => this.#onError?.(
        task.providers[0]!.announcement,
        new Error('RFC-64 receiver gave up waiting for the finalized chain-read lane'),
      ));
      if (this.#isIdle()) this.#resolveIdle();
      return;
    }
    // Registered BEFORE the timer is armed: between these two statements the
    // task must never be invisible to the idle predicate.
    this.#deferred.add(task);
    const timer = setTimeout(() => {
      this.#deferralTimers.delete(timer);
      this.#deferred.delete(task);
      if (this.#closed || this.#closing.signal.aborted) {
        this.#pendingByKey.delete(task.key);
        if (this.#isIdle()) this.#resolveIdle();
        return;
      }
      this.#queue.push(task);
      this.#pump();
    }, this.#admissionDeferralMs);
    // Never hold the process open for a retry.
    (timer as { unref?: () => void }).unref?.();
    this.#deferralTimers.add(timer);
  }

  async #runTask(task: ReceiverTaskV1): Promise<'done' | 'defer-admission'> {
    let lastError: unknown;
    // Resumed, not reset: see `ReceiverTaskV1.attemptsByProvider`.
    const notFoundProviders = (task.notFoundProviders ??= new Set<string>());
    const attemptsByProvider = (task.attemptsByProvider ??= new Map<string, number>());
    let providerCursor = task.providerCursor ?? 0;
    while (true) {
      if (this.#closing.signal.aborted) return 'done';
      const selection = nextEligibleProvider(
        task.providers,
        notFoundProviders,
        attemptsByProvider,
        this.#maxAttempts,
        providerCursor,
      );
      if (selection === null) {
        if (
          task.providers.length > 0
          && task.providers.every((provider) => notFoundProviders.has(provider.key))
        ) {
          this.#notFound += 1;
          return 'done';
        }
        this.#failed += 1;
        this.#safeNotify(() => this.#onError?.(task.providers[0]!.announcement, lastError));
        return 'done';
      }
      const { provider, nextCursor } = selection;
      providerCursor = nextCursor;
      task.providerCursor = nextCursor;
      const providerAttempt = (attemptsByProvider.get(provider.key) ?? 0) + 1;
      attemptsByProvider.set(provider.key, providerAttempt);
      try {
        if (await this.#reconciler.isHeadApplied(provider.announcement)) {
          this.#dedupedAlreadyApplied += 1;
          return 'done';
        }
        const result = await this.#reconciler.reconcileHead(
          provider.peerId,
          provider.announcement,
          this.#closing.signal,
        );
        if (result === 'not-found') {
          notFoundProviders.add(provider.key);
          continue;
        }
        if (result === 'staged-only') {
          this.#stagedOnly += 1;
          return 'done';
        }
        this.#applied += 1;
        this.#safeNotify(() => this.#onHeadApplied?.(provider.announcement, provider.peerId));
        return 'done';
      } catch (error) {
        if (this.#isDeferrableError(error)) {
          // Not this head's fault and not this provider's fault: roll back ONLY
          // this attempt and let the task wait for the lane outside the slot.
          // Every other provider's tally survives on the task, so contention
          // cannot launder a provider back to a full attempt budget.
          if (providerAttempt <= 1) attemptsByProvider.delete(provider.key);
          else attemptsByProvider.set(provider.key, providerAttempt - 1);
          return 'defer-admission';
        }
        lastError = error;
        if (this.#closing.signal.aborted) return 'done';
        await this.#backoff(providerAttempt - 1);
      }
    }
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
    return this.#active.size === 0 && this.#queue.length === 0 && this.#deferred.size === 0;
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

function catalogScopeKey(a: Rfc64PublicCatalogHeadAnnouncementV1): string {
  return [
    a.networkId,
    a.contextGraphId,
    a.subGraphName ?? '',
    a.authorAddress,
    a.catalogEra,
  ].join('\n');
}

function providerContextKey(
  peerId: string,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return `${peerId}\n${announcement.policyDigest}`;
}

function nextEligibleProvider(
  providers: readonly ReceiverProviderV1[],
  notFoundProviders: ReadonlySet<string>,
  attemptsByProvider: ReadonlyMap<string, number>,
  maxAttempts: number,
  cursor: number,
): { readonly provider: ReceiverProviderV1; readonly nextCursor: number } | null {
  for (let offset = 0; offset < providers.length; offset += 1) {
    const index = (cursor + offset) % providers.length;
    const provider = providers[index];
    if (
      provider !== undefined
      && !notFoundProviders.has(provider.key)
      && (attemptsByProvider.get(provider.key) ?? 0) < maxAttempts
    ) {
      // Keep this monotonic. A modulo cursor would select the first provider
      // again when a new provider is appended after the first attempt.
      return { provider, nextCursor: cursor + offset + 1 };
    }
  }
  return null;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
