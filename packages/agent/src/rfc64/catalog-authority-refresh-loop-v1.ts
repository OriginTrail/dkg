// SPDX-License-Identifier: Apache-2.0

import { Rfc64CoalescingSupervisorV1 } from './coalescing-supervisor-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  './catalog-authority-config-v1.js';

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
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
}

/** One bounded recurring authority pass with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #supervisor: Rfc64CoalescingSupervisorV1;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
    this.#supervisor = new Rfc64CoalescingSupervisorV1({
      requestWhileRunning: 'drop',
      runPass: async (signal) => {
        // Sequential refresh is an intentional global bound. A large Core
        // responsibility set cannot turn one timer tick into an RPC burst.
        for (const contextGraphId of this.options.readActiveContextGraphIds()) {
          try {
            await this.options.refreshContextGraph(contextGraphId, signal);
            if (signal.aborted) return;
          } catch (error) {
            if (signal.aborted) return;
            this.options.onRefreshFailure(contextGraphId, error);
          }
        }
      },
      // Per-context-graph failures are reported above. Preserve the previous
      // behavior for the only remaining outer failure source: responsibility reads.
      onError: () => undefined,
      closingMessage: 'RFC-64 authority refresh stopped during agent shutdown',
    });
  }

  start(): void {
    if (this.#supervisor.closed) {
      throw new Error('RFC-64 catalog authority refresh loop is closed');
    }
    if (this.#timer !== null) return;
    this.#timer = this.#scheduler.setInterval(
      this.trigger,
      RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
    );
    this.trigger();
  }

  readonly trigger = (): void => {
    this.#supervisor.request();
  };

  whenIdle(): Promise<void> {
    return this.#supervisor.whenIdle();
  }

  close(): Promise<void> {
    if (this.#timer !== null) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = null;
    }
    return this.#supervisor.close();
  }
}
