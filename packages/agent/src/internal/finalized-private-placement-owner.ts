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
  failureHistoryRead: boolean;
  attempts: number;
}
interface ResetPlan {
  readonly repair: Rfc64FinalizedPrivatePlacementRepairV1;
  readonly state: PrivatePlacementFailureStateV1 | null;
}
interface GraphLane {
  readonly id: ContextGraphIdV1;
  readonly entries: Set<RetryEntry>;
  active: boolean | undefined;
  resetPending: boolean;
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
  readonly #lanes = new Map<string, GraphLane>();
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
    const lane = this.#lanes.get(contextGraphId);
    if (!lane) return;
    try {
      if (!this.#dependencies.acceptsFinalizedPrivateLane(lane.id)) this.#transitionLane(lane.id, false);
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
      try { this.#transitionLane(repair.contextGraphId, false); }
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
    const resets: ResetPlan[] = [];
    for (const repair of this.#dependencies.listFinalizedPrivateRepairs()) {
      const reset = this.#prepareReset(repair);
      if (reset.state) resets.push(reset);
    }
    if (!resets.length) return 0;
    this.#commitResets(resets);
    this.#runner.requestNextTurn();
    return resets.length;
  }

  async close(): Promise<void> {
    clearTimeout(this.#waiterTimer);
    this.#waiterTimer = undefined;
    await this.#runner.close();
    this.#waiters.releaseAll();
    this.#retries.clear();
    this.#lanes.clear();
  }

  #entry(repair: Rfc64FinalizedPrivatePlacementRepairV1): RetryEntry {
    const key = finalizedPrivateRepairKeyV1(repair);
    let entry = this.#retries.get(key);
    if (!entry) {
      entry = { repair, retry: new FinalizedPrivateRepairRetryV1(), failureHistoryRead: false, attempts: 0 };
      this.#restoreFailureHistory(entry);
      this.#retries.set(key, entry);
      let lane = this.#lanes.get(repair.contextGraphId);
      if (!lane) {
        lane = { id: repair.contextGraphId, entries: new Set(), active: undefined, resetPending: false };
        this.#lanes.set(repair.contextGraphId, lane);
      }
      lane.entries.add(entry);
    }
    return entry;
  }

  #forget(key: string): void {
    const entry = this.#retries.get(key);
    if (!entry) return;
    this.#retries.delete(key);
    const lane = this.#lanes.get(entry.repair.contextGraphId)!;
    lane.entries.delete(entry);
    if (!lane.entries.size) this.#lanes.delete(lane.id);
  }

  #transitionLane(contextGraphId: ContextGraphIdV1, active: boolean): boolean {
    const lane = this.#lanes.get(contextGraphId);
    if (!lane) return false;
    if (lane.active === undefined) { lane.active = active; return false; }
    // A failed write cannot consume the observed edge, even if the lane returns
    // to its committed state before storage recovers.
    lane.resetPending ||= lane.active !== active;
    if (!lane.resetPending) return false;
    const resets = [...lane.entries].map(entry => this.#prepareReset(entry.repair));
    this.#commitResets(resets);
    lane.active = active;
    lane.resetPending = false;
    return true;
  }

  /** Unread evidence is not absence; a reset must resolve it before consuming its edge. */
  #prepareReset(repair: Rfc64FinalizedPrivatePlacementRepairV1): ResetPlan {
    const entry = this.#retries.get(finalizedPrivateRepairKeyV1(repair));
    const previous = entry?.failureHistoryRead ? entry.retry.snapshot()
      : this.#dependencies.readPrivateFailure(repair) ?? entry?.retry.snapshot();
    return { repair, state: previous ? resetPrivatePlacementFailureStateV1(previous) : null };
  }

  #restoreFailureHistory(entry: RetryEntry): boolean {
    if (entry.failureHistoryRead) return true;
    try {
      entry.retry.restore(this.#dependencies.readPrivateFailure(entry.repair), Date.now());
      entry.failureHistoryRead = true;
      return true;
    } catch { return false; } // Unread hints cannot park owed work or authorize overwriting old evidence.
  }

  /** Persist the prepared evidence before fencing any loaded scheduling generation. */
  #commitResets(resets: readonly ResetPlan[]): void {
    const writes = resets.filter((reset): reset is Rfc64PrivatePlacementFailureWriteV1 => reset.state !== null);
    if (writes.length) this.#dependencies.writePrivateFailures(writes);
    // Lane resets also fence loaded entries that have not recorded a failure yet.
    for (const { repair, state } of resets) {
      const entry = this.#retries.get(finalizedPrivateRepairKeyV1(repair));
      if (entry) { entry.retry.retryNow(state); entry.failureHistoryRead = true; }
    }
  }

  #observeLane(contextGraphId: ContextGraphIdV1): boolean {
    let active: boolean;
    try { active = this.#dependencies.acceptsFinalizedPrivateLane(contextGraphId); }
    catch (error) {
      // An uncertain lane cannot authorize admission or let an old completion
      // overwrite the still-uncommitted reset obligation.
      if (this.#lanes.get(contextGraphId)?.resetPending) throw error;
      return false;
    }
    return this.#transitionLane(contextGraphId, active);
  }

  async #runPass(signal: AbortSignal): Promise<void> {
    const repairs = this.#dependencies.listFinalizedPrivateRepairs();
    const currentKeys = new Set(repairs.map(finalizedPrivateRepairKeyV1));
    const timing = this.#options.timing();
    timing.passStarted(currentKeys);
    // Establish every queued sibling before the first awaited placement. A lane
    // notification during that attempt must also reset later parked siblings.
    for (const repair of repairs) this.#entry(repair);
    for (const key of this.#retries.keys()) if (!currentKeys.has(key)) this.#forget(key);
    for (const key of this.#waiters.keys()) if (!currentKeys.has(key)) this.#waiters.release(key);
    this.#options.fullCatalogs.passStarted(currentKeys);
    const blockedGraphs = new Set<ContextGraphIdV1>();
    const observeLane = (contextGraphId: ContextGraphIdV1, inFlightKey?: string): boolean | undefined => {
      if (blockedGraphs.has(contextGraphId)) return undefined;
      try { return this.#observeLane(contextGraphId); }
      catch (error) {
        blockedGraphs.add(contextGraphId);
        // Settle earlier cooldown waiters and later siblings too. Keeping a due
        // waiter would reschedule a failing graph immediately without backoff.
        for (const sibling of this.#lanes.get(contextGraphId)?.entries ?? []) {
          const key = finalizedPrivateRepairKeyV1(sibling.repair);
          if (key !== inFlightKey) this.#waiters.release(key);
        }
        this.#warn('catalog_private_repair_lane_reset_failed', error);
        return undefined;
      }
    };
    await mapWithConcurrency(repairs, 1, async repair => {
      if (signal.aborted) return;
      const key = finalizedPrivateRepairKeyV1(repair);
      const entry = this.#entry(repair);
      if (observeLane(repair.contextGraphId) === undefined) return;
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
        this.#forget(key);
      } catch (error) {
        placement.end('failed');
        if (!signal.aborted) {
          const laneChanged = observeLane(repair.contextGraphId, key);
          if (laneChanged === undefined) return;
          if (laneChanged) this.#runner.request();
          if (attemptGeneration !== entry.retry.generation) return;
          const historyRead = this.#restoreFailureHistory(entry);
          const capacityOwned = this.#options.fullCatalogs.placementRefused(key, repair, error);
          const recorded = capacityOwned
            ? entry.retry.recordCapacityFailure(attemptGeneration, Date.now())
            : entry.retry.fail(attemptGeneration, Date.now(), this.#options.retryIntervalMs, catalogRepairDiagnosticV1(error).kind);
          if (recorded) {
            try {
              if (!historyRead) throw new Error('Private placement failure history is unread');
              this.#dependencies.writePrivateFailures([{ repair, state: entry.retry.snapshot()! }]);
            }
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
