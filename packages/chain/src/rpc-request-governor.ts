// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import { ChainRpcTransportError } from './chain-rpc-transport-error.js';
import {
  activeRpcRequestAbortSignal,
  throwRpcRequestAbortReason,
} from './rpc-request-transport.js';

export type RpcRequestClass = 'foreground' | 'background';

export interface RpcRequestGovernorPolicyInput {
  /** Total node-process RPC request rate. Defaults to 10 requests/second. */
  maxRequestsPerSecond?: number;
  /** Percentage of total capacity unavailable to background work. Defaults to 80. */
  foregroundReservePercent?: number;
  /** Total request burst capacity. Defaults to 20 requests. */
  burstRequests?: number;
  /** Maximum number of requests waiting for capacity. Defaults to 256. */
  maxQueueSize?: number;
  /** Randomized background-only cold-start delay. Defaults to 30 seconds. */
  startupJitterMs?: number;
}

export interface RpcRequestGovernorPolicy {
  readonly maxRequestsPerSecond: number;
  readonly foregroundReservePercent: number;
  readonly burstRequests: number;
  readonly maxQueueSize: number;
  readonly startupJitterMs: number;
}

export const DEFAULT_RPC_REQUEST_GOVERNOR_POLICY: RpcRequestGovernorPolicy = Object.freeze({
  maxRequestsPerSecond: 10,
  foregroundReservePercent: 80,
  burstRequests: 20,
  maxQueueSize: 256,
  startupJitterMs: 30_000,
});

function finiteNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function finiteInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = finiteNumber(value, name, minimum, maximum);
  if (!Number.isInteger(resolved)) throw new TypeError(`${name} must be an integer`);
  return resolved;
}

/** Normalize and validate the additive operator policy at the runtime boundary. */
export function resolveRpcRequestGovernorPolicy(
  input: RpcRequestGovernorPolicyInput | undefined,
): RpcRequestGovernorPolicy {
  return Object.freeze({
    maxRequestsPerSecond: finiteNumber(
      input?.maxRequestsPerSecond ?? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.maxRequestsPerSecond,
      'chain.rpcRequestBudget.maxRequestsPerSecond',
      0.1,
      10_000,
    ),
    foregroundReservePercent: finiteNumber(
      input?.foregroundReservePercent ?? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.foregroundReservePercent,
      'chain.rpcRequestBudget.foregroundReservePercent',
      0,
      99,
    ),
    burstRequests: finiteInteger(
      input?.burstRequests ?? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.burstRequests,
      'chain.rpcRequestBudget.burstRequests',
      1,
      100_000,
    ),
    maxQueueSize: finiteInteger(
      input?.maxQueueSize ?? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.maxQueueSize,
      'chain.rpcRequestBudget.maxQueueSize',
      1,
      100_000,
    ),
    startupJitterMs: finiteInteger(
      input?.startupJitterMs ?? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.startupJitterMs,
      'chain.rpcRequestBudget.startupJitterMs',
      0,
      3_600_000,
    ),
  });
}

const rpcRequestClassContext = new AsyncLocalStorage<RpcRequestClass>();

/** Classify every raw request and retry started by fn without changing call signatures. */
export function withRpcRequestClass<T>(requestClass: RpcRequestClass, fn: () => T): T {
  return rpcRequestClassContext.run(requestClass, fn);
}

function activeRpcRequestClass(): RpcRequestClass {
  return rpcRequestClassContext.getStore() ?? 'foreground';
}

export class RpcRequestGovernorQueueFullError extends ChainRpcTransportError {
  declare readonly code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL';

  constructor(readonly maxQueueSize: number) {
    super(
      'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
      `RPC request governor queue is full (${maxQueueSize} requests)`,
    );
    this.name = 'RpcRequestGovernorQueueFullError';
  }
}

export function isRpcRequestGovernorQueueFullError(
  error: unknown,
): error is RpcRequestGovernorQueueFullError {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'RPC_REQUEST_GOVERNOR_QUEUE_FULL';
}

export interface RpcRequestGovernorWindow {
  readonly maxRequestsPerSecond: number;
  readonly backgroundMaxRequestsPerSecond: number;
  readonly availableTokens: number;
  readonly backgroundAvailableTokens: number;
  readonly foregroundQueued: number;
  readonly backgroundQueued: number;
  readonly foregroundAdmitted: number;
  readonly backgroundAdmitted: number;
  readonly foregroundDeferred: number;
  readonly backgroundDeferred: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly startupDelayRemainingMs: number;
}

export interface RpcRequestGovernorClock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemGovernorClock: RpcRequestGovernorClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

interface RpcRequestWaiter {
  readonly requestClass: RpcRequestClass;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface MutableGovernorCounters {
  foregroundAdmitted: number;
  backgroundAdmitted: number;
  foregroundDeferred: number;
  backgroundDeferred: number;
  rejected: number;
  cancelled: number;
}

function zeroGovernorCounters(): MutableGovernorCounters {
  return {
    foregroundAdmitted: 0,
    backgroundAdmitted: 0,
    foregroundDeferred: 0,
    backgroundDeferred: 0,
    rejected: 0,
    cancelled: 0,
  };
}

/**
 * Process-local, two-class token bucket placed immediately before the HTTP
 * transport. Foreground work can use the full budget and always jumps queued
 * background work; background work additionally consumes a smaller bucket,
 * so catalog warming cannot consume the reserved publishing/control-plane
 * capacity. The same instance is injected into every adapter in one daemon.
 */
export class RpcRequestGovernor {
  readonly #policy: RpcRequestGovernorPolicy;
  readonly #clock: RpcRequestGovernorClock;
  readonly #backgroundRate: number;
  readonly #backgroundBurst: number;
  readonly #backgroundNotBeforeMs: number;
  readonly #foregroundQueue: RpcRequestWaiter[] = [];
  readonly #backgroundQueue: RpcRequestWaiter[] = [];
  #availableTokens: number;
  #backgroundAvailableTokens: number;
  #lastRefillMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #window = zeroGovernorCounters();

  constructor(
    input?: RpcRequestGovernorPolicyInput,
    testing?: { clock?: RpcRequestGovernorClock },
  ) {
    this.#policy = resolveRpcRequestGovernorPolicy(input);
    this.#clock = testing?.clock ?? systemGovernorClock;
    this.#backgroundRate = this.#policy.maxRequestsPerSecond
      * (1 - (this.#policy.foregroundReservePercent / 100));
    this.#backgroundBurst = Math.max(
      1,
      this.#policy.burstRequests * (1 - (this.#policy.foregroundReservePercent / 100)),
    );
    this.#availableTokens = this.#policy.burstRequests;
    this.#backgroundAvailableTokens = this.#backgroundBurst;
    this.#lastRefillMs = this.#clock.now();
    this.#backgroundNotBeforeMs = this.#lastRefillMs
      + Math.floor(this.#clock.random() * this.#policy.startupJitterMs);
  }

  async acquireActiveRequest(signal = activeRpcRequestAbortSignal()): Promise<void> {
    return this.acquire(activeRpcRequestClass(), signal);
  }

  async acquire(
    requestClass: RpcRequestClass,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throwRpcRequestAbortReason(signal);
    this.#refill();
    if (this.#canAdmitImmediately(requestClass)) {
      this.#admit(requestClass);
      return;
    }
    if (this.#foregroundQueue.length + this.#backgroundQueue.length >= this.#policy.maxQueueSize) {
      this.#window.rejected += 1;
      throw new RpcRequestGovernorQueueFullError(this.#policy.maxQueueSize);
    }
    this.#window[requestClass === 'foreground' ? 'foregroundDeferred' : 'backgroundDeferred'] += 1;
    await new Promise<void>((resolve, reject) => {
      const waiter: RpcRequestWaiter = {
        requestClass,
        resolve,
        reject,
        signal,
        onAbort: signal === undefined ? undefined : () => {
          if (!this.#removeWaiter(waiter)) return;
          this.#window.cancelled += 1;
          try {
            throwRpcRequestAbortReason(signal);
          } catch (error) {
            reject(error);
          }
          this.#cancelScheduledWakeup();
          this.#processQueues();
        },
      };
      if (waiter.onAbort) signal!.addEventListener('abort', waiter.onAbort, { once: true });
      const queue = requestClass === 'foreground' ? this.#foregroundQueue : this.#backgroundQueue;
      queue.push(waiter);
      if (requestClass === 'foreground') this.#cancelScheduledWakeup();
      this.#schedule();
    });
  }

  snapshot(): RpcRequestGovernorWindow {
    this.#refill();
    return this.#windowSnapshot(this.#window);
  }

  drainWindow(): RpcRequestGovernorWindow {
    this.#refill();
    const snapshot = this.#windowSnapshot(this.#window);
    this.#window = zeroGovernorCounters();
    return snapshot;
  }

  #windowSnapshot(counters: MutableGovernorCounters): RpcRequestGovernorWindow {
    return Object.freeze({
      maxRequestsPerSecond: this.#policy.maxRequestsPerSecond,
      backgroundMaxRequestsPerSecond: this.#backgroundRate,
      availableTokens: this.#availableTokens,
      backgroundAvailableTokens: this.#backgroundAvailableTokens,
      foregroundQueued: this.#foregroundQueue.length,
      backgroundQueued: this.#backgroundQueue.length,
      ...counters,
      startupDelayRemainingMs: Math.max(0, this.#backgroundNotBeforeMs - this.#clock.now()),
    });
  }

  #refill(): void {
    const now = this.#clock.now();
    const elapsedSeconds = Math.max(0, now - this.#lastRefillMs) / 1000;
    this.#lastRefillMs = now;
    this.#availableTokens = Math.min(
      this.#policy.burstRequests,
      this.#availableTokens + (elapsedSeconds * this.#policy.maxRequestsPerSecond),
    );
    this.#backgroundAvailableTokens = Math.min(
      this.#backgroundBurst,
      this.#backgroundAvailableTokens + (elapsedSeconds * this.#backgroundRate),
    );
  }

  #canAdmitImmediately(requestClass: RpcRequestClass): boolean {
    if (this.#availableTokens < 1) return false;
    if (requestClass === 'foreground') return this.#foregroundQueue.length === 0;
    return this.#foregroundQueue.length === 0
      && this.#backgroundQueue.length === 0
      && this.#clock.now() >= this.#backgroundNotBeforeMs
      && this.#backgroundAvailableTokens >= 1;
  }

  #admit(requestClass: RpcRequestClass): void {
    this.#availableTokens -= 1;
    if (requestClass === 'background') this.#backgroundAvailableTokens -= 1;
    this.#window[requestClass === 'foreground' ? 'foregroundAdmitted' : 'backgroundAdmitted'] += 1;
  }

  #removeWaiter(waiter: RpcRequestWaiter): boolean {
    const queue = waiter.requestClass === 'foreground' ? this.#foregroundQueue : this.#backgroundQueue;
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    return true;
  }

  #resolveHead(queue: RpcRequestWaiter[]): void {
    const waiter = queue.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    this.#admit(waiter.requestClass);
    waiter.resolve();
  }

  #processQueues = (): void => {
    this.#timer = null;
    this.#refill();
    while (this.#foregroundQueue.length > 0 && this.#availableTokens >= 1) {
      this.#resolveHead(this.#foregroundQueue);
    }
    while (
      this.#foregroundQueue.length === 0
      && this.#backgroundQueue.length > 0
      && this.#availableTokens >= 1
      && this.#backgroundAvailableTokens >= 1
      && this.#clock.now() >= this.#backgroundNotBeforeMs
    ) {
      this.#resolveHead(this.#backgroundQueue);
    }
    this.#schedule();
  };

  #cancelScheduledWakeup(): void {
    if (this.#timer === null) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    if (this.#foregroundQueue.length === 0 && this.#backgroundQueue.length === 0) return;
    this.#refill();
    let delayMs: number;
    if (this.#foregroundQueue.length > 0) {
      delayMs = Math.max(1, ((1 - this.#availableTokens) / this.#policy.maxRequestsPerSecond) * 1000);
    } else {
      const totalDelay = ((1 - this.#availableTokens) / this.#policy.maxRequestsPerSecond) * 1000;
      const backgroundDelay = ((1 - this.#backgroundAvailableTokens) / this.#backgroundRate) * 1000;
      const startupDelay = this.#backgroundNotBeforeMs - this.#clock.now();
      delayMs = Math.max(1, totalDelay, backgroundDelay, startupDelay);
    }
    this.#timer = this.#clock.setTimeout(this.#processQueues, Math.ceil(delayMs));
  }
}
