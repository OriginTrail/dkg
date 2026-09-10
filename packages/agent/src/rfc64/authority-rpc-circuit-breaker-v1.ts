// SPDX-License-Identifier: Apache-2.0

import {
  isRpcEndpointsExhaustedError,
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
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveExhaustions: number;
  readonly retryAtMs: number | null;
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
 * Work is serialized even while the circuit is closed. This covers authority
 * bootstrap calls that do not pass through the periodic loop's permit pool and
 * guarantees that, after one full-pool exhaustion, queued graphs observe the
 * open circuit instead of stampeding the same endpoints. At the retry deadline
 * the serializer admits exactly one half-open probe; its success closes the
 * circuit and its exhaustion reopens it with the next backoff step.
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
  #running = false;
  #tail: Promise<void> = Promise.resolve();
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
    operation: (signal: AbortSignal | undefined) => Promise<T>,
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
        if (now < this.#retryAtMs) {
          throw new Rfc64AuthorityRpcCircuitOpenErrorV1(
            this.#retryAtMs,
            this.#retryAtMs - now,
          );
        }

        this.#running = true;
        try {
          const result = await operation(runSignal);
          this.#consecutiveExhaustions = 0;
          this.#retryAtMs = 0;
          return result;
        } catch (error) {
          if (isRpcEndpointsExhaustedError(error)) this.#open(error);
          throw error;
        } finally {
          this.#running = false;
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

  whenIdle(): Promise<void> {
    return this.#tail;
  }

  close(): Promise<void> {
    if (!this.#lifecycleAbort.signal.aborted) {
      this.#lifecycleAbort.abort(new Error('RFC-64 authority read coordinator is closing'));
    }
    return this.#tail;
  }

  reopen(): void {
    if (!this.#lifecycleAbort.signal.aborted) return;
    this.#lifecycleAbort = new AbortController();
  }

  snapshot(): Rfc64AuthorityReadCoordinatorSnapshotV1 {
    const now = this.#now();
    return Object.freeze({
      state: this.#running && this.#consecutiveExhaustions > 0
        ? 'half-open'
        : now < this.#retryAtMs
          ? 'open'
          : 'closed',
      consecutiveExhaustions: this.#consecutiveExhaustions,
      retryAtMs: this.#retryAtMs > now ? this.#retryAtMs : null,
    });
  }

  #open(error: RpcEndpointsExhaustedErrorLike): void {
    this.#consecutiveExhaustions += 1;
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
    const providerDelay = typeof error.retryAfterMs === 'number'
      && Number.isFinite(error.retryAfterMs)
      && error.retryAfterMs >= 0
      ? Math.round(error.retryAfterMs)
      : 0;
    const delay = Math.min(
      this.#maxBackoffMs,
      Math.max(1, jittered, providerDelay),
    );
    this.#retryAtMs = this.#now() + delay;
  }
}
