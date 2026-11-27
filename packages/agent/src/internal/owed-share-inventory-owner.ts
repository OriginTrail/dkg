// SPDX-License-Identifier: Apache-2.0

/**
 * Writes the signed inventory rows that committed shares still owe, from their durable markers
 * (`rfc64/owed-share-inventory-store-v1.ts`).
 *
 * A pass tries each marker in turn, one at a time. A written row, a confirmed VM publication of
 * the share, a catalog policy that no longer takes the share, or a share whose seal or shared
 * copy has moved on ends the marker. A lane that is still closed, or an authority that is not
 * ready, keeps it for a later pass without a warning, and the lane's other markers stay with it
 * without an attempt of their own. Such attempts never reach real I/O, so a pass also gives the
 * event loop a turn between bounded slices. A failure keeps the marker too, with a warning and a
 * growing pause before that marker is tried again. Passes run when the owner starts, when a
 * marker is written, when a graph's catalog authority is accepted, and, while any marker is
 * kept, on the projection supervisor's retry interval.
 */

import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';

import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import { createMainThreadTimeSlice } from '../main-thread-time-slice.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from '../rfc64/catalog-runtime-v1.js';
import type { Rfc64OwedShareInventoryV1 } from '../rfc64/owed-share-inventory-store-v1.js';

/**
 * What one attempt at an owed row found. `waiting` keeps the marker. `lane-closed` keeps it and
 * every other marker of its graph and sub-graph for this pass. Every other outcome ends the marker.
 */
export type OwedShareInventoryDrainOutcomeV1 =
  | 'written' | 'vm-confirmed' | 'policy-mismatch' | 'superseded' | 'waiting' | 'lane-closed';

/** The longest pause before a marker whose attempt failed is tried again. */
export const OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS = 10 * 60_000;

/** Main-thread time a pass may use before timers and I/O get a turn. */
const OWED_SHARE_INVENTORY_PASS_SLICE_MS = 8;

export interface OwedShareInventoryOwnerDependenciesV1 {
  /** Every kept marker; a marker is the same object in each list for as long as it is kept. */
  readonly list: () => readonly Readonly<Rfc64OwedShareInventoryV1>[];
  readonly unreadableAtOpen: () => number;
  /** One attempt, under the asset's inventory write lock; throws when it failed. */
  readonly drain: (
    marker: Readonly<Rfc64OwedShareInventoryV1>, ctx: OperationContext,
  ) => Promise<OwedShareInventoryDrainOutcomeV1>;
  /** One coalesced graph reconciliation, outside the serial marker pass. */
  readonly requestGraphSettlement?: (contextGraphId: string) => void;
  readonly remove: (marker: Readonly<Rfc64OwedShareInventoryV1>) => Promise<void>;
  /** The projection supervisor's retry interval; 0 leaves only the explicit passes. */
  readonly retryIntervalMs: () => number;
  readonly warn: (ctx: OperationContext, message: string) => void;
  readonly now?: () => number;
}

interface FailedAttemptV1 {
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

function markerLabel(marker: Readonly<Rfc64OwedShareInventoryV1>): string {
  return `${marker.contextGraphId} ${marker.assertionCoordinate} ${marker.shareOperationId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The catalog runtime starts and closes it with its other workloads. */
export class Rfc64OwedShareInventoryOwnerV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #dependencies: OwedShareInventoryOwnerDependenciesV1;
  /** Keyed by the kept marker object: a pass does no work for pauses, and a removed marker takes its pause with it. */
  #failed = new WeakMap<Readonly<Rfc64OwedShareInventoryV1>, FailedAttemptV1>();
  #runner: CoalescingRecurringTask | undefined;
  #ctx: OperationContext = createOperationContext('system');

  constructor(dependencies: OwedShareInventoryOwnerDependenciesV1) {
    this.#dependencies = dependencies;
  }

  start(ctx: OperationContext): void {
    if (this.#runner !== undefined) {
      this.#runner.request();
      return;
    }
    this.#ctx = ctx;
    this.#failed = new WeakMap();
    const unreadable = this.#dependencies.unreadableAtOpen();
    if (unreadable > 0) {
      this.#dependencies.warn(ctx, `${unreadable} owed share inventory marker file(s) could not be read; `
        + 'they are left in place and their rows are not written');
    }
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: this.#dependencies.retryIntervalMs(),
      runPass: (signal) => this.#runPass(signal),
      onError: (error) => this.#dependencies.warn(this.#ctx,
        `Owed share inventory pass failed: ${message(error)}`),
      closingMessage: 'RFC-64 owed share inventory closing',
    });
    this.#runner = runner;
    runner.request();
  }

  /** Try every kept marker now; a pass already running is followed by one more. */
  request(): void {
    this.#runner?.request();
  }

  /** Drain marker attempts; the canonical responsibility dispatcher owns graph settlement. */
  async whenIdle(): Promise<void> {
    await this.#runner?.whenIdle();
  }

  async close(): Promise<void> {
    const runner = this.#runner;
    this.#runner = undefined;
    await runner?.close();
  }

  async #runPass(signal: AbortSignal): Promise<'rearm' | 'idle'> {
    const nextSlice = createMainThreadTimeSlice(OWED_SHARE_INVENTORY_PASS_SLICE_MS);
    const waitingGraphs = new Set<string>();
    const closedLanes = new Set<string>();
    for (const marker of this.#dependencies.list()) {
      await nextSlice();
      if (signal.aborted) return 'rearm';
      const lane = `${marker.contextGraphId}\n${marker.subGraphName ?? ''}`;
      if (closedLanes.has(lane)) continue;
      const outcome = await this.#attempt(marker, signal);
      if (outcome === 'lane-closed') closedLanes.add(lane);
      if (outcome === 'lane-closed' || outcome === 'waiting') waitingGraphs.add(marker.contextGraphId);
    }
    for (const graph of waitingGraphs) this.#scheduleSettlement(graph);
    return this.#dependencies.list().length > 0 ? 'rearm' : 'idle';
  }

  #scheduleSettlement(contextGraphId: string): void {
    this.#dependencies.requestGraphSettlement?.(contextGraphId);
  }

  /** The attempt's outcome; none when the marker is paused or the attempt failed. */
  async #attempt(
    marker: Readonly<Rfc64OwedShareInventoryV1>, signal: AbortSignal,
  ): Promise<OwedShareInventoryDrainOutcomeV1 | undefined> {
    const now = this.#dependencies.now?.() ?? Date.now();
    const failed = this.#failed.get(marker);
    if (failed !== undefined && now < failed.nextAttemptAtMs) return undefined;
    let outcome: OwedShareInventoryDrainOutcomeV1;
    try {
      outcome = await this.#dependencies.drain(marker, this.#ctx);
    } catch (error) {
      if (signal.aborted) return undefined;
      const failures = (failed?.failures ?? 0) + 1;
      const base = Math.max(this.#dependencies.retryIntervalMs(), 5_000);
      const pauseMs = Math.min(OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS, base * 2 ** Math.min(20, failures - 1));
      this.#failed.set(marker, { failures, nextAttemptAtMs: now + pauseMs });
      this.#dependencies.warn(this.#ctx, `Owed share inventory row ${markerLabel(marker)} was not written `
        + `(attempt ${failures}, next in ${Math.round(pauseMs / 1000)} s): ${message(error)}`);
      return undefined;
    }
    this.#failed.delete(marker);
    if (outcome === 'waiting' || outcome === 'lane-closed') return outcome;
    if (outcome === 'policy-mismatch') {
      this.#dependencies.warn(this.#ctx, `Owed share inventory row ${markerLabel(marker)} is dropped: `
        + 'the graph\'s catalog policy no longer takes the share');
    }
    try {
      await this.#dependencies.remove(marker);
    } catch (error) {
      // The marker stays; its next attempt finds the row and removes it again.
      this.#dependencies.warn(this.#ctx,
        `Owed share inventory marker ${markerLabel(marker)} was not removed: ${message(error)}`);
    }
    return outcome;
  }
}
