// SPDX-License-Identifier: Apache-2.0

/**
 * Writes the signed inventory rows that committed shares still owe, from their durable markers
 * (`rfc64/owed-share-inventory-store-v1.ts`).
 *
 * A pass tries each marker in turn, one at a time. A written row, a confirmed VM publication of
 * the share, a catalog policy that no longer takes the share, or a share whose seal or shared
 * copy has moved on ends the marker. A lane that is still closed, or an authority that is not
 * ready, keeps it for a later pass without a warning. A failure keeps it too, with a warning and
 * a growing pause before that marker is tried again. Passes run when the owner starts, when a
 * marker is written, when a graph's catalog authority is accepted, and, while any marker is
 * kept, on the projection supervisor's retry interval.
 */

import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';

import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from '../rfc64/catalog-runtime-v1.js';
import type { Rfc64OwedShareInventoryV1 } from '../rfc64/owed-share-inventory-store-v1.js';

/** What one attempt at an owed row found; every outcome but `waiting` ends the marker. */
export type OwedShareInventoryDrainOutcomeV1 =
  | 'written' | 'vm-confirmed' | 'policy-mismatch' | 'superseded' | 'waiting';

/** The longest pause before a marker whose attempt failed is tried again. */
export const OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS = 10 * 60_000;

export interface OwedShareInventoryOwnerDependenciesV1 {
  readonly list: () => readonly Readonly<Rfc64OwedShareInventoryV1>[];
  readonly unreadableAtOpen: () => number;
  /** One attempt, under the asset's inventory write lock; throws when it failed. */
  readonly drain: (
    marker: Readonly<Rfc64OwedShareInventoryV1>, ctx: OperationContext,
  ) => Promise<OwedShareInventoryDrainOutcomeV1>;
  /** One coalesced graph reconciliation, outside the serial marker pass. */
  readonly settleGraph?: (contextGraphId: string, ctx: OperationContext, signal: AbortSignal) => Promise<void>;
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

function markerIdentity(marker: Readonly<Rfc64OwedShareInventoryV1>): string {
  return JSON.stringify([marker.contextGraphId, marker.subGraphName, marker.authorAddress,
    marker.assertionCoordinate, marker.sealDigest, marker.shareOperationId]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The catalog runtime starts and closes it with its other workloads. */
export class Rfc64OwedShareInventoryOwnerV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #dependencies: OwedShareInventoryOwnerDependenciesV1;
  readonly #failed = new Map<string, FailedAttemptV1>();
  #runner: CoalescingRecurringTask | undefined;
  #settlementController = new AbortController();
  readonly #settlements = new Map<string, Promise<void>>();
  readonly #settleAfter = new Map<string, number>();
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
    this.#failed.clear();
    this.#settlementController = new AbortController();
    this.#settleAfter.clear();
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

  /** Drain marker attempts; graph settlement is independent and physically drained by close(). */
  async whenIdle(): Promise<void> {
    await this.#runner?.whenIdle();
  }

  async close(): Promise<void> {
    const runner = this.#runner;
    this.#runner = undefined;
    this.#settlementController.abort(new Error('Owed inventory settlement closing'));
    await runner?.close();
    await Promise.allSettled(this.#settlements.values());
  }

  async #runPass(signal: AbortSignal): Promise<'rearm' | 'idle'> {
    const markers = this.#dependencies.list();
    const kept = new Set(markers.map(markerIdentity));
    const keptGraphs = new Set(markers.map(marker => marker.contextGraphId));
    for (const identity of this.#failed.keys()) {
      if (!kept.has(identity)) this.#failed.delete(identity);
    }
    const waitingGraphs = new Set<string>();
    for (const marker of markers) {
      if (signal.aborted) return 'rearm';
      if (await this.#attempt(marker, signal)) waitingGraphs.add(marker.contextGraphId);
    }
    for (const graph of waitingGraphs) this.#scheduleSettlement(graph);
    for (const graph of this.#settleAfter.keys()) if (!keptGraphs.has(graph)) this.#settleAfter.delete(graph);
    return this.#dependencies.list().length > 0 ? 'rearm' : 'idle';
  }

  #scheduleSettlement(contextGraphId: string): void {
    const settle = this.#dependencies.settleGraph;
    const signal = this.#settlementController.signal;
    const now = this.#dependencies.now?.() ?? Date.now();
    if (!settle || signal.aborted || this.#settlements.has(contextGraphId)
      || now < (this.#settleAfter.get(contextGraphId) ?? 0)) return;
    // Explicit authority events still retry markers immediately. Graph-level
    // settlement itself gets one attempt per interval, with no nested ladder.
    this.#settleAfter.set(contextGraphId, now + Math.max(5_000, this.#dependencies.retryIntervalMs()));
    const run = Promise.resolve().then(() => { if (!signal.aborted) return settle(contextGraphId, this.#ctx, signal); })
      .catch(error => { if (!signal.aborted) this.#dependencies.warn(this.#ctx, `Owed inventory responsibility for ${contextGraphId} did not settle: ${message(error)}`); })
      .finally(() => { if (this.#settlements.get(contextGraphId) === run) this.#settlements.delete(contextGraphId); });
    this.#settlements.set(contextGraphId, run);
  }

  async #attempt(marker: Readonly<Rfc64OwedShareInventoryV1>, signal: AbortSignal): Promise<boolean> {
    const identity = markerIdentity(marker);
    const now = this.#dependencies.now?.() ?? Date.now();
    const failed = this.#failed.get(identity);
    if (failed !== undefined && now < failed.nextAttemptAtMs) return false;
    let outcome: OwedShareInventoryDrainOutcomeV1;
    try {
      outcome = await this.#dependencies.drain(marker, this.#ctx);
    } catch (error) {
      if (signal.aborted) return false;
      const failures = (failed?.failures ?? 0) + 1;
      const base = Math.max(this.#dependencies.retryIntervalMs(), 5_000);
      const pauseMs = Math.min(OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS, base * 2 ** Math.min(20, failures - 1));
      this.#failed.set(identity, { failures, nextAttemptAtMs: now + pauseMs });
      this.#dependencies.warn(this.#ctx, `Owed share inventory row ${markerLabel(marker)} was not written `
        + `(attempt ${failures}, next in ${Math.round(pauseMs / 1000)} s): ${message(error)}`);
      return false;
    }
    this.#failed.delete(identity);
    if (outcome === 'waiting') return true;
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
    return false;
  }
}
