// SPDX-License-Identifier: Apache-2.0

import { Rfc64CoalescingSupervisorV1 } from './coalescing-supervisor-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  './catalog-authority-config-v1.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from './catalog-runtime-v1.js';

export interface Rfc64CatalogAuthorityRefreshSchedulerV1 {
  setInterval(
    callback: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

/** Production cadence boundary. Tests inject a scheduler per loop instance. */
const rfc64CatalogAuthorityRefreshSchedulerV1:
  Rfc64CatalogAuthorityRefreshSchedulerV1 = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer);
  },
};

export interface Rfc64CatalogAuthorityRefreshLoopOptionsV1 {
  readonly readActiveContextGraphIds: () => readonly string[];
  readonly onActiveContextGraphIdsReadFailure: (error: unknown) => void;
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly maxConcurrentReads?: number;
}

type RefreshPermitReleaseV1 = () => void;

/** Cancellation-aware global bound shared by the independent per-CG lanes. */
class Rfc64AuthorityRefreshPermitPoolV1 {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<Readonly<{
    signal: AbortSignal;
    resolve: (release: RefreshPermitReleaseV1 | null) => void;
    onAbort: () => void;
  }>> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(
    signal: AbortSignal,
  ): RefreshPermitReleaseV1 | null | Promise<RefreshPermitReleaseV1 | null> {
    if (signal.aborted) return null;
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#createRelease();
    }
    return new Promise((resolve) => {
      const waiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve(null);
        },
      };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  #createRelease(): RefreshPermitReleaseV1 {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.resolve(null);
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#createRelease());
    }
  }
}

/** Bounded independent authority lanes with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #permits: Rfc64AuthorityRefreshPermitPoolV1;
  readonly #lanes = new Map<string, Rfc64CoalescingSupervisorV1>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
    const maxConcurrentReads = options.maxConcurrentReads
      ?? RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.maxConcurrentReads;
    if (!Number.isSafeInteger(maxConcurrentReads) || maxConcurrentReads < 1) {
      throw new TypeError('RFC-64 authority refresh concurrency must be a positive integer');
    }
    this.#permits = new Rfc64AuthorityRefreshPermitPoolV1(maxConcurrentReads);
  }

  #createLane(contextGraphId: string): Rfc64CoalescingSupervisorV1 {
    return new Rfc64CoalescingSupervisorV1({
      requestWhileRunning: 'drop',
      runPass: async (signal) => {
        const admission = this.#permits.acquire(signal);
        const release = typeof admission === 'function' || admission === null
          ? admission
          : await admission;
        if (release === null) return;
        try {
          await this.options.refreshContextGraph(contextGraphId, signal);
          if (signal.aborted) return;
        } catch (error) {
          if (signal.aborted) return;
          this.options.onRefreshFailure(contextGraphId, error);
        } finally {
          release();
        }
      },
      // Per-context-graph failures are reported by the lane body.
      onError: () => undefined,
      closingMessage: 'RFC-64 authority refresh stopped during agent shutdown',
    });
  }

  start(): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 authority refresh cannot start while close is in progress');
    }
    if (this.#started) return;
    this.#started = true;
    this.#timer = this.#scheduler.setInterval(
      this.trigger,
      RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
    );
    this.trigger();
  }

  readonly trigger = (): void => {
    if (!this.#started) return;
    let activeContextGraphIds: readonly string[];
    try {
      activeContextGraphIds = this.options.readActiveContextGraphIds();
    } catch (error) {
      this.options.onActiveContextGraphIdsReadFailure(error);
      return;
    }
    for (const contextGraphId of new Set(activeContextGraphIds)) {
      let lane = this.#lanes.get(contextGraphId);
      if (lane === undefined || lane.closed) {
        lane = this.#createLane(contextGraphId);
        this.#lanes.set(contextGraphId, lane);
      }
      lane.request();
    }
  };

  async whenIdle(): Promise<void> {
    for (;;) {
      const lanes = [...this.#lanes.values()];
      await Promise.all(lanes.map((lane) => lane.whenIdle()));
      const current = [...this.#lanes.values()];
      if (lanes.length === current.length && lanes.every((lane, index) => (
        lane === current[index]
      ))) return;
    }
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    this.#started = false;
    if (this.#timer !== null) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = null;
    }
    const lanes = [...this.#lanes.values()];
    const closing = Promise.all(lanes.map((lane) => lane.close())).then(() => undefined);
    this.#close = closing;
    void closing.then(() => {
      if (this.#close !== closing) return;
      this.#lanes.clear();
      this.#close = null;
    });
    return closing;
  }
}
