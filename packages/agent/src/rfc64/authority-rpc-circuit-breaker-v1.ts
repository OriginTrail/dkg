// SPDX-License-Identifier: Apache-2.0

import {
  isRpcEndpointsExhaustedError,
  type ChainReadOptions,
  type ContextGraphAuthorityReadOptions,
  type ContextGraphAuthorityProjectionServedEvidence,
  type RpcEndpointsExhaustedErrorLike,
} from '@origintrail-official/dkg-chain';

import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  './catalog-authority-config-v1.js';

export const RFC64_AUTHORITY_RPC_CIRCUIT_OPEN_CODE_V1 =
  'RFC64_AUTHORITY_RPC_CIRCUIT_OPEN' as const;

export interface Rfc64AuthorityReadCoordinatorOptionsV1 {
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface Rfc64AuthorityReadCoordinatorSnapshotV1 {
  /**
   * `closed` — no exhaustion is outstanding and reads run normally.
   * `open` — an exhaustion is outstanding and the retry deadline is ahead, so
   * governed reads are refused without reaching a provider.
   * `half-open` — an exhaustion is still outstanding but the retry deadline
   * has passed. This does NOT imply a probe is currently in flight: the
   * circuit reports half-open from the deadline onward, including while it
   * sits idle, and clears only once some read proves it reached the pool.
   */
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveExhaustions: number;
  readonly retryAtMs: number | null;
}

/** Options whose `onRpcRead` marker is owned and invoked by an agent resolver. */
export type Rfc64AgentAuthorityResolverReadOptionsV1 = ContextGraphAuthorityReadOptions & Readonly<{
  onRpcRead: () => void;
}>;

export interface Rfc64AuthorityRpcProbeEvidenceV1 {
  /**
   * Build options for an agent authority resolver. The callbacks are the only
   * public evidence surface: the resolver reports when it starts an RPC read,
   * while the chain adapter refines that claim when a projection answers.
   *
   * Callers mark an attempt BEFORE they read, because until the projection
   * cache existed every such read reached the pool. That is no longer true, so
   * the adapter's own account refines the mark:
   *  - `scan` reached the pool now: health.
   *  - `cache`: the projection owner has already proved it is inside the
   *    configured tick, and it counts as health provided that scan started AFTER the
   *    outstanding exhaustion. Without this, a node served entirely from the
   *    cache would keep being judged by a failure it has long recovered from.
   *  - anything else — `log` (folded from the node-local chain event log,
   *    which contacted no endpoint), `stale-cache` (the refresh FAILED and an
   *    older projection answered instead) or a cache hit that predates the
   *    exhaustion: the operation succeeds for its caller but proves nothing
   *    about the pool, and it voids this operation's `markRpcAttempt`.
   */
  agentResolverReadOptions(signal?: AbortSignal): Rfc64AgentAuthorityResolverReadOptionsV1;
  /** Mark and build options for a direct finalized chain/index read. */
  chainReadOptions(signal?: AbortSignal): ChainReadOptions;
}

export interface Rfc64AuthorityReadRunOptionsV1 {
  /**
   * Admit this read even while the circuit is open.
   *
   * The circuit exists to stop a fanned-out refresh pass from stampeding an
   * exhausted pool. It is not a general availability switch: a rare,
   * caller-initiated read whose result cannot be reconstructed later must not
   * be silently downgraded for the length of one backoff window. Such a read
   * still trips the circuit on exhaustion, and its success still counts as
   * recovery evidence. In effect it behaves as an additional half-open probe
   * rather than as a bypass.
   *
   * On `run` it also queues behind the same serializer, so at most one of them
   * reaches the pool at a time. `runUnqueued` accepts this option too and
   * provides no such bound: several of them can reach an exhausted pool at
   * once. Only pass it there for a read that is genuinely rare.
   */
  readonly admitWhileOpen?: boolean;
}

/**
 * A caller-visible deferral, distinct from a failed RPC attempt. Callers may
 * keep their last accepted authority while the shared provider pool cools down.
 */
export class Rfc64AuthorityRpcCircuitOpenErrorV1 extends Error {
  readonly code = RFC64_AUTHORITY_RPC_CIRCUIT_OPEN_CODE_V1;

  constructor(
    readonly retryAtMs: number,
    readonly retryAfterMs: number,
  ) {
    super(`RFC-64 authority RPC circuit is open for another ${retryAfterMs}ms`);
    this.name = 'Rfc64AuthorityRpcCircuitOpenErrorV1';
  }
}

export function isRfc64AuthorityRpcCircuitOpenErrorV1(
  error: unknown,
): error is Rfc64AuthorityRpcCircuitOpenErrorV1 {
  return error instanceof Rfc64AuthorityRpcCircuitOpenErrorV1
    || (
      error !== null
      && typeof error === 'object'
      && (error as { code?: unknown }).code === RFC64_AUTHORITY_RPC_CIRCUIT_OPEN_CODE_V1
    );
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function unitInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Node-local governor shared by every registered RFC-64 authority read.
 *
 * Reads submitted through `run` are serialized even while the circuit is
 * closed. This covers authority bootstrap calls that do not pass through the
 * periodic loop's permit pool and guarantees that, after one full-pool
 * exhaustion, queued graphs observe the open circuit instead of stampeding the
 * same endpoints. Past the retry deadline the serializer admits reads again one
 * at a time; a success that reached the pool closes the circuit and an
 * exhaustion reopens it with the next backoff step.
 *
 * Serialization is a property of `run` alone. `runUnqueued` is for a
 * latency-bounded foreground read that must not spend its budget behind a bulk
 * pass; it keeps everything else the governor provides — the admission check
 * that refuses while the circuit is open, the trip on provider exhaustion, the
 * evidence-gated close, and retirement through `whenIdle`/`close` — but it can
 * run alongside `run` and alongside itself. Because reads on the two lanes
 * overlap, circuit transitions are keyed to a trip generation: a result cannot
 * close a trip that happened after it was admitted, and the failures of one
 * outage round coalesce into a single backoff step.
 *
 * Recovery needs evidence, not merely a fulfilled callback. A read that was
 * answered from local or cached state says nothing about the pool it never
 * contacted, so only an operation that invokes the `onRpcRead` callback from
 * `agentResolverReadOptions`, or uses `chainReadOptions`, can clear an outstanding
 * exhaustion. Until then the circuit stays half-open, which is a statement
 * about eligibility to probe rather than about a probe in flight.
 *
 * Only a typed `RPC_ENDPOINTS_EXHAUSTED` result trips the circuit. Contract
 * reverts and graph-specific validation failures retain their normal behavior.
 */
export class Rfc64AuthorityReadCoordinatorV1 {
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #jitterRatio: number;
  readonly #now: () => number;
  readonly #random: () => number;
  #consecutiveExhaustions = 0;
  #retryAtMs = 0;
  /**
   * Bumped by every trip. A read carries the generation it was admitted under,
   * so a result that predates a trip cannot be mistaken for evidence about the
   * pool state that trip established.
   */
  #tripGeneration = 0;
  #exhaustedAtMs = 0;
  #tail: Promise<void> = Promise.resolve();
  /** In-flight reads admitted without the serializer, retired by `whenIdle`. */
  readonly #unqueued = new Set<Promise<unknown>>();
  #lifecycleAbort = new AbortController();

  constructor(options: Rfc64AuthorityReadCoordinatorOptionsV1 = {}) {
    this.#baseBackoffMs = positiveSafeInteger(
      options.baseBackoffMs
        ?? RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.rpcCircuitBaseBackoffMs,
      'RFC-64 authority RPC circuit baseBackoffMs',
    );
    this.#maxBackoffMs = positiveSafeInteger(
      options.maxBackoffMs
        ?? RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.rpcCircuitMaxBackoffMs,
      'RFC-64 authority RPC circuit maxBackoffMs',
    );
    if (this.#maxBackoffMs < this.#baseBackoffMs) {
      throw new TypeError(
        'RFC-64 authority RPC circuit maxBackoffMs must be at least baseBackoffMs',
      );
    }
    this.#jitterRatio = unitInterval(
      options.jitterRatio
        ?? RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.rpcCircuitJitterRatio,
      'RFC-64 authority RPC circuit jitterRatio',
    );
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  async run<T>(
    signal: AbortSignal | undefined,
    operation: (
      signal: AbortSignal,
      evidence: Rfc64AuthorityRpcProbeEvidenceV1,
    ) => Promise<T>,
    options: Rfc64AuthorityReadRunOptionsV1 = {},
  ): Promise<T> {
    const runSignal = signal === undefined
      ? this.#lifecycleAbort.signal
      : AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(async () => {
      try {
        throwIfAborted(runSignal);
        const now = this.#now();
        if (options.admitWhileOpen !== true && now < this.#retryAtMs) {
          throw new Rfc64AuthorityRpcCircuitOpenErrorV1(
            this.#retryAtMs,
            this.#retryAtMs - now,
          );
        }

        const admittedGeneration = this.#tripGeneration;
        const poolEvidence: {
          value: 'none' | 'attempt' | 'proven' | 'unproven';
        } = { value: 'none' };
        const markRpcAttempt = () => {
          if (poolEvidence.value !== 'proven') poolEvidence.value = 'attempt';
        };
        const observeProjectionServed = (
          served: ContextGraphAuthorityProjectionServedEvidence,
        ) => {
          if (served.source === 'scan') {
            // A completed scan is definitive pool evidence and must outrank an
            // earlier stale-cache answer from another subread in this operation.
            poolEvidence.value = 'proven';
          } else if (
            served.source === 'cache'
            && this.#now() - served.ageMs > this.#exhaustedAtMs
          ) {
            poolEvidence.value = 'proven';
          } else if (poolEvidence.value !== 'proven') {
            // A stale/old cache or a node-local log fold voids a preceding
            // attempt marker, but cannot erase a completed scan proven by
            // another subread. A log fold contacted no endpoint in this read,
            // so its tick timestamp is never evidence that this pool recovered.
            poolEvidence.value = 'unproven';
          }
        };
        const chainReadOptions = (signal?: AbortSignal): ChainReadOptions => {
          markRpcAttempt();
          return Object.freeze({
            ...(signal === undefined ? {} : { signal }),
            onContextGraphAuthorityProjectionServed: observeProjectionServed,
          });
        };
        const evidence: Rfc64AuthorityRpcProbeEvidenceV1 = Object.freeze({
          agentResolverReadOptions: (signal?: AbortSignal) => Object.freeze({
            ...(signal === undefined ? {} : { signal }),
            onRpcRead: markRpcAttempt,
            onContextGraphAuthorityProjectionServed: observeProjectionServed,
          }),
          chainReadOptions,
        });
        try {
          const result = await operation(runSignal, evidence);
          this.#recordSuccess(poolEvidence.value, admittedGeneration);
          return result;
        } catch (error) {
          if (isRpcEndpointsExhaustedError(error)) this.#open(error);
          throw error;
        }
      } finally {
        release();
      }
    });

    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(
        runSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
      );
      runSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => runSignal.removeEventListener('abort', onAbort);
      if (runSignal.aborted) onAbort();
    });
    try {
      return await Promise.race([queued, aborted]);
    } finally {
      removeAbortListener();
      // An aborted waiter settles for its caller immediately, but its queue
      // token stays in FIFO order until the predecessor retires. Consume that
      // later cancellation so it cannot become an unhandled rejection.
      void queued.catch(() => undefined);
    }
  }

  /**
   * Circuit state for one caller-driven read, without queue admission.
   *
   * FIFO admission is the anti-stampede mechanism for bulk per-graph passes:
   * it is what stops a hundred graphs from each walking an exhausted pool. A
   * latency-bounded foreground read that fails closed must not inherit it —
   * queued behind a cold whole-contract scan it would spend its entire budget
   * waiting and deny a policy decision on a node whose pool is healthy. Such a
   * read still refuses while the circuit is open, still trips the circuit on
   * provider exhaustion, and still closes it on proven recovery; it only skips
   * the serializer.
   *
   * Retirement still covers it: `whenIdle` and `close` wait for these reads
   * too, so shutdown cannot leave one in flight.
   */
  async runUnqueued<T>(
    signal: AbortSignal | undefined,
    operation: (
      signal: AbortSignal,
      evidence: Rfc64AuthorityRpcProbeEvidenceV1,
    ) => Promise<T>,
    options: Rfc64AuthorityReadRunOptionsV1 = {},
  ): Promise<T> {
    const runSignal = signal === undefined
      ? this.#lifecycleAbort.signal
      : AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    throwIfAborted(runSignal);
    const now = this.#now();
    if (options.admitWhileOpen !== true && now < this.#retryAtMs) {
      throw new Rfc64AuthorityRpcCircuitOpenErrorV1(
        this.#retryAtMs,
        this.#retryAtMs - now,
      );
    }

    const admittedGeneration = this.#tripGeneration;
    const poolEvidence: {
      value: 'none' | 'attempt' | 'proven' | 'unproven';
    } = { value: 'none' };
    const markRpcAttempt = () => {
      if (poolEvidence.value !== 'proven') poolEvidence.value = 'attempt';
    };
    const observeProjectionServed = (
      served: ContextGraphAuthorityProjectionServedEvidence,
    ) => {
      if (served.source === 'scan') {
        poolEvidence.value = 'proven';
      } else if (
        served.source === 'cache'
        && this.#now() - served.ageMs > this.#exhaustedAtMs
      ) {
        poolEvidence.value = 'proven';
      } else if (poolEvidence.value !== 'proven') {
        poolEvidence.value = 'unproven';
      }
    };
    const chainReadOptions = (signal?: AbortSignal): ChainReadOptions => {
      markRpcAttempt();
      return Object.freeze({
        ...(signal === undefined ? {} : { signal }),
        onContextGraphAuthorityProjectionServed: observeProjectionServed,
      });
    };
    const evidence: Rfc64AuthorityRpcProbeEvidenceV1 = Object.freeze({
      agentResolverReadOptions: (signal?: AbortSignal) => Object.freeze({
        ...(signal === undefined ? {} : { signal }),
        onRpcRead: markRpcAttempt,
        onContextGraphAuthorityProjectionServed: observeProjectionServed,
      }),
      chainReadOptions,
    });
    const active = (async () => {
      try {
        const result = await operation(runSignal, evidence);
        this.#recordSuccess(poolEvidence.value, admittedGeneration);
        return result;
      } catch (error) {
        if (isRpcEndpointsExhaustedError(error)) this.#open(error);
        throw error;
      }
    })();
    this.#unqueued.add(active);
    const untrack = (): void => { this.#unqueued.delete(active); };
    void active.then(untrack, untrack);
    return active;
  }

  async whenIdle(): Promise<void> {
    // Unqueued reads retire independently of the serializer, so quiescence is
    // only reached when neither lane admitted new work while this waited.
    for (;;) {
      const tail = this.#tail;
      const unqueued = [...this.#unqueued];
      await Promise.allSettled([tail, ...unqueued]);
      if (this.#tail === tail && this.#unqueued.size === 0) return;
    }
  }

  close(): Promise<void> {
    if (!this.#lifecycleAbort.signal.aborted) {
      this.#lifecycleAbort.abort(new Error('RFC-64 authority read coordinator is closing'));
    }
    return this.whenIdle();
  }

  reopen(): void {
    if (!this.#lifecycleAbort.signal.aborted) return;
    this.#lifecycleAbort = new AbortController();
  }

  snapshot(): Rfc64AuthorityReadCoordinatorSnapshotV1 {
    const now = this.#now();
    return Object.freeze({
      state: this.#consecutiveExhaustions === 0
        ? 'closed'
        : now < this.#retryAtMs
          ? 'open'
          : 'half-open',
      consecutiveExhaustions: this.#consecutiveExhaustions,
      retryAtMs: this.#retryAtMs > now ? this.#retryAtMs : null,
    });
  }

  /**
   * Clear an outstanding exhaustion once a read proves the pool answered.
   *
   * A local or cached answer cannot prove that an exhausted pool came back, so
   * it never clears. Neither can a read that was admitted before the trip it
   * would be clearing: `runUnqueued` overlaps `run`, so a read that reached the
   * pool while it was still healthy can settle after a later read exhausted it,
   * and honoring that as evidence would discard a live cooldown and restart the
   * backoff ladder. Only evidence gathered under the current generation counts.
   */
  #recordSuccess(
    poolEvidence: 'none' | 'attempt' | 'proven' | 'unproven',
    admittedGeneration: number,
  ): void {
    if (
      this.#consecutiveExhaustions === 0
      || (
        (poolEvidence === 'attempt' || poolEvidence === 'proven')
        && this.#tripGeneration === admittedGeneration
      )
    ) {
      this.#consecutiveExhaustions = 0;
      this.#retryAtMs = 0;
    }
  }

  #open(error: RpcEndpointsExhaustedErrorLike): void {
    // One outage round costs one backoff step. Under `run` the serializer
    // enforced that on its own: after the first trip the next admitted read was
    // refused before it reached a provider. `runUnqueued` admits at call time,
    // so every read already in flight when the pool failed lands here with the
    // same outage. Escalation is the job of the read that fails after the
    // deadline has passed, not of that read's concurrent siblings.
    const providerDelay = typeof error.retryAfterMs === 'number'
      && Number.isFinite(error.retryAfterMs)
      && error.retryAfterMs >= 0
      ? Math.round(error.retryAfterMs)
      : 0;
    if (this.#now() < this.#retryAtMs) {
      // Coalescing suppresses the backoff ladder, not the provider's own
      // backpressure: a sibling that was told to wait longer still moves the
      // shared deadline out, without advancing the generation or the counter.
      if (providerDelay > 0) {
        this.#retryAtMs = Math.max(
          this.#retryAtMs,
          this.#now() + Math.min(this.#maxBackoffMs, providerDelay),
        );
      }
      return;
    }
    this.#tripGeneration += 1;
    this.#consecutiveExhaustions += 1;
    this.#exhaustedAtMs = this.#now();
    const exponent = Math.min(this.#consecutiveExhaustions - 1, 30);
    const exponential = Math.min(
      this.#maxBackoffMs,
      this.#baseBackoffMs * (2 ** exponent),
    );
    const sample = this.#random();
    // Backpressure must never replace the original RPC failure because an
    // injected/random source misbehaved. Production Math.random is bounded;
    // defensively fall back to the midpoint for any foreign value.
    const random = Number.isFinite(sample) && sample >= 0 && sample <= 1
      ? sample
      : 0.5;
    const jitterMultiplier = 1 + ((random * 2) - 1) * this.#jitterRatio;
    const jittered = Math.round(exponential * jitterMultiplier);
    const delay = Math.min(
      this.#maxBackoffMs,
      Math.max(1, jittered, providerDelay),
    );
    this.#retryAtMs = this.#now() + delay;
  }
}
