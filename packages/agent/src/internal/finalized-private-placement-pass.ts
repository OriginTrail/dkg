// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphIdV1 } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { mapWithConcurrency } from '../map-with-concurrency.js';
import { CatalogRepairConditionErrorV1, CatalogRepairLaneInactiveErrorV1, catalogRepairDiagnosticV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { FinalizedPrivateRepairRetryV1 } from './finalized-private-repair-retry.js';
import type { PrivatePlacementFailureStateV1 } from '../rfc64/private-placement-failure-state-v1.js';
import { finalizedPrivateRepairKeyV1 } from './finalized-private-placement-key.js';
import type { CatalogPlacementTimingV1, CatalogPlacementAttemptV1 } from './catalog-placement-timing.js';
import type { FullCatalogParkingV1 } from './full-catalog-parking.js';
import type { FinalizedPrivatePlacementWaitersV1 } from './finalized-private-placement-waiters.js';
import type { NextTurnRecurringTaskV1 } from './next-turn-recurring-task.js';
export interface PrivateRetryEntryV1 {
  readonly contextGraphId: ContextGraphIdV1;
  retry: FinalizedPrivateRepairRetryV1;
  attempts: number;
}
interface State {
  readonly retryIntervalMs?: number;
  readonly finalizedPrivateRetries: Map<string, PrivateRetryEntryV1>;
  readonly finalizedPrivateWaiters: FinalizedPrivatePlacementWaitersV1;
  readonly finalizedPrivateRunner: NextTurnRecurringTaskV1;
}
interface Host {
  list(): readonly Rfc64FinalizedPrivatePlacementRepairV1[];
  timing: CatalogPlacementTimingV1;
  fullCatalogs: FullCatalogParkingV1;
  observeLane(retry: FinalizedPrivateRepairRetryV1, graph: ContextGraphIdV1): boolean;
  acceptsLane(graph: ContextGraphIdV1): boolean;
  repair(repair: Rfc64FinalizedPrivatePlacementRepairV1, placement: CatalogPlacementAttemptV1): Promise<void>;
  warn(error: unknown, attempts: number, retry: FinalizedPrivateRepairRetryV1): void;
  readFailure(repair: Rfc64FinalizedPrivatePlacementRepairV1): PrivatePlacementFailureStateV1 | null;
  writeFailure(repair: Rfc64FinalizedPrivatePlacementRepairV1, state: PrivatePlacementFailureStateV1 | null): void;
}

export async function runFinalizedPrivatePlacementPass(state: State, signal: AbortSignal, host: Host): Promise<void> {
    const repairs = host.list();
    const currentKeys = new Set(repairs.map(finalizedPrivateRepairKeyV1));
    host.timing.passStarted(currentKeys);
    for (const key of state.finalizedPrivateRetries.keys()) {
      if (!currentKeys.has(key)) state.finalizedPrivateRetries.delete(key);
    }
    for (const key of state.finalizedPrivateWaiters.keys()) {
      if (!currentKeys.has(key)) state.finalizedPrivateWaiters.release(key);
    }
    host.fullCatalogs.passStarted(currentKeys);
    await mapWithConcurrency(repairs, 1, async (repair) => {
      if (signal.aborted) return;
      const key = finalizedPrivateRepairKeyV1(repair);
      let entry = state.finalizedPrivateRetries.get(key);
      if (entry === undefined) {
        entry = { contextGraphId: repair.contextGraphId, retry: new FinalizedPrivateRepairRetryV1(), attempts: 0 };
        try { entry.retry.restore(host.readFailure(repair), Date.now()); } catch { /* Hints cannot park work when unavailable. */ }
        state.finalizedPrivateRetries.set(key, entry);
      }
      // Restore evidence even for capacity-parked markers; capacity owns their wakeups.
      if (host.fullCatalogs.park(key, repair)) return state.finalizedPrivateWaiters.release(key);
      host.observeLane(entry.retry, repair.contextGraphId);
      if (entry.retry.parked) { state.finalizedPrivateWaiters.release(key); return; }
      if (!entry.retry.eligible(Date.now())) {
        host.timing.cooldownSkipped();
        state.finalizedPrivateWaiters.cooldownSkipped(key);
        return;
      }
      const attemptGeneration = entry.retry.generation;
      entry.attempts += 1;
      const placement = host.timing.admit(key);
      try {
        if (!host.acceptsLane(repair.contextGraphId)) {
          throw new CatalogRepairLaneInactiveErrorV1();
        }
        await withDefaultStoreWorkPriority('background', () => (
          host.repair(repair, placement.attempt)
        ));
        placement.end('completed');
        state.finalizedPrivateRetries.delete(key);
      } catch (error) {
        placement.end('failed');
        if (!signal.aborted) {
          const changed = host.observeLane(entry.retry, repair.contextGraphId);
          if (changed) state.finalizedPrivateRunner.request();
          // Fence every failure mutation, including capacity parking, against an
          // operator retry or lane transition while this attempt was in flight.
          if (attemptGeneration !== entry.retry.generation) return;
          const capacityOwned = host.fullCatalogs.placementRefused(key, repair, error);
          const recorded = capacityOwned
            ? entry.retry.recordCapacityFailure(attemptGeneration, Date.now())
            : entry.retry.fail(attemptGeneration, Date.now(), state.retryIntervalMs, catalogRepairDiagnosticV1(error).kind);
          if (recorded) {
            try { host.writeFailure(repair, entry.retry.snapshot()); }
            catch {
              host.warn(new CatalogRepairConditionErrorV1('persistence_unavailable',
                'Private placement failure history could not persist; owed work is retained'), entry.attempts, entry.retry);
            }
          }
          if (!capacityOwned) host.warn(error, entry.attempts, entry.retry);
        }
      } finally {
        state.finalizedPrivateWaiters.release(key, placement);
      }
    });
}
