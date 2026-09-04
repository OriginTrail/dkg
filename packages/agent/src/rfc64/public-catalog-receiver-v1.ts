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

import {
  Rfc64CatalogProviderFailureAggregateV1,
  type Rfc64CatalogProviderTerminalFailureV1,
} from './public-catalog-reconciliation-failure-v1.js';
import {
  createRfc64PublicCatalogReceiverCompletionV1,
  type Rfc64PublicCatalogReceiverCompletionV1,
} from './public-catalog-reconciliation-outcome-v1.js';
import {
  Rfc64ReceiverTaskLifecycleV1,
  rfc64ReceiverSchedulingPolicyV1,
  rfc64ReceiverCatalogScopeKeyV1,
  rfc64ReceiverHeadKeyV1,
  rfc64ReceiverNonNegativeIntV1,
  rfc64ReceiverPositiveIntV1,
  rfc64ReceiverProviderContextKeyV1,
  type Rfc64ReceiverLifecycleTaskV1,
  type Rfc64ReceiverSchedulingClassV1,
} from './public-catalog-receiver-task-lifecycle-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export type {
  Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  Rfc64PublicCatalogReceiverCompletionV1,
} from './public-catalog-reconciliation-outcome-v1.js';

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
  /**
   * Scheduling-time observer called once for a distinct exact-head request.
   * It is not an execution boundary and must not own attempt-scoped state.
   */
  readonly onAttemptStart?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => void;
  /** @deprecated Observer-only compatibility hook for execution start. */
  readonly onReconciliationAttemptStart?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => number;
  /** @deprecated Observer-only compatibility hook for successful execution. */
  readonly onReconciliationAttemptSuccess?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    attemptToken: number,
  ) => void;
  /** @deprecated Observer-only compatibility hook for balanced terminal cleanup. */
  readonly onReconciliationAttemptEnd?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    attemptToken: number,
  ) => void;
  readonly onError?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    error: unknown,
    /** @deprecated Attempt token retained for callback compatibility. */
    attemptToken: number | null,
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
  /** Older ambient heads discarded after a verified current head became durable. */
  readonly supersededQueued: number;
  /**
   * Times a task stepped aside for a busy finalized chain lane. Distinct from
   * `failed`: the head is still pending, not lost.
   */
  readonly admissionDeferred: number;
  /** Accepted heads currently waiting on the chain lane: neither queued nor active. */
  readonly deferred: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly providerAttempts: number;
  readonly providerSwitches: number;
  readonly providerSuccesses: number;
  readonly providerBackoffMs: number;
}

interface ReceiverTaskV1 extends Rfc64ReceiverLifecycleTaskV1 {
  readonly key: string;
  readonly scopeKey: string;
  readonly contextGraphId: string;
  readonly catalogVersion: bigint;
  readonly cancellation: AbortController;
  /** Canonical provider registry; Map insertion order is the round-robin order. */
  readonly providers: Map<string, ReceiverProviderV1>;
  /** Monotonic accepted mutation revision used to close the settlement race. */
  revision: bigint;
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
  /** Latest non-deferrable terminal error for each bounded provider. */
  terminalFailuresByProvider?: Map<string, Rfc64CatalogProviderTerminalFailureV1>;
  /** Latest provider hint revision that returned not-found. */
  notFoundProviderRevisions?: Map<string, bigint>;
  providerCursor?: number;
  lastProviderKey?: string;
  providerAttempts?: number;
  completionWaiters?: Array<(result: Rfc64PublicCatalogReceiverCompletionV1) => void>;
  reconciliationAttemptStarted?: boolean;
  reconciliationAttemptToken?: number | null;
  reconciliationAttemptEnded?: boolean;
  running?: boolean;
  settled?: boolean;
}

interface ReceiverProviderV1 {
  readonly key: string;
  readonly peerId: string;
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /**
   * Monotonic availability observation for this exact provider context. A
   * repeated hint advances the revision so a prior `not-found` observation
   * cannot suppress newly advertised availability while another provider is
   * still being tried. The existing per-provider attempt budget remains the
   * hard bound against duplicate-hint retry amplification.
   */
  hintRevision: bigint;
}

type ReceiverTaskOutcomeV1 =
  | { readonly kind: 'defer-admission' }
  | { readonly kind: 'aborted' }
  | {
    readonly kind: 'already-applied';
    readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  }
  | {
    readonly kind: 'applied';
    readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
    readonly peerId: string;
  }
  | { readonly kind: 'staged-only'; readonly taskRevision: bigint }
  | { readonly kind: 'not-found'; readonly taskRevision: bigint }
  | {
    readonly kind: 'failed';
    readonly taskRevision: bigint;
    readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
    readonly error: unknown;
  };

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
  readonly #onReconciliationAttemptStart?:
    Rfc64PublicCatalogReceiverOptionsV1['onReconciliationAttemptStart'];
  readonly #onReconciliationAttemptSuccess?:
    Rfc64PublicCatalogReceiverOptionsV1['onReconciliationAttemptSuccess'];
  readonly #onReconciliationAttemptEnd?:
    Rfc64PublicCatalogReceiverOptionsV1['onReconciliationAttemptEnd'];
  readonly #onError?: Rfc64PublicCatalogReceiverOptionsV1['onError'];

  /** Every exact head and its queued/deferred/terminal task lifecycle. */
  readonly #tasks = new Rfc64ReceiverTaskLifecycleV1<ReceiverTaskV1>();
  /** Execution promises only; task state and scope ownership live in #tasks. */
  readonly #active = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  #closed = false;
  #idleWaiters: Array<() => void> = [];

  readonly #admissionDeferralMs: number;
  readonly #maxAdmissionDeferrals: number;
  readonly #isDeferrableError: (error: unknown) => boolean;
  #isolatedCompletionSequence = 0;

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
  #supersededQueued = 0;
  #providerAttempts = 0;
  #providerSwitches = 0;
  #providerSuccesses = 0;
  #providerBackoffMs = 0;

  constructor(
    reconciler: Rfc64PublicCatalogReceiverReconcilerV1,
    options: Rfc64PublicCatalogReceiverOptionsV1 = {},
  ) {
    this.#reconciler = reconciler;
    this.#maxConcurrent = rfc64ReceiverPositiveIntV1(
      options.maxConcurrent,
      DEFAULTS.maxConcurrent,
    );
    this.#maxQueue = rfc64ReceiverPositiveIntV1(options.maxQueue, DEFAULTS.maxQueue);
    this.#maxAttempts = rfc64ReceiverPositiveIntV1(
      options.maxAttempts,
      DEFAULTS.maxAttempts,
    );
    this.#maxProvidersPerHead = rfc64ReceiverPositiveIntV1(
      options.maxProvidersPerHead,
      DEFAULTS.maxProvidersPerHead,
    );
    this.#retryBackoffMs = rfc64ReceiverNonNegativeIntV1(
      options.retryBackoffMs,
      DEFAULTS.retryBackoffMs,
    );
    this.#admissionDeferralMs = rfc64ReceiverNonNegativeIntV1(
      options.admissionDeferralMs,
      DEFAULTS.admissionDeferralMs,
    );
    this.#maxAdmissionDeferrals = rfc64ReceiverPositiveIntV1(
      options.maxAdmissionDeferrals,
      DEFAULTS.maxAdmissionDeferrals,
    );
    this.#isDeferrableError = options.isDeferrableError ?? DEFAULT_DEFERRABLE_ERROR;
    this.#onHeadApplied = options.onHeadApplied;
    this.#onAttemptStart = options.onAttemptStart;
    this.#onReconciliationAttemptStart = options.onReconciliationAttemptStart;
    this.#onReconciliationAttemptSuccess = options.onReconciliationAttemptSuccess;
    this.#onReconciliationAttemptEnd = options.onReconciliationAttemptEnd;
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
    this.scheduleMany([{ announcement, remotePeerId }]);
  }

  /** Atomically retain all discovered providers before the first fetch starts. */
  scheduleMany(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
  ): void {
    this.#scheduleMany(inputs);
  }

  /** Schedule one exact head and await that task's result, not global idleness. */
  scheduleManyAndWait(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
  ): Promise<Rfc64PublicCatalogReceiverCompletionV1> {
    if (inputs.length === 0) {
      throw new TypeError('RFC-64 receiver completion requires at least one provider');
    }
    const firstKey = rfc64ReceiverHeadKeyV1(inputs[0]!.announcement);
    if (inputs.some(({ announcement }) => rfc64ReceiverHeadKeyV1(announcement) !== firstKey)) {
      throw new TypeError('RFC-64 receiver completion inputs must name one exact head');
    }
    const exactProviderKeys = new Set(inputs.map(({ announcement, remotePeerId }) => (
      rfc64ReceiverProviderContextKeyV1(remotePeerId, announcement)
    )));
    if (exactProviderKeys.size !== inputs.length) {
      throw new TypeError('RFC-64 receiver completion providers must be distinct');
    }
    // Explicit synchronization owns an immutable request-scoped provider set.
    // Ambient hints keep their configurable per-head cap and coalescing; an
    // awaited failover request must retain every provider already validated by
    // the service, even when maxProvidersPerHead is lower.
    return new Promise((resolve) => this.#scheduleIsolatedCompletion(
      inputs,
      resolve,
      'isolated',
    ));
  }

  /**
   * Await a head already discovered, fetched by exact digest, and verified by
   * the catalog service as the current head for its chain-bound scope.
   *
   * Unlike an ambient announcement, this authenticated recovery task may move
   * ahead of older queued heads in the same scope. If it becomes durable, only
   * strictly older ambient work is then retired. A failed jump leaves the
   * history queue intact so monotonic reconciliation can still proceed.
   */
  scheduleVerifiedCurrentHeadAndWait(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
  ): Promise<Rfc64PublicCatalogReceiverCompletionV1> {
    if (inputs.length === 0) {
      throw new TypeError('RFC-64 verified current-head completion requires at least one provider');
    }
    const firstKey = rfc64ReceiverHeadKeyV1(inputs[0]!.announcement);
    if (inputs.some(({ announcement }) => rfc64ReceiverHeadKeyV1(announcement) !== firstKey)) {
      throw new TypeError('RFC-64 verified current-head providers must name one exact head');
    }
    const exactProviderKeys = new Set(inputs.map(({ announcement, remotePeerId }) => (
      rfc64ReceiverProviderContextKeyV1(remotePeerId, announcement)
    )));
    if (exactProviderKeys.size !== inputs.length) {
      throw new TypeError('RFC-64 verified current-head providers must be distinct');
    }
    return new Promise((resolve) => this.#scheduleIsolatedCompletion(
      inputs,
      resolve,
      'verified-current-head',
    ));
  }

  #scheduleMany(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
  ): void {
    if (this.#closed) return;
    for (const { announcement, remotePeerId } of inputs) {
      this.#scheduled += 1;
      const key = rfc64ReceiverHeadKeyV1(announcement);
      const candidate = this.#tasks.pending(key);
      const existing = candidate?.cancellation.signal.aborted === true
        ? undefined
        : candidate;
      if (existing !== undefined) {
        this.#dedupedInFlight += 1;
        const providerKey = rfc64ReceiverProviderContextKeyV1(remotePeerId, announcement);
        const provider = existing.providers.get(providerKey);
        if (provider !== undefined) {
          provider.hintRevision += 1n;
        } else {
          if (existing.providers.size >= this.#maxProvidersPerHead) {
            this.#droppedProviders += 1;
            continue;
          }
          existing.providers.set(providerKey, {
            key: providerKey,
            peerId: remotePeerId,
            announcement,
            hintRevision: 1n,
          });
        }
        existing.revision += 1n;
        continue;
      }
      this.#safeNotify(() => this.#onAttemptStart?.(announcement));
      if (this.#tasks.queuedCount >= this.#maxQueue) {
        this.#droppedQueueFull += 1;
        continue;
      }
      const task = this.#createTask(
        [{ announcement, remotePeerId }],
        'ambient',
        key,
      );
      this.#tasks.schedule(task);
    }
    this.#pump();
  }

  /**
   * Single validated construction boundary for every scheduler task class.
   * After this point catalogVersion is numeric, the provider set names one
   * exact head, and placement/supersession behavior is an explicit policy.
   */
  #createTask(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
    schedulingClass: Rfc64ReceiverSchedulingClassV1,
    key: string,
    completion?: (result: Rfc64PublicCatalogReceiverCompletionV1) => void,
  ): ReceiverTaskV1 {
    const first = inputs[0];
    if (first === undefined) {
      throw new TypeError('RFC-64 receiver task requires at least one provider');
    }
    const exactHeadKey = rfc64ReceiverHeadKeyV1(first.announcement);
    const providers = new Map<string, ReceiverProviderV1>();
    for (const { announcement, remotePeerId } of inputs) {
      if (rfc64ReceiverHeadKeyV1(announcement) !== exactHeadKey) {
        throw new TypeError('RFC-64 receiver task providers must name one exact head');
      }
      const providerKey = rfc64ReceiverProviderContextKeyV1(remotePeerId, announcement);
      if (providers.has(providerKey)) {
        throw new TypeError('RFC-64 receiver task providers must be distinct');
      }
      providers.set(providerKey, {
        key: providerKey,
        peerId: remotePeerId,
        announcement,
        hintRevision: 1n,
      });
    }
    return {
      key,
      scopeKey: rfc64ReceiverCatalogScopeKeyV1(first.announcement),
      contextGraphId: first.announcement.contextGraphId,
      catalogVersion: parseCatalogVersionV1(first.announcement.catalogVersion),
      schedulingPolicy: rfc64ReceiverSchedulingPolicyV1(schedulingClass),
      cancellation: new AbortController(),
      revision: 1n,
      providers,
      ...(completion === undefined ? {} : { completionWaiters: [completion] }),
    };
  }

  /**
   * Keep an explicit synchronization request on exactly its caller-supplied
   * providers when process-wide work for the same head already contains an
   * ambient provider. The shared scope lock still prevents two semantic
   * writers; the isolated task therefore observes `already-applied` when the
   * earlier task wins, but it can never report that ambient peer as its own
   * applied provider.
   */
  #scheduleIsolatedCompletion(
    inputs: readonly Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }>[],
    completion: (result: Rfc64PublicCatalogReceiverCompletionV1) => void,
    schedulingClass: Exclude<Rfc64ReceiverSchedulingClassV1, 'ambient'>,
  ): void {
    // An awaited request can arrive after discovery has completed but after
    // service shutdown closed the receiver. A closed receiver never pumps its
    // queue, so resolve at the scheduling boundary instead of enqueuing a
    // completion that can never settle.
    if (this.#closed) {
      completion(createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: 0,
      }));
      return;
    }
    this.#scheduled += inputs.length;
    const first = inputs[0]!;
    this.#safeNotify(() => this.#onAttemptStart?.(first.announcement));
    if (this.#tasks.queuedCount >= this.#maxQueue) {
      this.#droppedQueueFull += 1;
      completion(createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'dropped',
        providerAttempts: 0,
      }));
      return;
    }
    const task = this.#createTask(
      inputs,
      schedulingClass,
      `${rfc64ReceiverHeadKeyV1(first.announcement)}\nexplicit-provider-set:${
        ++this.#isolatedCompletionSequence
      }`,
      completion,
    );
    this.#tasks.schedule(task);
    this.#pump();
  }

  /** Resolve once no work is queued or in-flight. */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Fence queued, deferred, and active work for one no-longer-selected CG. */
  cancelContextGraph(contextGraphId: string): void {
    this.#tasks.cancelContextGraph(
      contextGraphId,
      new Error(`RFC-64 receiver selection inactive for ${contextGraphId}`),
      (task) => createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: task.providerAttempts ?? 0,
      }),
      (task) => this.#finishReconciliationAttempt(task),
      (waiter) => this.#safeNotify(waiter),
    );
    if (this.#isIdle()) this.#resolveIdle();
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
    this.#tasks.abortAll(new Error('RFC-64 public catalog receiver closing'));
    this.#tasks.clearDeferredTimers();
    this.#tasks.finalizeNonRunning(
      (task) => createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: task.providerAttempts ?? 0,
      }),
      (task) => this.#finishReconciliationAttempt(task),
      (waiter) => this.#safeNotify(waiter),
    );
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
      supersededQueued: this.#supersededQueued,
      admissionDeferred: this.#admissionDeferred,
      deferred: this.#tasks.deferredCount,
      inFlight: this.#tasks.activeCount,
      queued: this.#tasks.queuedCount,
      providerAttempts: this.#providerAttempts,
      providerSwitches: this.#providerSwitches,
      providerSuccesses: this.#providerSuccesses,
      providerBackoffMs: this.#providerBackoffMs,
    });
  }

  #pump(): void {
    while (
      !this.#closed
      && this.#tasks.activeCount < this.#maxConcurrent
      && this.#tasks.queuedCount > 0
    ) {
      const task = this.#tasks.takeNextRunnable();
      if (task === undefined) return;
      if (task.cancellation.signal.aborted) {
        this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
          outcome: 'closed',
          providerAttempts: task.providerAttempts ?? 0,
        }));
        continue;
      }
      this.#tasks.begin(task);
      const run = this.#runTask(task).then((outcome) => {
        // A deferral releases the concurrency slot AND the semantic scope lock
        // before waiting, and keeps the pending key so a duplicate announcement
        // still dedupes onto this task instead of creating a second writer.
        if (
          outcome.kind === 'defer-admission'
          && !this.#closed
          && !task.cancellation.signal.aborted
        ) {
          this.#scheduleAdmissionRetry(task);
          return;
        }
        if (
          !this.#closed
          && 'taskRevision' in outcome
          && outcome.taskRevision !== task.revision
        ) {
          // `#runTask` chose a non-durable terminal result, then `schedule`
          // accepted a fresher hint before this completion continuation ran.
          // Keep the pending key and put the mutated task back through the
          // scheduler instead of deleting the accepted observation.
          if (!this.#tasks.requeue(task)) {
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'closed',
              providerAttempts: task.providerAttempts ?? 0,
            }));
          }
          return;
        }
        switch (outcome.kind) {
          case 'already-applied':
            this.#dedupedAlreadyApplied += 1;
            this.#retireSupersededAmbientHeads(task);
            this.#finishSuccessfulReconciliationAttempt(task, outcome.announcement);
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'already-applied',
              providerAttempts: task.providerAttempts ?? 0,
            }));
            break;
          case 'applied':
            this.#applied += 1;
            this.#providerSuccesses += 1;
            this.#retireSupersededAmbientHeads(task);
            this.#safeNotify(() => this.#onHeadApplied?.(
              outcome.announcement,
              outcome.peerId,
            ));
            this.#finishSuccessfulReconciliationAttempt(task, outcome.announcement);
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'applied',
              appliedProviderPeerId: outcome.peerId,
              providerAttempts: task.providerAttempts ?? 0,
            }));
            break;
          case 'staged-only':
            this.#stagedOnly += 1;
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'staged-only',
              providerAttempts: task.providerAttempts ?? 0,
            }));
            break;
          case 'not-found':
            this.#notFound += 1;
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'not-found',
              providerAttempts: task.providerAttempts ?? 0,
            }));
            break;
          case 'failed':
            this.#failed += 1;
            this.#safeNotify(() => this.#onError?.(
              outcome.announcement,
              outcome.error,
              task.reconciliationAttemptToken ?? null,
            ));
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'failed',
              providerAttempts: task.providerAttempts ?? 0,
              error: outcome.error,
            }));
            break;
          case 'aborted':
          case 'defer-admission':
            this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
              outcome: 'closed',
              providerAttempts: task.providerAttempts ?? 0,
            }));
            break;
        }
      }).finally(() => {
        this.#tasks.finishRunning(task);
        this.#active.delete(run);
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
      const firstProvider = task.providers.values().next().value;
      this.#safeNotify(() => this.#onError?.(
        firstProvider!.announcement,
        new Error('RFC-64 receiver gave up waiting for the finalized chain-read lane'),
        task.reconciliationAttemptToken ?? null,
      ));
      this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'failed',
        providerAttempts: task.providerAttempts ?? 0,
        error: new Error('RFC-64 receiver gave up waiting for the finalized chain-read lane'),
      }));
      if (this.#isIdle()) this.#resolveIdle();
      return;
    }
    // Registered BEFORE the timer is armed: between these two statements the
    // task must never be invisible to the idle predicate.
    if (!this.#tasks.defer(task, this.#admissionDeferralMs, () => {
      if (
        this.#closed
        || this.#closing.signal.aborted
        || task.cancellation.signal.aborted
      ) {
        this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
          outcome: 'closed',
          providerAttempts: task.providerAttempts ?? 0,
        }));
        if (this.#isIdle()) this.#resolveIdle();
        return;
      }
      if (this.#tasks.requeue(task)) this.#pump();
    })) {
      this.#finishTask(task, createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: task.providerAttempts ?? 0,
      }));
      return;
    }
  }

  async #runTask(task: ReceiverTaskV1): Promise<ReceiverTaskOutcomeV1> {
    this.#beginReconciliationAttempt(task);
    // Resumed, not reset: see `ReceiverTaskV1.attemptsByProvider`.
    const notFoundProviderRevisions = (
      task.notFoundProviderRevisions ??= new Map<string, bigint>()
    );
    const attemptsByProvider = (task.attemptsByProvider ??= new Map<string, number>());
    const terminalFailuresByProvider = (
      task.terminalFailuresByProvider ??= new Map<
        string,
        Rfc64CatalogProviderTerminalFailureV1
      >()
    );
    let providerCursor = task.providerCursor ?? 0;
    while (true) {
      if (this.#closing.signal.aborted || task.cancellation.signal.aborted) {
        return { kind: 'aborted' };
      }
      const providers = [...task.providers.values()];
      const selection = nextEligibleProvider(
        providers,
        notFoundProviderRevisions,
        attemptsByProvider,
        this.#maxAttempts,
        providerCursor,
      );
      if (selection === null) {
        if (
          providers.length > 0
          && providers.every(
            (provider) => notFoundProviderRevisions.get(provider.key)
              === provider.hintRevision,
          )
        ) {
          return { kind: 'not-found', taskRevision: task.revision };
        }
        return {
          kind: 'failed',
          taskRevision: task.revision,
          announcement: providers[0]!.announcement,
          error: terminalFailuresByProvider.size > 0
            ? providerFailureV1(providers.length, terminalFailuresByProvider)
            : new Error(
              'RFC-64 receiver exhausted the per-provider attempt budget before '
              + 'reconciling the latest accepted provider hint',
            ),
        };
      }
      const { provider, nextCursor } = selection;
      providerCursor = nextCursor;
      task.providerCursor = nextCursor;
      const hintRevision = provider.hintRevision;
      const providerAttempt = (attemptsByProvider.get(provider.key) ?? 0) + 1;
      attemptsByProvider.set(provider.key, providerAttempt);
      const recordProviderAttempt = () => {
        this.#providerAttempts += 1;
        task.providerAttempts = (task.providerAttempts ?? 0) + 1;
        if (task.lastProviderKey !== undefined && task.lastProviderKey !== provider.key) {
          this.#providerSwitches += 1;
        }
        task.lastProviderKey = provider.key;
      };
      try {
        if (await this.#reconciler.isHeadApplied(provider.announcement)) {
          recordProviderAttempt();
          return { kind: 'already-applied', announcement: provider.announcement };
        }
        const result = await this.#reconciler.reconcileHead(
          provider.peerId,
          provider.announcement,
          task.cancellation.signal,
        );
        if (task.cancellation.signal.aborted) return { kind: 'aborted' };
        recordProviderAttempt();
        if (result === 'not-found') {
          terminalFailuresByProvider.delete(provider.key);
          notFoundProviderRevisions.set(provider.key, hintRevision);
          continue;
        }
        if (result === 'staged-only') {
          return { kind: 'staged-only', taskRevision: task.revision };
        }
        return {
          kind: 'applied',
          announcement: provider.announcement,
          peerId: provider.peerId,
        };
      } catch (error) {
        if (this.#closing.signal.aborted || task.cancellation.signal.aborted) {
          return { kind: 'aborted' };
        }
        if (this.#isDeferrableError(error)) {
          // Not this head's fault and not this provider's fault: roll back ONLY
          // this attempt and let the task wait for the lane outside the slot.
          // Every other provider's tally survives on the task, so contention
          // cannot launder a provider back to a full attempt budget.
          if (providerAttempt <= 1) attemptsByProvider.delete(provider.key);
          else attemptsByProvider.set(provider.key, providerAttempt - 1);
          return { kind: 'defer-admission' };
        }
        recordProviderAttempt();
        terminalFailuresByProvider.set(provider.key, Object.freeze({
          providerPeerId: provider.peerId,
          error,
        }));
        if (this.#closing.signal.aborted || task.cancellation.signal.aborted) {
          return { kind: 'aborted' };
        }
        await this.#backoff(providerAttempt - 1, task.cancellation.signal);
      }
    }
  }

  #backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const delay = this.#retryBackoffMs * 2 ** attempt;
    if (delay <= 0) return Promise.resolve();
    this.#providerBackoffMs += delay;
    return new Promise<void>((resolve) => {
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

  #beginReconciliationAttempt(task: ReceiverTaskV1): void {
    if (task.reconciliationAttemptStarted === true) return;
    task.reconciliationAttemptStarted = true;
    try {
      const firstProvider = task.providers.values().next().value;
      task.reconciliationAttemptToken =
        this.#onReconciliationAttemptStart?.(firstProvider!.announcement) ?? null;
    } catch {
      task.reconciliationAttemptToken = null;
    }
  }

  #finishSuccessfulReconciliationAttempt(
    task: ReceiverTaskV1,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): void {
    const token = task.reconciliationAttemptToken;
    if (token === undefined || token === null) return;
    this.#safeNotify(() => this.#onReconciliationAttemptSuccess?.(announcement, token));
  }

  #retireSupersededAmbientHeads(appliedTask: ReceiverTaskV1): void {
    const appliedVersion = appliedTask.catalogVersion;
    if (!appliedTask.schedulingPolicy.retiresOlderAmbientAfterDurableSuccess) {
      return;
    }
    this.#supersededQueued += this.#tasks.finalizeNonRunningWhere(
      (candidate) => (
        candidate.schedulingPolicy.schedulingClass === 'ambient'
        && candidate.scopeKey === appliedTask.scopeKey
        && candidate.catalogVersion < appliedVersion
      ),
      (candidate) => createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: candidate.providerAttempts ?? 0,
      }),
      (candidate) => this.#finishReconciliationAttempt(candidate),
      (waiter) => this.#safeNotify(waiter),
    );
  }

  #finishTask(
    task: ReceiverTaskV1,
    result: Rfc64PublicCatalogReceiverCompletionV1,
  ): void {
    this.#tasks.finalize(
      task,
      result,
      (settledTask) => this.#finishReconciliationAttempt(settledTask),
      (waiter) => this.#safeNotify(waiter),
    );
  }

  #finishReconciliationAttempt(task: ReceiverTaskV1): void {
    if (task.reconciliationAttemptEnded === true) return;
    task.reconciliationAttemptEnded = true;
    const token = task.reconciliationAttemptToken;
    if (token === undefined || token === null) return;
    const firstProvider = task.providers.values().next().value;
    if (firstProvider === undefined) return;
    this.#safeNotify(() => this.#onReconciliationAttemptEnd?.(
      firstProvider.announcement,
      token,
    ));
  }

  #isIdle(): boolean {
    return this.#tasks.isIdle;
  }

  #resolveIdle(): void {
    if (!this.#isIdle()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

function parseCatalogVersionV1(value: string): bigint {
  try {
    const version = BigInt(value);
    if (version < 0n) throw new TypeError('catalog version must be non-negative');
    return version;
  } catch (cause) {
    throw new TypeError('validated catalog version must be a non-negative integer', {
      cause,
    });
  }
}

function nextEligibleProvider(
  providers: readonly ReceiverProviderV1[],
  notFoundProviderRevisions: ReadonlyMap<string, bigint>,
  attemptsByProvider: ReadonlyMap<string, number>,
  maxAttempts: number,
  cursor: number,
): { readonly provider: ReceiverProviderV1; readonly nextCursor: number } | null {
  for (let offset = 0; offset < providers.length; offset += 1) {
    const index = (cursor + offset) % providers.length;
    const provider = providers[index];
    const attempts = provider === undefined
      ? maxAttempts
      : attemptsByProvider.get(provider.key) ?? 0;
    if (
      provider !== undefined
      && notFoundProviderRevisions.get(provider.key) !== provider.hintRevision
      && attempts < maxAttempts
    ) {
      // Preserve round-robin order. A provider that just stepped aside for
      // admission contention must not jump ahead of a fresher hint that is
      // next at the cursor merely because its rolled-back attempt count is
      // lower.
      return { provider, nextCursor: cursor + offset + 1 };
    }
  }
  return null;
}

function providerFailureV1(
  attemptedProviderCount: number,
  failuresByProvider: ReadonlyMap<string, Rfc64CatalogProviderTerminalFailureV1>,
): unknown {
  const failures = [...failuresByProvider.values()];
  // Preserve the long-standing single-provider error identity and code.
  if (attemptedProviderCount === 1 && failures.length === 1) return failures[0]!.error;
  return new Rfc64CatalogProviderFailureAggregateV1(attemptedProviderCount, failures);
}
