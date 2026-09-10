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
}

/** Bounded independent authority lanes with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #lanes = new Map<string, Rfc64CoalescingSupervisorV1>();
  readonly #retirements = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
  }

  #createLane(contextGraphId: string): Rfc64CoalescingSupervisorV1 {
    return new Rfc64CoalescingSupervisorV1({
      requestWhileRunning: 'drop',
      runPass: async (signal) => {
        try {
          await this.options.refreshContextGraph(contextGraphId, signal);
          if (signal.aborted) return;
        } catch (error) {
          if (signal.aborted) return;
          this.options.onRefreshFailure(contextGraphId, error);
        }
      },
      // Per-context-graph failures are reported by the lane body.
      onError: () => undefined,
      closingMessage: 'RFC-64 authority refresh stopped during agent shutdown',
    });
  }

  #retireLane(
    contextGraphId: string,
    lane: Rfc64CoalescingSupervisorV1,
  ): void {
    if (this.#lanes.get(contextGraphId) !== lane) return;
    this.#lanes.delete(contextGraphId);
    const retirement = lane.close();
    this.#retirements.add(retirement);
    void retirement.then(
      () => { this.#retirements.delete(retirement); },
      () => { this.#retirements.delete(retirement); },
    );
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
    const desiredContextGraphIds = new Set(activeContextGraphIds);
    for (const [contextGraphId, lane] of this.#lanes) {
      if (!desiredContextGraphIds.has(contextGraphId)) {
        this.#retireLane(contextGraphId, lane);
      }
    }
    for (const contextGraphId of desiredContextGraphIds) {
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
      const retirements = [...this.#retirements];
      await Promise.all([
        ...lanes.map((lane) => lane.whenIdle()),
        ...retirements,
      ]);
      const currentLanes = [...this.#lanes.values()];
      const currentRetirements = [...this.#retirements];
      const sameLanes = lanes.length === currentLanes.length
        && lanes.every((lane, index) => lane === currentLanes[index]);
      const sameRetirements = retirements.length === currentRetirements.length
        && retirements.every((retirement, index) => (
          retirement === currentRetirements[index]
        ));
      if (sameLanes && sameRetirements) return;
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
    const retirements = [...this.#retirements];
    const closing = Promise.all([
      ...lanes.map((lane) => lane.close()),
      ...retirements,
    ]).then(() => undefined);
    this.#close = closing;
    void closing.then(() => {
      if (this.#close !== closing) return;
      this.#lanes.clear();
      this.#retirements.clear();
      this.#close = null;
    });
    return closing;
  }
}
