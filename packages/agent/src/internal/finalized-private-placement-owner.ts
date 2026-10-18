// SPDX-License-Identifier: Apache-2.0
import { createOperationContext, type ContextGraphIdV1, type OperationContext } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import { mapWithConcurrency } from '../map-with-concurrency.js';
import { CatalogRepairConditionErrorV1, CatalogRepairLaneInactiveErrorV1, catalogRepairDiagnosticV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1, Rfc64PrivatePlacementFailureWriteV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { resetPrivatePlacementFailureStateV1, summarizePrivatePlacementFailuresV1, type PrivatePlacementFailureStateV1 } from '../rfc64/private-placement-failure-state-v1.js';
import { FinalizedPrivateRepairRetryV1 } from './finalized-private-repair-retry.js';
import { finalizedPrivateRepairKeyV1 } from './finalized-private-placement-key.js';
import type { CatalogPlacementTimingV1, CatalogPlacementAttemptV1, CatalogPlacementWaiterObserverV1, FinalizedPrivatePlacementQueueStatusV1 } from './catalog-placement-timing.js';
import type { FullCatalogParkingV1 } from './full-catalog-parking.js';
import { FinalizedPrivatePlacementWaitersV1 } from './finalized-private-placement-waiters.js';
import { NextTurnRecurringTaskV1 } from './next-turn-recurring-task.js';

interface RetryEntry {
  readonly repair: Rfc64FinalizedPrivatePlacementRepairV1;
  readonly retry: FinalizedPrivateRepairRetryV1;
  attempts: number;
}
interface Dependencies {
  listFinalizedPrivateRepairs(): readonly Rfc64FinalizedPrivatePlacementRepairV1[];
  acceptsFinalizedPrivateLane(graph: ContextGraphIdV1): boolean;
  repairFinalizedPrivatePlacement(repair: Rfc64FinalizedPrivatePlacementRepairV1, placement: CatalogPlacementAttemptV1): Promise<void>;
  readPrivateFailure(repair: Rfc64FinalizedPrivatePlacementRepairV1): PrivatePlacementFailureStateV1 | null;
  writePrivateFailures(entries: readonly Rfc64PrivatePlacementFailureWriteV1[]): void;
  warn(ctx: OperationContext, message: string): void;
}
interface Options {
  readonly retryIntervalMs: number;
  readonly timing: () => CatalogPlacementTimingV1;
  readonly fullCatalogs: FullCatalogParkingV1;
  readonly ctx: OperationContext;
}
export interface Rfc64FinalizedPrivatePlacementRepairRequestV1 {
  readonly accepted: boolean;
  /** Settles after this exact repair's first admitted attempt; publication never waits on it. */
  readonly whenAttempted: Promise<void>;
}

/** Owns private repair evidence, scheduling, persistence ordering and waiter lifetime. */
export class FinalizedPrivatePlacementOwnerV1 {
  readonly #dependencies: Dependencies;
  readonly #options: Options;
  readonly #retries = new Map<string, RetryEntry>();
  readonly #waiters = new FinalizedPrivatePlacementWaitersV1();
  readonly #runner: NextTurnRecurringTaskV1;
  #waiterTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dependencies: Dependencies, options: Options) {
    this.#dependencies = dependencies;
    this.#options = options;
    this.#runner = new NextTurnRecurringTaskV1(new CoalescingRecurringTask({
      retryIntervalMs: options.retryIntervalMs,
      runPass: async signal => {
        let failed = false;
        try { await this.#runPass(signal); }
        catch (error) { failed = true; throw error; }
        finally {
          options.timing().passEnded();
          options.fullCatalogs.passEnded();
          // Failed queue reads must not spin on an already-due waiter.
          this.#scheduleWaiterWake(failed ? (options.retryIntervalMs > 0 ? options.retryIntervalMs : 5_000) : 0);
        }
      },
      onError: error => this.#warn('catalog_private_repair_pass_failed', error),
      closingMessage: 'RFC-64 finalized-private placement repair closing',
    }));
  }

  get running(): boolean { return this.#runner.running; }
  get closed(): boolean { return this.#runner.closed; }
  requestPass(): boolean { return this.#runner.request(); }
  whenIdle(): Promise<void> { return this.#runner.whenIdle(); }

  /** Observe an inactive edge without admitting a placement. */
  observeLaneAvailability(contextGraphId: string): void {
    if (this.closed) return;
    const entries = [...this.#retries.values()].filter(entry => entry.repair.contextGraphId === contextGraphId);
    if (!entries.length) return;
    try {
      if (!this.#dependencies.acceptsFinalizedPrivateLane(entries[0].repair.contextGraphId)) {
        this.#transitionLane(entries, false);
      }
    } catch (error) { this.#warn('catalog_private_repair_lane_reset_failed', error); }
  }

  request(repair: Rfc64FinalizedPrivatePlacementRepairV1, observer?: CatalogPlacementWaiterObserverV1): Rfc64FinalizedPrivatePlacementRepairRequestV1 {
    const key = finalizedPrivateRepairKeyV1(repair);
    this.#options.timing().owed(key);
    const rejected = (): Rfc64FinalizedPrivatePlacementRepairRequestV1 => {
      try { observer?.released(); } catch { /* Observation cannot prevent waiter settlement. */ }
      return Object.freeze({ accepted: false, whenAttempted: Promise.resolve() });
    };
    if (this.closed) return rejected();
    let laneAccepts = false;
    try { laneAccepts = this.#dependencies.acceptsFinalizedPrivateLane(repair.contextGraphId); }
    finally {
      // A refused durable marker still needs a bounded liveness pass.
      if (!laneAccepts && this.#options.retryIntervalMs > 0) this.#runner.schedule(this.#options.retryIntervalMs);
    }
    if (!laneAccepts) {
      try { this.#transitionLane([...this.#retries.values()].filter(entry =>
        entry.repair.contextGraphId === repair.contextGraphId), false); }
      catch (error) { this.#warn('catalog_private_repair_lane_reset_failed', error); }
      return rejected();
    }
    const waiter = this.#waiters.add(key, this.#options.timing().now(), observer);
    // Keep durable queue listing and repair work off the caller's stack.
    if (!this.#runner.requestNextTurn()) { waiter.withdraw(); return rejected(); }
    return Object.freeze({ accepted: true, whenAttempted: waiter.whenAttempted });
  }

  status(): Readonly<FinalizedPrivatePlacementQueueStatusV1> {
    return Object.freeze({ ...this.#options.timing().queueStatus(this.#waiters.summary(), this.running),
      failures: summarizePrivatePlacementFailuresV1([...this.#retries.values()].map(entry => entry.retry.snapshot())) });
  }

  /** Commit every reset before changing memory, generations or wakeups. */
  retryFailed(): number {
    if (this.closed) throw new Error('Private placement owner is closed');
    const resets: Rfc64PrivatePlacementFailureWriteV1[] = [];
    for (const repair of this.#dependencies.listFinalizedPrivateRepairs()) {
      const previous = this.#retries.get(finalizedPrivateRepairKeyV1(repair))?.retry.snapshot()
        ?? this.#dependencies.readPrivateFailure(repair);
      if (previous) resets.push({ repair, state: resetPrivatePlacementFailureStateV1(previous) });
    }
    if (!resets.length) return 0;
    this.#dependencies.writePrivateFailures(resets);
    for (const { repair, state } of resets) this.#retries.get(finalizedPrivateRepairKeyV1(repair))?.retry.retryNow(state);
    this.#runner.requestNextTurn();
    return resets.length;
  }

  async close(): Promise<void> {
    clearTimeout(this.#waiterTimer);
    this.#waiterTimer = undefined;
    await this.#runner.close();
    this.#waiters.releaseAll();
    this.#retries.clear();
  }

  #entry(repair: Rfc64FinalizedPrivatePlacementRepairV1): RetryEntry {
    const key = finalizedPrivateRepairKeyV1(repair);
    let entry = this.#retries.get(key);
    if (!entry) {
      entry = { repair, retry: new FinalizedPrivateRepairRetryV1(), attempts: 0 };
      try { entry.retry.restore(this.#dependencies.readPrivateFailure(repair), Date.now()); }
      catch { /* Unavailable hints cannot park owed work. */ }
      this.#retries.set(key, entry);
    }
    return entry;
  }

  #transitionLane(entries: readonly RetryEntry[], active: boolean): boolean {
    const changed = entries.filter(entry => entry.retry.laneChanged(active));
    const resets = changed.flatMap(entry => {
      const previous = entry.retry.snapshot();
      return previous ? [{ repair: entry.repair, state: resetPrivatePlacementFailureStateV1(previous) }] : [];
    });
    if (resets.length) this.#dependencies.writePrivateFailures(resets);
    // Failed persistence leaves the old lane observation intact for the next pass.
    const byKey = new Map(resets.map(({ repair, state }) => [finalizedPrivateRepairKeyV1(repair), state]));
    for (const entry of entries) entry.retry.observeLane(active, byKey.get(finalizedPrivateRepairKeyV1(entry.repair)) ?? null);
    return changed.length > 0;
  }

  #observeLane(entry: RetryEntry): boolean {
    let active: boolean;
    try { active = this.#dependencies.acceptsFinalizedPrivateLane(entry.repair.contextGraphId); }
    catch { return false; }
    if (!entry.retry.laneChanged(active)) return entry.retry.observeLane(active);
    // Only an actual edge scans siblings; ordinary admission stays linear in the queue.
    // The lane belongs to the graph, so all loaded markers cross the same durable boundary.
    return this.#transitionLane([...this.#retries.values()].filter(candidate =>
      candidate.repair.contextGraphId === entry.repair.contextGraphId), active);
  }

  async #runPass(signal: AbortSignal): Promise<void> {
    const repairs = this.#dependencies.listFinalizedPrivateRepairs();
    const currentKeys = new Set(repairs.map(finalizedPrivateRepairKeyV1));
    const timing = this.#options.timing();
    timing.passStarted(currentKeys);
    for (const key of this.#retries.keys()) if (!currentKeys.has(key)) this.#retries.delete(key);
    for (const key of this.#waiters.keys()) if (!currentKeys.has(key)) this.#waiters.release(key);
    this.#options.fullCatalogs.passStarted(currentKeys);
    await mapWithConcurrency(repairs, 1, async repair => {
      if (signal.aborted) return;
      const key = finalizedPrivateRepairKeyV1(repair);
      const entry = this.#entry(repair);
      this.#observeLane(entry);
      // Capacity still owns admission and wakeups, even after a durable scheduling reset.
      if (this.#options.fullCatalogs.park(key, repair)) return this.#waiters.release(key);
      if (entry.retry.parked) { this.#waiters.release(key); return; }
      if (!entry.retry.eligible(Date.now())) {
        timing.cooldownSkipped(); this.#waiters.cooldownSkipped(key); return;
      }
      const attemptGeneration = entry.retry.generation;
      entry.attempts += 1;
      const placement = timing.admit(key);
      try {
        if (!this.#dependencies.acceptsFinalizedPrivateLane(repair.contextGraphId)) throw new CatalogRepairLaneInactiveErrorV1();
        await withDefaultStoreWorkPriority('background', () => this.#dependencies.repairFinalizedPrivatePlacement(repair, placement.attempt));
        placement.end('completed');
        this.#retries.delete(key);
      } catch (error) {
        placement.end('failed');
        if (!signal.aborted) {
          if (this.#observeLane(entry)) this.#runner.request();
          if (attemptGeneration !== entry.retry.generation) return;
          const capacityOwned = this.#options.fullCatalogs.placementRefused(key, repair, error);
          const recorded = capacityOwned
            ? entry.retry.recordCapacityFailure(attemptGeneration, Date.now())
            : entry.retry.fail(attemptGeneration, Date.now(), this.#options.retryIntervalMs, catalogRepairDiagnosticV1(error).kind);
          if (recorded) {
            try { this.#dependencies.writePrivateFailures([{ repair, state: entry.retry.snapshot() }]); }
            catch { this.#warnFailure(new CatalogRepairConditionErrorV1('persistence_unavailable',
              'Private placement failure history could not persist; owed work is retained'), entry); }
          }
          if (!capacityOwned) this.#warnFailure(error, entry);
        }
      } finally { this.#waiters.release(key, placement); }
    });
  }

  #scheduleWaiterWake(minimumDelayMs: number): void {
    clearTimeout(this.#waiterTimer); this.#waiterTimer = undefined;
    if (this.closed) return;
    let earliest = Infinity;
    for (const key of this.#waiters.keys()) earliest = Math.min(earliest, this.#retries.get(key)?.retry.nextAttemptAtMs ?? Date.now());
    if (!Number.isFinite(earliest)) return;
    this.#waiterTimer = setTimeout(() => {
      this.#waiterTimer = undefined;
      if (!this.closed) this.#runner.request();
    }, Math.min(2_147_483_647, Math.max(minimumDelayMs, earliest - Date.now())));
    this.#waiterTimer.unref?.();
  }

  #warn(event: string, error: unknown): void {
    try { this.#dependencies.warn(this.#options.ctx, JSON.stringify({ event, diagnostic: catalogRepairDiagnosticV1(error) })); }
    catch { /* Diagnostics cannot alter lifecycle behavior. */ }
  }

  #warnFailure(error: unknown, entry: RetryEntry): void {
    try { this.#dependencies.warn(createOperationContext('system'), JSON.stringify({ event: 'catalog_private_repair_failed',
      diagnostic: catalogRepairDiagnosticV1(error), attempt: entry.attempts,
      consecutiveFailures: entry.retry.consecutiveFailures, nextAttemptAtMs: entry.retry.nextAttemptAtMs })); }
    catch { /* Diagnostics cannot alter repair state or waiter settlement. */ }
  }
}
