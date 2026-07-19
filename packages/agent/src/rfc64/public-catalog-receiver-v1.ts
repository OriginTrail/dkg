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
  readonly onHeadApplied?: (
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
  readonly dedupedAlreadyApplied: number;
  readonly applied: number;
  readonly stagedOnly: number;
  readonly notFound: number;
  readonly failed: number;
  readonly droppedQueueFull: number;
  readonly droppedProviders: number;
  readonly inFlight: number;
  readonly queued: number;
}

interface ReceiverTaskV1 {
  readonly key: string;
  readonly scopeKey: string;
  readonly providers: ReceiverProviderV1[];
  readonly providerKeys: Set<string>;
}

interface ReceiverProviderV1 {
  readonly key: string;
  readonly peerId: string;
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /**
   * Identity of the newest availability observation for this exact provider
   * context. A repeated hint replaces the token so a prior `not-found`
   * observation cannot suppress newly advertised availability while another
   * provider is still being tried. The existing per-provider attempt budget
   * remains the hard bound against duplicate-hint retry amplification.
   */
  observationToken: object;
}

const DEFAULTS = Object.freeze({
  maxConcurrent: 4,
  maxQueue: 1024,
  maxAttempts: 3,
  maxProvidersPerHead: 8,
  retryBackoffMs: 250,
});

export class Rfc64PublicCatalogReceiverV1 {
  readonly #reconciler: Rfc64PublicCatalogReceiverReconcilerV1;
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  readonly #maxAttempts: number;
  readonly #maxProvidersPerHead: number;
  readonly #retryBackoffMs: number;
  readonly #onHeadApplied?: Rfc64PublicCatalogReceiverOptionsV1['onHeadApplied'];
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

  #scheduled = 0;
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
    this.#onHeadApplied = options.onHeadApplied;
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
      if (existing.providerKeys.has(providerKey)) {
        const provider = existing.providers.find((candidate) => candidate.key === providerKey);
        if (provider !== undefined) provider.observationToken = Object.freeze({});
      } else {
        if (existing.providers.length >= this.#maxProvidersPerHead) {
          this.#droppedProviders += 1;
          return;
        }
        existing.providerKeys.add(providerKey);
        existing.providers.push({
          key: providerKey,
          peerId: remotePeerId,
          announcement,
          observationToken: Object.freeze({}),
        });
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
      providers: [{
        key: providerKey,
        peerId: remotePeerId,
        announcement,
        observationToken: Object.freeze({}),
      }],
      providerKeys: new Set([providerKey]),
    };
    this.#pendingByKey.set(key, task);
    this.#queue.push(task);
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
      const run = this.#runTask(task).finally(() => {
        this.#active.delete(run);
        this.#activeScopeKeys.delete(task.scopeKey);
        this.#pendingByKey.delete(task.key);
        if (!this.#closed) this.#pump();
        if (this.#isIdle()) this.#resolveIdle();
      });
      this.#active.add(run);
    }
  }

  async #runTask(task: ReceiverTaskV1): Promise<void> {
    let lastError: unknown;
    const notFoundProviderObservations = new Map<string, object>();
    const attemptsByProvider = new Map<string, number>();
    let providerCursor = 0;
    while (true) {
      if (this.#closing.signal.aborted) return;
      const selection = nextEligibleProvider(
        task.providers,
        notFoundProviderObservations,
        attemptsByProvider,
        this.#maxAttempts,
        providerCursor,
      );
      if (selection === null) {
        if (
          task.providers.length > 0
          && task.providers.every(
            (provider) => notFoundProviderObservations.get(provider.key)
              === provider.observationToken,
          )
        ) {
          this.#notFound += 1;
          return;
        }
        this.#failed += 1;
        this.#safeNotify(() => this.#onError?.(task.providers[0]!.announcement, lastError));
        return;
      }
      const { provider, nextCursor } = selection;
      providerCursor = nextCursor;
      const observationToken = provider.observationToken;
      const providerAttempt = (attemptsByProvider.get(provider.key) ?? 0) + 1;
      attemptsByProvider.set(provider.key, providerAttempt);
      try {
        if (await this.#reconciler.isHeadApplied(provider.announcement)) {
          this.#dedupedAlreadyApplied += 1;
          return;
        }
        const result = await this.#reconciler.reconcileHead(
          provider.peerId,
          provider.announcement,
          this.#closing.signal,
        );
        if (result === 'not-found') {
          notFoundProviderObservations.set(provider.key, observationToken);
          continue;
        }
        if (result === 'staged-only') {
          this.#stagedOnly += 1;
          return;
        }
        this.#applied += 1;
        this.#safeNotify(() => this.#onHeadApplied?.(provider.announcement, provider.peerId));
        return;
      } catch (error) {
        lastError = error;
        if (this.#closing.signal.aborted) return;
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
  notFoundProviderObservations: ReadonlyMap<string, object>,
  attemptsByProvider: ReadonlyMap<string, number>,
  maxAttempts: number,
  cursor: number,
): { readonly provider: ReceiverProviderV1; readonly nextCursor: number } | null {
  for (let offset = 0; offset < providers.length; offset += 1) {
    const index = (cursor + offset) % providers.length;
    const provider = providers[index];
    if (
      provider !== undefined
      && notFoundProviderObservations.get(provider.key) !== provider.observationToken
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
