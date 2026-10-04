// SPDX-License-Identifier: Apache-2.0

import { ChainRpcTransportError } from './chain-rpc-transport-error.js';
import {
  activeRpcRequestContext,
  throwRpcRequestAbortReason,
} from './rpc-request-transport.js';
import type { RpcRequestClass } from './rpc-request-transport.js';
import type { RpcRequestAdmissionPriority } from './rpc-request-transport.js';

/**
 * Internal authority reads may enter a saturated ordinary queue, but remain
 * bounded independently so a bug cannot create an unbounded priority lane.
 * Four slots match the default async-promote worker concurrency. An authority
 * read enters the reserve when the ordinary slots of its class are taken: the
 * whole queue for foreground work, the background share of it for background
 * work. Reserve slots are counted apart from ordinary ones, so a read waiting
 * in the reserve never takes a slot the capacity split keeps for other work.
 */
const AUTHORITY_PRIORITY_QUEUE_RESERVE = 4;

/**
 * How many authority admissions in a row may pass ordinary background work
 * that has already waited the fairness grace period. Authority reads then get
 * four of every five background permits for as long as they need them, and a
 * stream of them cannot starve bulk work.
 */
const BACKGROUND_AUTHORITY_MAX_PASSES = 4;

export interface RpcRequestGovernorPolicyInput {
  /** Total node-process RPC request rate. Defaults to 10 requests/second. */
  maxRequestsPerSecond?: number;
  /** Percentage of total rate and queue capacity unavailable to background work. Defaults to 80. */
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

const RPC_REQUEST_GOVERNOR_POLICY_KEYS = new Set([
  'maxRequestsPerSecond',
  'foregroundReservePercent',
  'burstRequests',
  'maxQueueSize',
  'startupJitterMs',
]);

function assertRpcRequestGovernorPolicyInput(
  input: unknown,
): asserts input is RpcRequestGovernorPolicyInput | undefined {
  if (input === undefined) return;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('chain.rpcRequestBudget must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('chain.rpcRequestBudget must be a plain object');
  }
  for (const key of Object.keys(input)) {
    if (!RPC_REQUEST_GOVERNOR_POLICY_KEYS.has(key)) {
      throw new TypeError(`chain.rpcRequestBudget contains unknown field ${key}`);
    }
  }
}

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
  assertRpcRequestGovernorPolicyInput(input);
  return Object.freeze({
    maxRequestsPerSecond: finiteNumber(
      input?.maxRequestsPerSecond === undefined
        ? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.maxRequestsPerSecond
        : input.maxRequestsPerSecond,
      'chain.rpcRequestBudget.maxRequestsPerSecond',
      0.1,
      10_000,
    ),
    foregroundReservePercent: finiteNumber(
      input?.foregroundReservePercent === undefined
        ? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.foregroundReservePercent
        : input.foregroundReservePercent,
      'chain.rpcRequestBudget.foregroundReservePercent',
      0,
      99,
    ),
    burstRequests: finiteInteger(
      input?.burstRequests === undefined
        ? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.burstRequests
        : input.burstRequests,
      'chain.rpcRequestBudget.burstRequests',
      1,
      100_000,
    ),
    maxQueueSize: finiteInteger(
      input?.maxQueueSize === undefined
        ? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.maxQueueSize
        : input.maxQueueSize,
      'chain.rpcRequestBudget.maxQueueSize',
      1,
      100_000,
    ),
    startupJitterMs: finiteInteger(
      input?.startupJitterMs === undefined
        ? DEFAULT_RPC_REQUEST_GOVERNOR_POLICY.startupJitterMs
        : input.startupJitterMs,
      'chain.rpcRequestBudget.startupJitterMs',
      0,
      3_600_000,
    ),
  });
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
  readonly admissionPriority?: RpcRequestAdmissionPriority;
  readonly enqueuedAtMs: number;
  /** Waits in the authority reserve rather than in an ordinary queue slot. */
  readonly authorityReserveSlot: boolean;
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
 *
 * An authority read keeps its caller's class and that class's budget, and goes
 * first inside it. It answers a fail-closed check under a deadline of a few
 * seconds, so a place behind bulk work would be a refusal the chain never
 * gave. In the background class it is for the same reason not held by the
 * start-up delay, which exists to spread bulk work. It still spends the
 * background bucket, yields to foreground work as any background request
 * does, and leaves bulk work that has waited a bounded share of the
 * background permits.
 */
export class RpcRequestGovernor {
  /**
   * Once a background waiter has capacity, sustained foreground traffic may
   * postpone it for at most this scheduling grace period. The separate
   * background token bucket still enforces the operator's foreground reserve;
   * this only prevents a permanently non-empty foreground queue from turning
   * that reserved background share into zero progress.
   */
  static readonly BACKGROUND_FAIRNESS_GRACE_MS = 1_000;
  readonly #policy: RpcRequestGovernorPolicy;
  readonly #clock: RpcRequestGovernorClock;
  readonly #backgroundRate: number;
  readonly #backgroundBurst: number;
  readonly #backgroundQueueLimit: number;
  readonly #backgroundNotBeforeMs: number;
  readonly #foregroundQueue: RpcRequestWaiter[] = [];
  readonly #backgroundQueue: RpcRequestWaiter[] = [];
  #availableTokens: number;
  #backgroundAvailableTokens: number;
  #lastRefillMs: number;
  /** See {@link RpcRequestGovernor.#nextBackgroundWaiter}. */
  #backgroundAuthorityPasses = 0;
  /** Queued waiters that hold a slot of the authority reserve. */
  #authorityReserveSlotsInUse = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #window = zeroGovernorCounters();

  constructor(
    input?: RpcRequestGovernorPolicyInput,
    testing?: { clock?: RpcRequestGovernorClock },
  ) {
    this.#policy = resolveRpcRequestGovernorPolicy(input);
    this.#clock = testing?.clock ?? systemGovernorClock;
    const backgroundFraction = (100 - this.#policy.foregroundReservePercent) / 100;
    this.#backgroundRate = this.#policy.maxRequestsPerSecond * backgroundFraction;
    this.#backgroundBurst = Math.max(
      1,
      Math.floor((this.#policy.burstRequests * backgroundFraction) + 1e-9),
    );
    // Queue admission follows the same operator-defined capacity split as the
    // token buckets. Round the foreground share up so any non-zero reserve
    // protects at least one slot, even for very small queues.
    const foregroundQueueReserve = Math.ceil(
      this.#policy.maxQueueSize * (this.#policy.foregroundReservePercent / 100),
    );
    this.#backgroundQueueLimit = this.#policy.maxQueueSize - foregroundQueueReserve;
    this.#availableTokens = this.#policy.burstRequests;
    this.#backgroundAvailableTokens = this.#backgroundBurst;
    this.#lastRefillMs = this.#clock.now();
    this.#backgroundNotBeforeMs = this.#lastRefillMs
      + Math.floor(this.#clock.random() * this.#policy.startupJitterMs);
  }

  async acquireActiveRequest(signal = activeRpcRequestContext().signal): Promise<void> {
    const context = activeRpcRequestContext();
    return this.acquire(context.requestClass, signal, context.admissionPriority);
  }

  /**
   * Admit from currently available capacity or fail locally without queueing.
   * Intended for optional diagnostic traffic whose callers must never occupy
   * the queue or displace foreground work.
   */
  async acquireActiveRequestImmediately(
    signal = activeRpcRequestContext().signal,
  ): Promise<void> {
    return this.acquireImmediately(activeRpcRequestContext().requestClass, signal);
  }

  /**
   * Optional health/diagnostic admission: never queues, always uses the
   * background bucket, and may probe during startup without waiting for the
   * workload-jitter window. It still yields to queued foreground work and
   * cannot consume capacity reserved for foreground operations.
   */
  async acquireDiagnosticRequestImmediately(
    signal = activeRpcRequestContext().signal,
  ): Promise<void> {
    return this.#acquireImmediately('background', signal, true);
  }

  async acquireImmediately(
    requestClass: RpcRequestClass,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#acquireImmediately(requestClass, signal, false);
  }

  async #acquireImmediately(
    requestClass: RpcRequestClass,
    signal: AbortSignal | undefined,
    ignoreBackgroundStartupJitter: boolean,
  ): Promise<void> {
    if (signal?.aborted) throwRpcRequestAbortReason(signal);
    this.#refill();
    if (this.#canAdmitImmediately(requestClass, ignoreBackgroundStartupJitter)) {
      this.#admit(requestClass);
      return;
    }
    this.#window.rejected += 1;
    throw new RpcRequestGovernorQueueFullError(this.#policy.maxQueueSize);
  }

  async acquire(
    requestClass: RpcRequestClass,
    signal?: AbortSignal,
    admissionPriority?: RpcRequestAdmissionPriority,
  ): Promise<void> {
    if (signal?.aborted) throwRpcRequestAbortReason(signal);
    this.#refill();
    const authorityPriority = admissionPriority === 'authority';
    if (
      requestClass === 'background' && authorityPriority
        ? this.#canAdmitBackgroundAuthorityImmediately()
        : this.#canAdmitImmediately(requestClass)
    ) {
      this.#admit(requestClass, authorityPriority);
      return;
    }
    const ordinarySlotsInUse = this.#foregroundQueue.length + this.#backgroundQueue.length
      - this.#authorityReserveSlotsInUse;
    const authorityReserveSlot = ordinarySlotsInUse >= (
      requestClass === 'background' ? this.#backgroundQueueLimit : this.#policy.maxQueueSize
    );
    if (
      authorityReserveSlot
      && (
        !authorityPriority
        || this.#authorityReserveSlotsInUse >= AUTHORITY_PRIORITY_QUEUE_RESERVE
      )
    ) {
      this.#window.rejected += 1;
      throw new RpcRequestGovernorQueueFullError(this.#policy.maxQueueSize);
    }
    this.#window[requestClass === 'foreground' ? 'foregroundDeferred' : 'backgroundDeferred'] += 1;
    await new Promise<void>((resolve, reject) => {
      const waiter: RpcRequestWaiter = {
        requestClass,
        ...(authorityPriority ? { admissionPriority } : {}),
        enqueuedAtMs: this.#clock.now(),
        authorityReserveSlot,
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
      if (authorityReserveSlot) this.#authorityReserveSlotsInUse += 1;
      const queue = requestClass === 'foreground' ? this.#foregroundQueue : this.#backgroundQueue;
      if (authorityPriority) {
        const firstOrdinary = queue.findIndex(
          (queued) => queued.admissionPriority !== 'authority',
        );
        if (firstOrdinary < 0) queue.push(waiter);
        else queue.splice(firstOrdinary, 0, waiter);
      } else {
        queue.push(waiter);
      }
      // A wake-up set for ordinary background work can be as far away as the
      // start-up delay; an authority waiter is not bound by that.
      if (requestClass === 'foreground' || authorityPriority) this.#cancelScheduledWakeup();
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

  #canAdmitImmediately(
    requestClass: RpcRequestClass,
    ignoreBackgroundStartupJitter = false,
  ): boolean {
    if (this.#availableTokens < 1) return false;
    if (requestClass === 'foreground') return this.#foregroundQueue.length === 0;
    return this.#foregroundQueue.length === 0
      // Diagnostics may skip only the cold-start delay. They remain optional
      // work and must never jump an already-queued background workload.
      && this.#backgroundQueue.length === 0
      && (ignoreBackgroundStartupJitter || this.#clock.now() >= this.#backgroundNotBeforeMs)
      && this.#backgroundAvailableTokens >= 1;
  }

  /**
   * A background authority read is admitted at once when no queued waiter is
   * due the permit: the queues are empty, or the background queue holds only
   * ordinary work waiting out the start-up delay. Otherwise it queues at the
   * front and {@link RpcRequestGovernor.#nextBackgroundWaiter} decides.
   */
  #canAdmitBackgroundAuthorityImmediately(): boolean {
    return this.#availableTokens >= 1
      && this.#backgroundAvailableTokens >= 1
      && this.#foregroundQueue.length === 0
      && this.#nextBackgroundWaiter() < 0;
  }

  /**
   * Index of the background waiter the next background permit goes to, or -1
   * when none may take one yet.
   *
   * Authority waiters sit at the front and go first, also during the start-up
   * delay. Ordinary background work must still make progress under a stream of
   * them: an ordinary waiter that has waited the fairness grace period is
   * passed by at most {@link BACKGROUND_AUTHORITY_MAX_PASSES} authority
   * admissions in a row, then takes a permit itself.
   */
  #nextBackgroundWaiter(): number {
    const head = this.#backgroundQueue[0];
    if (head === undefined) return -1;
    if (head.admissionPriority !== 'authority') {
      return this.#clock.now() >= this.#backgroundNotBeforeMs ? 0 : -1;
    }
    if (this.#backgroundAuthorityPasses < BACKGROUND_AUTHORITY_MAX_PASSES) return 0;
    const passed = this.#passedBackgroundWaiter();
    return passed < 0 ? 0 : passed;
  }

  /**
   * Index of the first ordinary background waiter that could take a permit
   * now and has waited the fairness grace period, or -1.
   */
  #passedBackgroundWaiter(): number {
    const now = this.#clock.now();
    if (now < this.#backgroundNotBeforeMs) return -1;
    const firstOrdinary = this.#backgroundQueue.findIndex(
      (queued) => queued.admissionPriority !== 'authority',
    );
    return firstOrdinary >= 0
      && now - this.#backgroundQueue[firstOrdinary]!.enqueuedAtMs
        >= RpcRequestGovernor.BACKGROUND_FAIRNESS_GRACE_MS
      ? firstOrdinary
      : -1;
  }

  /**
   * Whether the background class is owed its turn past foreground work: one of
   * its waiters has waited the fairness grace period for a permit it could
   * take now. Which waiter the turn goes to is a separate question
   * ({@link RpcRequestGovernor.#nextBackgroundWaiter}), so an authority read
   * that queued a moment ago does not undo what ordinary work behind it has
   * already waited.
   */
  #backgroundWorkHasWaited(): boolean {
    const head = this.#backgroundQueue[0];
    const authorityHasWaited = head?.admissionPriority === 'authority'
      && this.#clock.now() - head.enqueuedAtMs >= RpcRequestGovernor.BACKGROUND_FAIRNESS_GRACE_MS;
    return authorityHasWaited || this.#passedBackgroundWaiter() >= 0;
  }

  #admit(requestClass: RpcRequestClass, authorityPriority = false): void {
    this.#availableTokens -= 1;
    if (requestClass === 'background') {
      this.#backgroundAvailableTokens -= 1;
      this.#backgroundAuthorityPasses = authorityPriority && this.#passedBackgroundWaiter() >= 0
        ? this.#backgroundAuthorityPasses + 1
        : 0;
    }
    this.#window[requestClass === 'foreground' ? 'foregroundAdmitted' : 'backgroundAdmitted'] += 1;
  }

  /** Take a waiter out of its queue and give back the slot it held there. */
  #dequeue(queue: RpcRequestWaiter[], index: number): RpcRequestWaiter {
    const [waiter] = queue.splice(index, 1) as [RpcRequestWaiter];
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    if (waiter.authorityReserveSlot) this.#authorityReserveSlotsInUse -= 1;
    return waiter;
  }

  #removeWaiter(waiter: RpcRequestWaiter): boolean {
    const queue = waiter.requestClass === 'foreground' ? this.#foregroundQueue : this.#backgroundQueue;
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    this.#dequeue(queue, index);
    return true;
  }

  #resolveWaiter(queue: RpcRequestWaiter[], index = 0): void {
    const waiter = this.#dequeue(queue, index);
    this.#admit(waiter.requestClass, waiter.admissionPriority === 'authority');
    waiter.resolve();
  }

  #processQueues = (): void => {
    this.#timer = null;
    this.#refill();
    const backgroundNext = this.#nextBackgroundWaiter();
    const agedBackgroundHasCapacity = backgroundNext >= 0
      && this.#availableTokens >= 1
      && this.#backgroundAvailableTokens >= 1
      && this.#backgroundWorkHasWaited();
    // At most one aged background request jumps the foreground queue per
    // scheduling turn. Its own bucket keeps this within the background share;
    // the single admission keeps foreground latency bounded.
    if (
      this.#foregroundQueue.length > 0
      && this.#foregroundQueue[0]?.admissionPriority !== 'authority'
      && agedBackgroundHasCapacity
    ) {
      this.#resolveWaiter(this.#backgroundQueue, backgroundNext);
    }
    while (this.#foregroundQueue.length > 0 && this.#availableTokens >= 1) {
      this.#resolveWaiter(this.#foregroundQueue);
    }
    while (
      this.#foregroundQueue.length === 0
      && this.#availableTokens >= 1
      && this.#backgroundAvailableTokens >= 1
    ) {
      const next = this.#nextBackgroundWaiter();
      if (next < 0) break;
      this.#resolveWaiter(this.#backgroundQueue, next);
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
      const startupDelay = this.#backgroundQueue[0]?.admissionPriority === 'authority'
        ? 0
        : this.#backgroundNotBeforeMs - this.#clock.now();
      delayMs = Math.max(1, totalDelay, backgroundDelay, startupDelay);
    }
    this.#timer = this.#clock.setTimeout(this.#processQueues, Math.ceil(delayMs));
  }
}
