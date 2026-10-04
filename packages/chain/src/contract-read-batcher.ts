// SPDX-License-Identifier: Apache-2.0

/**
 * Coalesces contract views into one aggregate `eth_call`.
 *
 * A node's request budget counts JSON-RPC requests, and a pass that reads the
 * same few views for many assets spends one request per view per asset. One
 * aggregate call carries many of them for the price of one request, all
 * evaluated at the same block.
 *
 * The batcher only ever answers a read with a value decoded from a successful
 * inner call. Every other case (the request failing, an inner call reverting,
 * a result that does not decode) is answered by the read itself, issued the
 * way it is without batching, so its errors are exactly the ones its callers
 * already handle. The one exception is the node's own request admission
 * refusing the request: issuing every read on its own would queue them behind
 * the same admission, so they fail with that refusal instead.
 *
 * One request is out at a time. Reads that arrive while it waits for the
 * request budget, or for its answer, leave together in the next one, so a
 * batch grows exactly when requests are scarce. A request that has been out
 * for longer than the stall bound no longer holds the others back: one stuck
 * connection must not stop every read behind it, as it would not have without
 * batching.
 */

import { AsyncResource } from 'node:async_hooks';

import { rpcRequestAbortReason } from './rpc-request-abort.js';

export interface BatchedContractCall {
  readonly target: string;
  readonly callData: string;
}

export interface BatchedContractCallResult {
  readonly success: boolean;
  readonly returnData: string;
}

export interface BatchableContractRead<T> {
  /** Bounded, code-owned read label. Used only to describe the batch. */
  readonly label: string;
  readonly target: string;
  readonly callData: string;
  /** Decode a successful inner call's return data into the read's value. */
  readonly decode: (returnData: string) => T;
  /** The read as it is issued without batching. */
  readonly direct: () => Promise<T>;
  /** Any of these ends this caller's wait. The shared request is not cancelled. */
  readonly signals?: readonly (AbortSignal | undefined)[];
  /** Called once when the read was answered from a batch, not by `direct`. */
  readonly onBatched?: () => void;
}

/** `served`: the request answered. `failed`: it did not, and the reads went out directly. `refused`: local admission refused it. */
export type ContractReadBatchOutcome = 'served' | 'failed' | 'refused';

export interface ContractReadBatchObservation {
  readonly outcome: ContractReadBatchOutcome;
  /** Inner calls the request carried. Identical reads share one. */
  readonly calls: number;
  /** Reads the request was sent for, by label. */
  readonly readsByLabel: ReadonlyMap<string, number>;
  /** Reads handed to their direct path afterwards. */
  readonly directReads: number;
}

export interface ContractReadBatcherOptions {
  /** One physical request carrying `calls`, answered in the same order. */
  readonly aggregate: (
    calls: readonly BatchedContractCall[],
  ) => Promise<readonly BatchedContractCallResult[]>;
  /** True when the node's own request admission refused the request. */
  readonly isLocalRefusal?: (error: unknown) => boolean;
  readonly maxCallsPerRequest?: number;
  /** Consecutive failed requests after which batching pauses. */
  readonly pauseAfterFailures?: number;
  readonly pauseMs?: number;
  /** How long the newest request may be out before another may leave beside it. */
  readonly stallMs?: number;
  /** Requests that may be out at once when earlier ones have stalled. */
  readonly maxRequestsInFlight?: number;
  readonly now?: () => number;
  readonly observe?: (observation: ContractReadBatchObservation) => void;
}

export const DEFAULT_CONTRACT_READ_BATCH_MAX_CALLS = 64;
export const DEFAULT_CONTRACT_READ_BATCH_PAUSE_AFTER_FAILURES = 3;
export const DEFAULT_CONTRACT_READ_BATCH_PAUSE_MS = 60_000;
export const DEFAULT_CONTRACT_READ_BATCH_STALL_MS = 5_000;
export const DEFAULT_CONTRACT_READ_BATCH_MAX_IN_FLIGHT = 4;

interface PendingRead {
  readonly read: BatchableContractRead<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
  settled: boolean;
}

interface TakenBatch {
  readonly calls: BatchedContractCall[];
  readonly entries: Array<{ readonly pending: PendingRead; readonly callIndex: number }>;
}

export class ContractReadBatcher {
  readonly #options: ContractReadBatcherOptions;
  readonly #maxCalls: number;
  readonly #pauseAfterFailures: number;
  readonly #pauseMs: number;
  readonly #stallMs: number;
  readonly #maxInFlight: number;
  readonly #now: () => number;
  readonly #pending: PendingRead[] = [];
  // Requests leave in the context this batcher was created in, not in that of
  // whichever caller happened to schedule them.
  readonly #scope = new AsyncResource('ContractReadBatcher');
  #scheduled = false;
  #inFlight = 0;
  #newestRequestAt = 0;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  #consecutiveFailures = 0;
  #pausedUntil = 0;

  constructor(options: ContractReadBatcherOptions) {
    this.#options = options;
    this.#maxCalls = options.maxCallsPerRequest ?? DEFAULT_CONTRACT_READ_BATCH_MAX_CALLS;
    this.#pauseAfterFailures = options.pauseAfterFailures
      ?? DEFAULT_CONTRACT_READ_BATCH_PAUSE_AFTER_FAILURES;
    this.#pauseMs = options.pauseMs ?? DEFAULT_CONTRACT_READ_BATCH_PAUSE_MS;
    this.#stallMs = options.stallMs ?? DEFAULT_CONTRACT_READ_BATCH_STALL_MS;
    this.#maxInFlight = options.maxRequestsInFlight ?? DEFAULT_CONTRACT_READ_BATCH_MAX_IN_FLIGHT;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxCalls) || this.#maxCalls < 1) {
      throw new RangeError('Contract read batches need at least one call per request');
    }
    if (!Number.isSafeInteger(this.#maxInFlight) || this.#maxInFlight < 1) {
      throw new RangeError('Contract read batches need at least one request in flight');
    }
  }

  /** False while batching is paused after repeated request failures. */
  get accepting(): boolean {
    return this.#now() >= this.#pausedUntil;
  }

  read<T>(read: BatchableContractRead<T>): Promise<T> {
    if (!this.accepting) return read.direct();
    const signals = (read.signals ?? []).filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) return Promise.reject(rpcRequestAbortReason(aborted));
    return new Promise<T>((resolve, reject) => {
      const listeners = signals.map((signal) => {
        const onAbort = () => this.#settle(pending, () => reject(rpcRequestAbortReason(signal)));
        signal.addEventListener('abort', onAbort, { once: true });
        return () => signal.removeEventListener('abort', onAbort);
      });
      const pending: PendingRead = {
        read: read as BatchableContractRead<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => { for (const remove of listeners) remove(); },
        settled: false,
      };
      this.#pending.push(pending);
      this.#schedule();
    });
  }

  #settle(pending: PendingRead, deliver: () => void): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.detach();
    deliver();
  }

  #schedule(): void {
    if (this.#inFlight > 0) {
      this.#armStallTimer();
      return;
    }
    if (this.#scheduled) return;
    this.#scheduled = true;
    // A macrotask, so every read issued in the same turn leaves together.
    setImmediate(() => this.#scope.runInAsyncScope(() => {
      this.#scheduled = false;
      this.#pump();
    }));
  }

  /** Send what is waiting, as far as the one-at-a-time rule and its stall bound allow. */
  #pump(): void {
    for (;;) {
      if (this.#inFlight > 0) {
        const newestStalled = this.#now() - this.#newestRequestAt >= this.#stallMs;
        if (this.#inFlight >= this.#maxInFlight || !newestStalled) {
          if (this.#pending.some((pending) => !pending.settled)) this.#armStallTimer();
          return;
        }
      }
      const batch = this.#take();
      if (batch === undefined) return;
      this.#inFlight += 1;
      this.#newestRequestAt = this.#now();
      void this.#run(batch).catch(() => undefined).then(() => {
        this.#inFlight -= 1;
        if (this.#inFlight === 0 && this.#stallTimer !== undefined) {
          clearTimeout(this.#stallTimer);
          this.#stallTimer = undefined;
        }
        this.#pump();
      });
    }
  }

  /** Look again when the newest request has been out for the stall bound. */
  #armStallTimer(): void {
    if (this.#stallTimer !== undefined || this.#inFlight >= this.#maxInFlight) return;
    const wait = Math.max(0, this.#newestRequestAt + this.#stallMs - this.#now());
    this.#stallTimer = setTimeout(() => this.#scope.runInAsyncScope(() => {
      this.#stallTimer = undefined;
      this.#pump();
    }), wait);
    this.#stallTimer.unref?.();
  }

  /** The oldest pending reads that fit one request, identical calls sharing an inner call. */
  #take(): TakenBatch | undefined {
    const calls: BatchedContractCall[] = [];
    const entries: TakenBatch['entries'] = [];
    const indexByCall = new Map<string, number>();
    while (this.#pending.length > 0) {
      const pending = this.#pending[0]!;
      if (pending.settled) {
        this.#pending.shift();
        continue;
      }
      const key = `${pending.read.target.toLowerCase()}:${pending.read.callData}`;
      let callIndex = indexByCall.get(key);
      if (callIndex === undefined) {
        if (calls.length >= this.#maxCalls) break;
        callIndex = calls.length;
        indexByCall.set(key, callIndex);
        calls.push({ target: pending.read.target, callData: pending.read.callData });
      }
      this.#pending.shift();
      entries.push({ pending, callIndex });
    }
    return entries.length === 0 ? undefined : { calls, entries };
  }

  async #run(batch: TakenBatch): Promise<void> {
    const readsByLabel = new Map<string, number>();
    for (const { pending } of batch.entries) {
      readsByLabel.set(pending.read.label, (readsByLabel.get(pending.read.label) ?? 0) + 1);
    }
    let results: readonly BatchedContractCallResult[];
    try {
      results = await this.#options.aggregate(batch.calls);
      if (results.length !== batch.calls.length) {
        throw new Error(
          `Aggregate call answered ${results.length} of ${batch.calls.length} calls`,
        );
      }
    } catch (error) {
      if (this.#options.isLocalRefusal?.(error) === true) {
        for (const { pending } of batch.entries) {
          this.#settle(pending, () => pending.reject(error));
        }
        this.#observe({ outcome: 'refused', calls: batch.calls.length, readsByLabel, directReads: 0 });
        return;
      }
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= this.#pauseAfterFailures) {
        this.#consecutiveFailures = 0;
        this.#pausedUntil = this.#now() + this.#pauseMs;
      }
      let directReads = 0;
      for (const { pending } of batch.entries) {
        if (this.#answerDirectly(pending)) directReads += 1;
      }
      // Paused: nothing still waiting may sit behind another failing request.
      if (!this.accepting) {
        for (const pending of this.#pending.splice(0)) this.#answerDirectly(pending);
      }
      this.#observe({ outcome: 'failed', calls: batch.calls.length, readsByLabel, directReads });
      return;
    }
    this.#consecutiveFailures = 0;
    let directReads = 0;
    for (const { pending, callIndex } of batch.entries) {
      if (pending.settled) continue;
      const result = results[callIndex]!;
      let value: unknown;
      let decoded = false;
      if (result.success) {
        try {
          value = pending.read.decode(result.returnData);
          decoded = true;
        } catch {
          // The direct read reproduces the decode failure as its callers know it.
        }
      }
      if (!decoded) {
        if (this.#answerDirectly(pending)) directReads += 1;
        continue;
      }
      this.#settle(pending, () => {
        pending.resolve(value);
        try {
          pending.read.onBatched?.();
        } catch {
          /* an observer cannot change the read's outcome */
        }
      });
    }
    this.#observe({ outcome: 'served', calls: batch.calls.length, readsByLabel, directReads });
  }

  /** Hand one read to its direct path. False when its caller has already gone. */
  #answerDirectly(pending: PendingRead): boolean {
    if (pending.settled) return false;
    let direct: Promise<unknown>;
    try {
      direct = Promise.resolve(pending.read.direct());
    } catch (error) {
      direct = Promise.reject(error);
    }
    direct.then(
      (value) => this.#settle(pending, () => pending.resolve(value)),
      (error) => this.#settle(pending, () => pending.reject(error)),
    );
    return true;
  }

  #observe(observation: ContractReadBatchObservation): void {
    try {
      this.#options.observe?.(observation);
    } catch {
      /* observation only */
    }
  }
}
